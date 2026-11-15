# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is
A JupyterLab 4 / Notebook 7 extension that shows grey "ghost text" code completions, accepted with **Tab**, from a local or OpenAI-compatible LLM. Phased roadmap and research notes are in `PLAN.md`. Phases 0–1 are done, plus the status bar, the toggle and the completions/chat backends. Next up: streaming and an offline accuracy eval.

## Environment & commands
Always work in the project conda env. Never install into base:
```bash
source ~/anaconda3/etc/profile.d/conda.sh && conda activate jupyter-autocomp
```
- First-time setup: `pip install -e ".[test]" && jupyter labextension develop . --overwrite && jupyter server extension enable jupyter_autocomp`
- Build the frontend: `jlpm build`, or `jlpm watch` and then reload the browser. Python changes need a Jupyter server restart.
- Typecheck: `npx tsc --noEmit -p .`. Lint/format: `jlpm lint` (prettier + eslint + stylelint).
- TS unit tests (jest): `jlpm jest`. For a single test: `jlpm jest -t 'stops when reproducing the suffix'`
- Python tests: `pytest -q jupyter_autocomp`. For a single test: `pytest -q jupyter_autocomp/tests/test_routes.py::test_complete`
- E2E (galata/playwright): `cd ui-tests && npx playwright test`. It needs a live FIM model on `:8080`.

## Ports (important)
- **:8888 is the user's personal JupyterLab. Never use it or attach to it.** The e2e config is pinned to **:8898** with `reuseExistingServer: false` (`ui-tests/playwright.config.js` and `jupyter_server_test_config.py`). Use 8898/8899 for throwaway servers.
- The LLM is llama-server on **:8080**. FIM requires a coder model with FIM tokens. It currently serves `qwen3-coder`. Check it with `curl -s localhost:8080/v1/models`. The general `qwen36` chat model can't do `/infill`.

## Architecture
Request flow: **browser provider → Jupyter server proxy → LLM**.

- `src/index.ts` registers `LLMInlineProvider` with `ICompletionProviderManager.registerInlineProvider`. JupyterLab's built-in inline completer provides the ghost-text UI, the debouncing and the shortcuts (Tab/Alt+End accept, Alt+[ / Alt+] cycle, Alt+\ invoke). This repo has no UI code of its own.
- `src/provider.ts` (`fetch`) does the following:
  - gets the notebook's cells from `context.widget` (duck-typed `content.widgets` / `activeCellIndex`);
  - builds FIM prefix/suffix (`context.ts`);
  - checks the cache (`cache.ts`);
  - aborts the previous in-flight request;
  - POSTs to `/jupyter-autocomp/complete`;
  - post-processes the result (`filters.ts`).
- **Settings have no `schema/` dir on purpose.** They are the provider's `schema` property, so they appear under Settings → **Inline Completer** → providers.`jupyter-autocomp`. `schema.default` also overrides JupyterLab's per-provider defaults (`enabled`, `debouncerDelay`, `timeout`, `autoFillInMiddle`). Values arrive through `configure()`.
- `context.ts` renders the notebook as one "percent-format" file: `# %%` cell separators, markdown cells become `#` comments, and outputs are skipped. Previous cells form the prefix and following cells form the suffix. When over the char budget, the farthest cells are dropped first. `shouldCompleteMultiline` picks single-line mode when the cursor is mid-line or in a comment.
- `jupyter_autocomp/routes.py` holds `CompleteHandler` (and `/health`). It runs the backend as an asyncio task and cancels it in `on_connection_close`. The browser abort therefore closes the upstream connection, and llama.cpp stops generating.
- `jupyter_autocomp/backends.py` streams from the LLM. Backends are async generators registered in `BACKENDS`:
  - `infill`: llama.cpp `/infill`; the server applies the FIM tokens.
  - `completions`: `/v1/completions` with a raw FIM prompt. `templates.py` picks the template from the model name, or the `template` setting forces one.
  - `chat`: `/v1/chat/completions` with a `<COMPLETION>` hole-filler prompt and thinking turned off.
  When `model` is empty it comes from the server's first `/v1/models` entry, cached per URL. The resolved model is echoed back so the status bar can show it.
  `_v1()` appends `/v1` only to a bare host. The server's defaults come from env vars `JUPYTER_AUTOCOMP_BASE_URL` and `JUPYTER_AUTOCOMP_API_KEY`. The API key stays server-side only.
- Status and toggle (`src/status.ts`, `index.ts`): the provider emits `statusChanged` (idle/loading/error/disabled) and `errorOccurred`, once per distinct message, which triggers a toast. The status-bar item and the `jupyter-autocomp:toggle` command flip `providers.jupyter-autocomp.enabled` in the **inline-completer's** settings. JupyterLab still calls `configure()` on disabled providers, so the UI follows edits made in the Settings Editor.

## Constraints / gotchas
- The inline completer API is **Alpha**. Keep `jupyterlab>=4.4,<5` and check `node_modules/@jupyterlab/completer/lib/tokens.d.ts` before relying on API details.
- `stream(token)` yields *cumulative* `insertText`. JupyterLab replaces the whole text and only diffs it for the animation.
- The TS target and lib are **ES2018**, so avoid newer built-ins like `String.prototype.trimStart`.
- Galata mocks the settings API in the page (`mockSettings`), so a REST `PUT /lab/api/settings` from a test has no effect. Seed settings per test with `test.use({ mockSettings: {...galata.DEFAULT_SETTINGS, ...} })`, as `ui-tests/tests/jupyter_autocomp.spec.ts` does.
- Logic adapted from Continue (Apache-2.0, `core/autocomplete`) must be listed in `NOTICE`.
- In the interactive shell, `grep` is an ugrep wrapper that can silently skip files. Use `command grep` or `rg`.
