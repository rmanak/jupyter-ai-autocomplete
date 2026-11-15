"""LLM backends for inline completion.

Each backend is an async generator that takes a :class:`CompletionRequest` and
yields text chunks. They always stream from the upstream server, even though
the frontend gets a single response. If the frontend goes away, the handler
cancels the task, the upstream HTTP connection closes, and llama.cpp/vLLM stop
generating, which frees the slot.

Backends:
  infill       llama.cpp native ``/infill``. The server applies the model's FIM tokens.
  completions  OpenAI ``/v1/completions`` with a raw FIM prompt (vLLM, llama.cpp,
               LM Studio, TGI...). The template is picked from the model name.
  ollama       Ollama native ``/api/generate`` with ``raw: true`` and a FIM prompt.
               Ollama's ``/v1/completions`` puts the prompt through the model's chat
               renderer (you get "```python" back), and ``suffix`` is rejected for
               many models, so raw mode is the only reliable FIM path.
  chat         OpenAI ``/v1/chat/completions`` with a fill-the-hole prompt, for
               chat-only models. Slower and less precise; use it as a fallback.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import AsyncIterator
from urllib.parse import urlparse

import httpx

from . import templates

DEFAULT_BASE_URL = os.environ.get("JUPYTER_AUTOCOMP_BASE_URL", "http://localhost:8080")
API_KEY = os.environ.get("JUPYTER_AUTOCOMP_API_KEY", "")

# Generic stops that make sense for notebook code no matter which model runs.
# Cell markers ("# %%") are NOT a server-side stop: models often *open* with one,
# and the frontend drops a leading marker and cuts at any later one.
COMMON_STOPS = ["```", "<|endoftext|>", "<|file_sep|>", "<|fim_prefix|>",
                "<|fim_suffix|>", "<|fim_middle|>", "<|im_end|>"]
# OpenAI caps `stop` at 4 entries; llama.cpp/vLLM accept more.
OPENAI_HOSTS = {"api.openai.com"}


class BackendError(RuntimeError):
    pass


@dataclass
class CompletionRequest:
    prefix: str
    suffix: str = ""
    backend: str = "infill"
    base_url: str = ""
    model: str = ""
    template: str = "auto"
    max_tokens: int = 128
    temperature: float = 0.01
    multiline: bool = True
    stop: list[str] = field(default_factory=list)
    extra: list[dict] = field(default_factory=list)  # [{"filename":..., "text":...}]
    timeout_ms: int = 4000

    @classmethod
    def from_json(cls, d: dict) -> "CompletionRequest":
        known = {k: d[k] for k in cls.__dataclass_fields__ if k in d and d[k] is not None}
        req = cls(**known)
        if not req.base_url:
            req.base_url = DEFAULT_BASE_URL
        return req

    def stops(self, extra: tuple[str, ...] = ()) -> list[str]:
        s = list(dict.fromkeys([*COMMON_STOPS, *extra, *self.stop]))
        if not self.multiline:
            s.append("\n")
        return s


def _root(base_url: str) -> str:
    """Strip a trailing ``/v1``: llama.cpp's ``/infill`` lives at the server root."""
    u = base_url.rstrip("/")
    return u[:-3] if u.endswith("/v1") else u


def _v1(base_url: str) -> str:
    """OpenAI-style API root. A bare host gets ``/v1`` appended; a URL with an
    explicit path (``.../v1``, ``https://openrouter.ai/api/v1``) is used as-is."""
    u = base_url.rstrip("/")
    return u + "/v1" if not urlparse(u).path else u


def _is_openai(base_url: str) -> bool:
    return (urlparse(base_url).hostname or "") in OPENAI_HOSTS


def _headers() -> dict:
    h = {"Content-Type": "application/json"}
    if API_KEY:
        h["Authorization"] = f"Bearer {API_KEY}"
    return h


async def _sse(resp: httpx.Response) -> AsyncIterator[dict]:
    async for line in resp.aiter_lines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            return
        try:
            yield json.loads(data)
        except json.JSONDecodeError:
            continue


async def _check(resp: httpx.Response, what: str) -> None:
    if resp.status_code != 200:
        text = (await resp.aread()).decode(errors="replace")[:500]
        raise BackendError(f"{what} returned HTTP {resp.status_code}: {text}")


_model_cache: dict[str, str] = {}


async def resolve_model(req: CompletionRequest, client: httpx.AsyncClient) -> str:
    """Use the configured model, or else the first one the server lists (cached per URL)."""
    if req.model:
        return req.model
    base = _v1(req.base_url)
    if base not in _model_cache:
        try:
            r = await client.get(base + "/models", headers=_headers(), timeout=3.0)
            data = r.json().get("data") or []
            _model_cache[base] = data[0]["id"] if data else ""
        except (httpx.HTTPError, ValueError, KeyError, IndexError):
            _model_cache[base] = ""
    if not _model_cache[base]:
        raise BackendError(f"No model configured and none listed at {base}/models; "
                           "set 'Model' in the provider settings")
    req.model = _model_cache[base]  # reported back to the UI
    return req.model


