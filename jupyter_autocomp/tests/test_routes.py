import json

import pytest
from tornado.httpclient import HTTPClientError

from jupyter_autocomp import backends, routes


async def _fake_infill(req, client):
    assert req.prefix.endswith("m = ")
    for chunk in ["np.", "mean", "(x)"]:
        yield chunk


async def _broken(req, client):
    raise backends.BackendError("upstream down")
    yield  # pragma: no cover


async def test_complete(jp_fetch, monkeypatch):
    monkeypatch.setitem(backends.BACKENDS, "infill", _fake_infill)
    r = await jp_fetch("jupyter-autocomp", "complete", method="POST",
                       body=json.dumps({"prefix": "m = ", "suffix": "", "multiline": False}))
    assert r.code == 200
    assert json.loads(r.body)["completion"] == "np.mean(x)"


async def test_complete_backend_error(jp_fetch, monkeypatch):
    monkeypatch.setitem(backends.BACKENDS, "infill", _broken)
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("jupyter-autocomp", "complete", method="POST",
                       body=json.dumps({"prefix": "x"}))
    assert e.value.code == 502


def test_request_defaults():
    req = backends.CompletionRequest.from_json({"prefix": "a", "multiline": False, "base_url": None})
    assert req.base_url == backends.DEFAULT_BASE_URL
    assert "\n" in req.stops
    assert backends._root("http://h:8080/v1/") == "http://h:8080"
