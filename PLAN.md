# jupyter_autocomp: plan

Grey "ghost text" code completion in JupyterLab / Notebook 7, accepted with **Tab**, backed by
**any local or OpenAI-compatible LLM endpoint**. It works like Continue's tab-autocomplete in VS Code.

## 1. What already exists (research, 2026-11-14)

| Thing | Finding | Consequence |
|---|---|---|
| **JupyterLab inline completer API** (4.1+, still marked *Alpha*) | `IInlineCompletionProvider` with `fetch(request, context)` and optional `stream(token)`. Register it with `ICompletionProviderManager.registerInlineProvider()`. `request` = `{text, offset, mimeType}` for the **current cell**. `context` = `{widget, session, triggerKind}`, where `triggerKind` is Invoke (`Alt+\`) or Automatic. Built-in ghost-text UI, per-provider settings (Enabled, debouncer delay, timeout), and shortcuts: **Tab / Alt+End to accept**, Alt+[ / Alt+] to cycle. It's off by default and gets enabled per provider in Settings → Inline Completer. | We **don't build any UI**. We only write a provider. Notebook 7 is built on the same packages, so the extension works there too. |
| **jupyter-ai v3** | Rebuilt around agents/chat. The docs have no inline-completion section. v2 had `default_completions_model` with chat-style prompts and no FIM. | Not a fit. |
| **jupyter-ai-lite** (JupyterLab ≥4.5) | Runs in the browser. Has a "Generic (OpenAI-compatible)" provider for chat. Its completion path is undocumented and has no FIM. | Spend 15 min checking it in Phase 0. Our gap is still **true FIM, notebook-aware context, and Continue-grade filtering**. |
| **Continue** (`core/autocomplete`, Apache-2.0) | Pipeline: debounce → prefilter → build prefix/suffix + snippets → model-specific FIM template → stream through char/line filters → postprocess → LRU cache. Also reuses a running generator while the user keeps typing the predicted text. | Port the *ideas* and small pure functions, with attribution. |
| **Local server** (`:8080`) | Currently serving `qwen3-coder`. **`POST /infill` works** and returns a correct FIM completion. | The first backend is llama.cpp `/infill`, which has no template guesswork. |

## 2. Architecture

```
 JupyterLab / Notebook 7 (browser)                       Jupyter server (Python)            LLM
┌──────────────────────────────────────────┐    ┌────────────────────────────────┐   ┌──────────────┐
│ InlineCompletionProvider  (TypeScript)   │    │ /jupyter-autocomp/complete     │   │ llama.cpp    │
│  fetch(): build notebook context ────────┼───►│  (tornado handler, streaming)  ├──►│ /infill      │
│   - prev cells → prefix, next → suffix   │SSE │  backends:                     │   │ /v1/completions│
│   - abort on new keystroke               │◄───┤   infill | completions | chat  │   │ /v1/chat/... │
│  stream(): yield tokens into ghost text  │    │  templates, stop tokens, auth  │   │ (vLLM/Ollama/│
│  filters + postprocess (Continue port)   │    └────────────────────────────────┘   │  LM Studio…) │
│  LRU cache, generator reuse              │                                          └──────────────┘
└──────────────────────────────────────────┘
```

**Why a server-side proxy** instead of calling the LLM from the browser:
- no CORS problems;
- API keys stay on the server;
- it still works when Jupyter runs on skynet and the browser is elsewhere (SSH tunnel to Jupyter only);
- prompt templates can be tested in Python.

The TS side stays thin: it handles context, cancellation, caching, and display filtering.

### Notebook context (the main difference from a plain code editor)
- **prefix** = earlier cells in order + current cell up to the cursor. Code cells go in verbatim. Markdown cells become `# ` comments, which helps intent a lot. Cells are separated by `# %%`. Outputs are skipped (maybe later: the last short text output as a comment).
- **suffix** = rest of the current cell + following cells, truncated.
- Budget: about 3k prefix / 1k suffix tokens, estimated as chars/3.5. When over budget, drop the **farthest** cells first, but always keep the import cells.
- llama.cpp `/infill` gets other cells through `input_extra` (repo-level FIM). The `completions` backend uses Continue's Qwen multi-file `<|file_sep|>` layout.
- Later: kernel-aware context, e.g. names and types of live variables via a silent `session.kernel.requestExecute` / `%who_ls`. This is opt-in.

### Backends (setting: `backend`)
1. **`infill`**: llama.cpp `/infill` (the server applies the model's FIM tokens). Default.
2. **`completions`**: OpenAI `/v1/completions` with a raw FIM template. The template is picked by model name (Qwen-coder, StarCoder2, DeepSeek-coder, Codestral, CodeLlama), as in Continue's `AutocompleteTemplate.ts`. Covers vLLM, Ollama, LM Studio, TGI, and llama.cpp.
3. **`chat`**: `/v1/chat/completions` with Continue's "hole filler" prompt, for chat-only models (e.g. `qwen36`, GPT-class APIs). It's slower and needs `<think>` stripped. Use only as a fallback.

Shared settings: `temperature≈0.01`, `max_tokens` 64 for single-line / 256 for multiline, stop tokens (`\n\n\n`, `# %%`, ```` ``` ````, model FIM tokens), and `n_predict` caps. If the model is thinking-capable, set `"cache_prompt": true` (llama.cpp) and turn thinking off.

## 3. Porting from Continue (what and where)
| Continue file | Our equivalent |
|---|---|
| `util/AutocompleteDebouncer.ts` | Mostly covered by JupyterLab's own provider *debouncer delay* setting. We also abort the in-flight request (`AbortController`) on every new `fetch`. |
| `util/AutocompleteLruCache.ts` | In-memory LRU (~200 entries) keyed on the trimmed prefix tail. |
| `generation/GeneratorReuseManager.ts` | If the user types characters that match the streaming completion, keep consuming the same stream instead of re-requesting. This is a big latency win. |
| `classification/shouldCompleteMultiline.ts` | Single-line when inside a `#` comment or mid-line (suffix on the same line). Otherwise multiline. Also a setting: `auto|always|never`. |
| `filtering/streamTransforms/*` | Stop at stop tokens, stop when the output starts reproducing the suffix or the line below the cursor, stop on repeating lines, no double blank lines, and a hard timeout that shows whatever has arrived. |
| `postprocessing/index.ts` | Drop blank / whitespace-only output, drop output that rewrites the line above, drop extreme repetition, strip ```` ``` ```` fences and `<think>…</think>`, and de-duplicate a leading space. |
| `templating/AutocompleteTemplate.ts` | Python `templates.py` (Qwen, StarCoder2, DeepSeek, Codestral, CodeLlama, hole-filler). |

## 4. Repo layout (from the official `jupyterlab/extension-template`, frontend-and-server)
```
jupyter_autocomp/
  pyproject.toml, package.json, tsconfig.json
  src/index.ts            # plugin: requires ICompletionProviderManager, registers provider
  src/provider.ts         # IInlineCompletionProvider (fetch/stream/configure)
  src/context.ts          # notebook → prefix/suffix (+ extra cells)
  src/filters.ts          # stream filters + postprocess (Continue port)
  src/cache.ts            # LRU + generator reuse
  schema/plugin.json      # settings: backend, base_url, model, api_key(server-side), max_tokens, ...
  jupyter_autocomp/       # server extension
    handlers.py           # POST /jupyter-autocomp/complete  (streams SSE)
    backends.py           # infill / completions / chat via httpx.AsyncClient
    templates.py
  ui-tests/  tests/       # jest (TS pure functions), pytest (handlers w/ mock LLM), galata (e2e)
```
The server-side config (base URL, API key) can also come from `jupyter_server_config.py` / env vars (`JUPYTER_AUTOCOMP_BASE_URL`), so secrets never sit in browser settings.

## 5. Phases
0. **Env + scaffold**: conda env `jupyter-autocomp` (python 3.12, `jupyterlab>=4.4,<5`, `nodejs>=20`, `copier`, `httpx`, `pytest`). Run `copier copy --trust https://github.com/jupyterlab/extension-template .`, then `pip install -e ".[test]"`, `jupyter labextension develop . --overwrite`, `jupyter server extension enable jupyter_autocomp`, and `jlpm build` (`jlpm watch` while developing). Register the kernel. Do the 15-min check of jupyter-ai-lite completions.
1. **MVP**: provider + `/complete` proxy → llama.cpp `/infill`. Non-streaming. Context = current cell + previous cells. Goal: **ghost text appears and Tab accepts it** in Lab and Notebook 7.
2. **Latency**: SSE streaming (`isIncomplete` + `stream(token)`), abort on keystroke, LRU cache, generator reuse, `cache_prompt`. Target **p50 < 400 ms to first visible token** on the 3090 Ti / Blackwell.
3. **Quality**: Continue filters + postprocessing, multiline heuristics, markdown-as-comments, following cells as suffix, `input_extra`.
4. **Backends**: `/v1/completions` + FIM templates, then `chat` fallback. Test against llama.cpp, vLLM, and Ollama.
5. **UX**: settings schema in the Settings Editor, a status-bar indicator (idle / thinking / error, click to toggle), a per-notebook disable option, error toasts shown once (Continue's `ERRORS_TO_IGNORE` idea).
6. **Tests + eval**: jest for context/filters, pytest with a fake LLM server, one galata e2e test (type → ghost text → Tab). Add a small offline eval: take real notebooks, mask a line, measure exact/prefix match and latency per backend/model.
7. **Package**: wheel (`python -m build`), README, optional PyPI.

## 6. Risks / open points
- The inline completer API is **Alpha**, so pin `jupyterlab>=4.4,<5` and watch the changelogs.
- **Tab conflict** with the classic completer and indentation: JupyterLab accepts ghost text on Tab only while a suggestion is shown, so this should be fine. Verify in Phase 1.
- **Model choice**: FIM needs a *coder/base* model with FIM tokens (`qwen3-coder`, Qwen2.5-Coder). The general `qwen36` chat model only works through the slower `chat` backend.
- **Licensing**: Continue is Apache-2.0. Keep a NOTICE entry for ported code.
