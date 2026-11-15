import asyncio
import json
import time

import httpx
import tornado
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
    """POST /jupyter-autocomp/complete -> {"completion": str, "ms": float}.

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
            self.log.warning("jupyter_autocomp backend error: %s", e)
            self.set_status(502)
            return self.finish(json.dumps({"message": f"{type(e).__name__}: {e}"}))
        self.finish(json.dumps({
            "completion": completion,
            "model": req.model,
            "ms": round((time.perf_counter() - t0) * 1000, 1),
        }))


class HealthHandler(APIHandler):
    """GET /jupyter-autocomp/health -> reports the default base URL and whether it answers."""

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
        (url_path_join(base_url, "jupyter-autocomp", "complete"), CompleteHandler),
        (url_path_join(base_url, "jupyter-autocomp", "health"), HealthHandler),
    ]
    web_app.add_handlers(host_pattern, handlers)
