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
    assert "\n" in req.stops()
    assert backends._root("http://h:8080/v1/") == "http://h:8080"


# --- templates / URL handling -------------------------------------------------

from jupyter_autocomp import templates


@pytest.mark.parametrize("model,name", [
    ("qwen3-coder", "qwen"), ("Qwen2.5-Coder-7B", "qwen"), ("codeqwen1.5", "starcoder"),
    ("starcoder2:3b", "starcoder"), ("deepseek-coder-6.7b-base", "deepseek"),
    ("codestral-latest", "codestral"), ("codellama:7b-code", "codellama"),
    ("codegemma:2b", "codegemma"), ("granite-4.0-h-tiny", "granite"), ("mystery", "qwen"),
])
def test_template_routing(model, name):
    assert templates.template_for_model(model).name == name


def test_render_is_brace_safe():
    t = templates.TEMPLATES["codestral"]
    out = t.render(prefix="d = {'k': '{suffix}'}", suffix="\nprint(d)")
    assert out == "[SUFFIX]\nprint(d)[PREFIX]d = {'k': '{suffix}'}"


def test_explicit_template_and_unknown():
    assert templates.resolve_template("deepseek", "qwen3-coder").name == "deepseek"
    with pytest.raises(ValueError):
        templates.resolve_template("nope", "x")


def test_extract_completion():
    assert templates.extract_completion("<COMPLETION>x = 1</COMPLETION> bye") == "x = 1"
    assert templates.extract_completion("<COMPLETION>x = 1") == "x = 1"
    assert templates.extract_completion("plain") == "plain"


@pytest.mark.parametrize("url,v1,root", [
    ("http://h:8080", "http://h:8080/v1", "http://h:8080"),
    ("http://h:8080/v1/", "http://h:8080/v1", "http://h:8080"),
    ("https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1", "https://openrouter.ai/api"),
])
def test_urls(url, v1, root):
    assert backends._v1(url) == v1
    assert backends._root(url) == root


def test_stop_list():
    req = backends.CompletionRequest(prefix="", multiline=False)
    s = req.stops(("<EOT>",))
    assert s[-1] == "\n" and "<EOT>" in s and len(s) == len(set(s))
