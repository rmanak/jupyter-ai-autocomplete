# jupyter_autocomp

Grey "ghost text" code completion for **JupyterLab 4.4+ and Notebook 7**. Press **Tab** to accept.
It works like Continue's tab-autocomplete in VS Code, but runs against **your own LLM server**
(llama.cpp, vLLM, Ollama, LM Studio, or any OpenAI-compatible API).

* Fill-in-the-middle (FIM) prompting with notebook context: earlier cells come before the cursor,
  later cells come after it, and markdown cells are included as `#` comments.
* A Jupyter server proxy forwards requests to the LLM, so there's no CORS setup and API keys
  stay server-side. Stale requests are cancelled, which frees the LLM slot.
* Continue-style post-processing (Apache-2.0, see `NOTICE`): repetition and suffix-echo filters,
  single- vs multi-line heuristics, an LRU cache, and type-through reuse.

## Use

1. Run a FIM-capable code model, e.g. llama.cpp `llama-server` with Qwen2.5/3-Coder on `:8080`.
2. Optionally point the server elsewhere: `export JUPYTER_AUTOCOMP_BASE_URL=http://host:8080`
   (and `JUPYTER_AUTOCOMP_API_KEY=...` if the server needs one).
3. Start `jupyter lab` and start typing in a code cell.
   - **Tab** / Alt+End accepts, **Alt+[ / Alt+]** cycles, **Alt+\\** requests a completion explicitly.
   - Settings → Settings Editor → **Inline Completer** → *LLM autocomplete* has the base URL,
     model, max tokens, multi-line mode, context size, debounce delay (250 ms) and timeout.
   - **Backend**:
     - `infill`: llama.cpp `/infill`, the default.
     - `completions`: `/v1/completions` with a FIM template picked from the model name (Qwen-coder,
       StarCoder, DeepSeek, Codestral, CodeLlama, CodeGemma, Granite). Use it for **vLLM** (e.g.
       `http://localhost:8001`; vLLM's prefix caching keeps warm latency low), LM Studio and llama.cpp.
     - `ollama`: Ollama's `/api/generate` in raw FIM mode, with base URL `http://localhost:11434`.
       Ollama's `/v1/completions` puts prompts through the chat template, so FIM doesn't work there.
     - `chat`: `/v1/chat/completions`, for chat-only models; slower.
   - Suggestions stream in as they're generated. After **Enter** a suggestion is requested explicitly, because
     JupyterLab never auto-triggers when only whitespace precedes the cursor (setting: *Suggest on new lines*).
   - The status-bar dot shows ready / thinking / error / off. Click it, or use the command palette's
     *Disable/Enable LLM Autocomplete*, to toggle. Hover it to see the backend, model, latency or last error.
   - Check the LLM connection: `GET /jupyter-autocomp/health`.

## Develop

```bash
conda activate jupyter-autocomp          # env with jupyterlab, nodejs, copier, pytest
pip install -e ".[test]" && jupyter labextension develop . --overwrite
jupyter server extension enable jupyter_autocomp
jlpm build          # or: jlpm watch  (then reload the browser)
jlpm jest           # unit tests (context building, filters, cache)
pytest -q jupyter_autocomp               # server handler tests
cd ui-tests && npx playwright test       # e2e on 127.0.0.1:8898; needs the LLM at :8080
AUTOCOMP_BACKEND=ollama AUTOCOMP_BASE_URL=http://localhost:11434 npx playwright test   # e2e against Ollama
AUTOCOMP_BACKEND=completions AUTOCOMP_BASE_URL=http://localhost:8002 npx playwright test  # e2e against vLLM
```

## Offline eval

Line-completion accuracy and latency on real notebooks. It uses the extension's own prompt building
(`src/context.ts`) and post-processing (`src/filters.ts`) through `eval/cli.ts`, and the server's `backends.py`.
```bash
python eval/build_tasks.py ~/notebooks -o eval/tasks.jsonl   # hide the rest of random lines
python eval/run_eval.py                                     # every reachable config in eval/configs.json
python eval/run_eval.py --only ollama-fim --limit 50 --context-mode edit
```
Each run writes `eval/results/<stamp>/summary.md` plus per-task JSONL. Tasks and results contain your
notebook code, so they're gitignored.

## Uninstall

To remove the extension, execute:

```bash
pip uninstall jupyter_autocomp
```

## Troubleshoot

If you are seeing the frontend extension, but it is not working, check
that the server extension is enabled:

```bash
jupyter server extension list
```

If the server extension is installed and enabled, but you are not seeing
the frontend extension, check the frontend extension is installed:

```bash
jupyter labextension list
```

## Contributing

If you would like to contribute to this extension, please refer to the [Contributing Guide](CONTRIBUTING.md).
