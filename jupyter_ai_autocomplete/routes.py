import asyncio
import contextlib
import json
import time

import httpx
import tornado
from tornado.iostream import StreamClosedError
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join

from . import backends
from .backends import BackendError, CompletionRequest

_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=3.0))
    return _client


class CompleteHandler(APIHandler):
    """POST /jupyter-ai-autocomplete/complete -> {"completion": str, "ms": float}.

    If the browser aborts (the user kept typing), the connection closes. We then
    cancel the upstream generation so the LLM slot is freed right away.
    """

    _task: asyncio.Task | None = None

    def on_connection_close(self):
        if self._task is not None and not self._task.done():
            self._task.cancel()

    async def _run(self, req: CompletionRequest) -> str:
        stream = backends.get_backend(req.backend)
        out = []
        async for chunk in stream(req, client()):
            out.append(chunk)
        return "".join(out)

    @tornado.web.authenticated
    async def post(self):
        try:
            req = CompletionRequest.from_json(self.get_json_body() or {})
        except TypeError as e:
            self.set_status(400)
            return self.finish(json.dumps({"message": f"Bad request: {e}"}))
        t0 = time.perf_counter()
        self._task = asyncio.ensure_future(self._run(req))
        try:
            completion = await self._task
        except asyncio.CancelledError:
            return  # client went away; nothing to send
        except (BackendError, httpx.HTTPError) as e:
            self.log.warning("jupyter_ai_autocomplete backend error: %s", e)
            self.set_status(502)
            return self.finish(json.dumps({"message": f"{type(e).__name__}: {e}"}))
        self.finish(json.dumps({
            "completion": completion,
            "model": req.model,
            "ms": round((time.perf_counter() - t0) * 1000, 1),
        }))


class StreamHandler(APIHandler):
    """POST /jupyter-ai-autocomplete/stream -> Server-Sent Events.

    Events: ``{"text": chunk}`` while generating, then one of
    ``{"done": true, "model": ..., "ms": ...}`` or ``{"error": message}``.
    If the browser disconnects, the task is cancelled and the upstream LLM
    stream is closed.
    """

    _task: asyncio.Task | None = None

    def on_connection_close(self):
        if self._task is not None and not self._task.done():
            self._task.cancel()

    async def _send(self, payload: dict) -> None:
        self.write(f"data: {json.dumps(payload)}\n\n")
        await self.flush()

    async def _pump(self, req: CompletionRequest) -> None:
        t0 = time.perf_counter()
        try:
            gen = backends.get_backend(req.backend)(req, client())
            async with contextlib.aclosing(gen):
                first = True
                async for chunk in gen:
                    # Send the model with the first chunk: the client often stops
                    # early and never sees the "done" event.
                    await self._send({"text": chunk, "model": req.model} if first
                                     else {"text": chunk})
                    first = False
            await self._send({"done": True, "model": req.model,
                              "ms": round((time.perf_counter() - t0) * 1000, 1)})
        except (BackendError, httpx.HTTPError) as e:
            self.log.warning("jupyter_ai_autocomplete backend error: %s", e)
            await self._send({"error": f"{type(e).__name__}: {e}"})

    @tornado.web.authenticated
    async def post(self):
        try:
            req = CompletionRequest.from_json(self.get_json_body() or {})
        except TypeError as e:
            self.set_status(400)
            return self.finish(json.dumps({"message": f"Bad request: {e}"}))
        self.set_header("Content-Type", "text/event-stream")
        self.set_header("Cache-Control", "no-cache")
        self.set_header("X-Accel-Buffering", "no")  # don't let proxies buffer it
        self._task = asyncio.ensure_future(self._pump(req))
        try:
            await self._task
        except (asyncio.CancelledError, StreamClosedError):
            return  # client went away
        self.finish(set_content_type="text/event-stream")


class HealthHandler(APIHandler):
    """GET /jupyter-ai-autocomplete/health -> reports the default base URL and whether it answers."""

    @tornado.web.authenticated
    async def get(self):
        root = backends._root(backends.DEFAULT_BASE_URL)
        ok, detail = False, ""
        try:
            r = await client().get(root + "/health", timeout=2.0)
            ok, detail = r.status_code == 200, r.text[:200]
        except httpx.HTTPError as e:
            detail = str(e)
        self.finish(json.dumps({"base_url": backends.DEFAULT_BASE_URL, "ok": ok,
                                "detail": detail}))


def setup_route_handlers(web_app):
    host_pattern = ".*$"
    base_url = web_app.settings["base_url"]
    handlers = [
        (url_path_join(base_url, "jupyter-ai-autocomplete", "complete"), CompleteHandler),
        (url_path_join(base_url, "jupyter-ai-autocomplete", "stream"), StreamHandler),
        (url_path_join(base_url, "jupyter-ai-autocomplete", "health"), HealthHandler),
    ]
    web_app.add_handlers(host_pattern, handlers)