async def stream_infill(req: CompletionRequest, client: httpx.AsyncClient) -> AsyncIterator[str]:
    try:
        await resolve_model(req, client)  # only for display; llama.cpp serves one model
    except BackendError:
        pass
    body = {
        "input_prefix": req.prefix,
        "input_suffix": req.suffix,
        "input_extra": req.extra,
        "prompt": "",
        "n_predict": req.max_tokens,
        "temperature": req.temperature,
        "top_k": 40,
        "top_p": 0.95,
        "stop": req.stops(),
        "stream": True,
        "cache_prompt": True,
        # llama.cpp FIM-specific: cap generation time for long completions
        "t_max_predict_ms": req.timeout_ms,
    }
    if req.model:
        body["model"] = req.model
    async with client.stream("POST", _root(req.base_url) + "/infill", json=body,
                             headers=_headers()) as resp:
        await _check(resp, "/infill")
        async for ev in _sse(resp):
            chunk = ev.get("content", "")
            if chunk:
                yield chunk
            if ev.get("stop"):
                return


async def stream_completions(req: CompletionRequest, client: httpx.AsyncClient) -> AsyncIterator[str]:
    model = await resolve_model(req, client)
    try:
        tpl = templates.resolve_template(req.template, model)
    except ValueError as e:
        raise BackendError(str(e))
    body = {
        "model": model,
        "prompt": tpl.render(req.prefix, req.suffix),
        "max_tokens": req.max_tokens,
        "temperature": req.temperature,
        "top_p": 0.95,
        "stop": req.stops(tpl.stop),
        "stream": True,
        # No server-specific fields: llama.cpp caches prompts by default and vLLM
        # does automatic prefix caching, so consecutive keystrokes reuse the KV cache.
    }
    if _is_openai(req.base_url):
        body["stop"] = body["stop"][:4]
    async with client.stream("POST", _v1(req.base_url) + "/completions", json=body,
                             headers=_headers()) as resp:
        await _check(resp, "/v1/completions")
        async for ev in _sse(resp):
            for choice in ev.get("choices") or []:
                chunk = choice.get("text") or ""
                if chunk:
                    yield chunk


async def stream_ollama(req: CompletionRequest, client: httpx.AsyncClient) -> AsyncIterator[str]:
    model = await resolve_model(req, client)
    try:
        tpl = templates.resolve_template(req.template, model)
    except ValueError as e:
        raise BackendError(str(e))
    body = {
        "model": model,
        "prompt": tpl.render(req.prefix, req.suffix),
        "raw": True,  # bypass the chat template/renderer
        "stream": True,
        "options": {
            "temperature": req.temperature,
            "top_p": 0.95,
            "num_predict": req.max_tokens,
            "stop": req.stops(tpl.stop),
        },
    }
    async with client.stream("POST", _root(req.base_url) + "/api/generate", json=body,
                             headers=_headers()) as resp:
        await _check(resp, "/api/generate")
        async for line in resp.aiter_lines():  # NDJSON
            if not line.strip():
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("error"):
                raise BackendError(f"ollama: {ev['error']}")
            if ev.get("response"):
                yield ev["response"]
            if ev.get("done"):
                return


async def stream_chat(req: CompletionRequest, client: httpx.AsyncClient) -> AsyncIterator[str]:
    """Chat fallback. It buffers the response because the answer is wrapped in tags."""
    model = await resolve_model(req, client)
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": templates.CHAT_SYSTEM},
            {"role": "user", "content": templates.chat_user_message(
                req.prefix, req.suffix, req.multiline)},
        ],
        "max_tokens": req.max_tokens + 16,  # room for the tags
        "temperature": req.temperature,
        "stop": ["</COMPLETION>"],
        "stream": True,
    }
    if not _is_openai(req.base_url):
        # llama.cpp / vLLM / Ollama: turn off reasoning for Qwen3-style hybrid models.
        body["chat_template_kwargs"] = {"enable_thinking": False}
    parts: list[str] = []
    async with client.stream("POST", _v1(req.base_url) + "/chat/completions", json=body,
                             headers=_headers()) as resp:
        await _check(resp, "/v1/chat/completions")
        async for ev in _sse(resp):
            for choice in ev.get("choices") or []:
                parts.append((choice.get("delta") or {}).get("content") or "")
    text = templates.extract_completion("".join(parts))
    # Chat models like to put the answer on a new line after the opening tag.
    # Drop that newline when the cursor is at a line start or we only want one line.
    if req.prefix.endswith("\n") or not req.multiline:
        text = text.lstrip("\n")
    if not req.multiline:
        text = text.split("\n", 1)[0]
    if text:
        yield text


BACKENDS = {
    "infill": stream_infill,
    "completions": stream_completions,
    "ollama": stream_ollama,
    "chat": stream_chat,
}


def get_backend(name: str):
    try:
        return BACKENDS[name]
    except KeyError:
        raise BackendError(f"Unknown backend {name!r}; available: {sorted(BACKENDS)}")
