"""LLM backends for inline completion.

Each backend takes a :class:`CompletionRequest` and yields text chunks. They
always stream from the upstream server, even when the frontend wants a single
response. If the frontend goes away, the handler cancels the task, the
upstream HTTP connection closes, and llama.cpp/vLLM stop generating, which
frees the slot.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import AsyncIterator

import httpx

DEFAULT_BASE_URL = os.environ.get("JUPYTER_AUTOCOMP_BASE_URL", "http://localhost:8080")
API_KEY = os.environ.get("JUPYTER_AUTOCOMP_API_KEY", "")

# Generic stops that make sense for notebook code no matter which model runs.
COMMON_STOPS = ["\n# %%", "```", "<|endoftext|>", "<|file_sep|>", "<|fim_prefix|>",
                "<|fim_suffix|>", "<|fim_middle|>", "<|im_end|>"]


@dataclass
class CompletionRequest:
    prefix: str
    suffix: str = ""
    backend: str = "infill"
    base_url: str = ""
    model: str = ""
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

    @property
    def stops(self) -> list[str]:
        s = list(COMMON_STOPS) + list(self.stop)
        if not self.multiline:
            s.append("\n")
        return s


def _root(base_url: str) -> str:
    """Strip a trailing ``/v1``: llama.cpp's ``/infill`` lives at the server root."""
    u = base_url.rstrip("/")
    return u[:-3] if u.endswith("/v1") else u


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


async def stream_infill(req: CompletionRequest, client: httpx.AsyncClient) -> AsyncIterator[str]:
    """llama.cpp native FIM endpoint (it applies the model's own FIM tokens)."""
    body = {
        "input_prefix": req.prefix,
        "input_suffix": req.suffix,
        "input_extra": req.extra,
        "prompt": "",
        "n_predict": req.max_tokens,
        "temperature": req.temperature,
        "top_k": 40,
        "top_p": 0.95,
        "stop": req.stops,
        "stream": True,
        "cache_prompt": True,
        # llama.cpp FIM-specific: cap generation time for long completions
        "t_max_predict_ms": req.timeout_ms,
    }
    if req.model:
        body["model"] = req.model
    async with client.stream("POST", _root(req.base_url) + "/infill", json=body,
                             headers=_headers()) as resp:
        if resp.status_code != 200:
            text = (await resp.aread()).decode(errors="replace")[:500]
            raise BackendError(f"/infill returned HTTP {resp.status_code}: {text}")
        async for ev in _sse(resp):
            chunk = ev.get("content", "")
            if chunk:
                yield chunk
            if ev.get("stop"):
                return


class BackendError(RuntimeError):
    pass


BACKENDS = {
    "infill": stream_infill,
}


def get_backend(name: str):
    try:
        return BACKENDS[name]
    except KeyError:
        raise BackendError(f"Unknown backend {name!r}; available: {sorted(BACKENDS)}")
