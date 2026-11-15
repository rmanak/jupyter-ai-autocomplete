# jupyter_ai_autocomplete

Grey "ghost text" code completion for **JupyterLab 4.4+ and Jupyter Notebook 7**, powered by
**your own LLM**. Type in a code cell, a suggestion appears in grey, press **Tab** to accept.

It works like Copilot / Continue tab-autocomplete, but nothing leaves your machine unless you want
it to: it talks to a model server you run (llama.cpp, Ollama, vLLM, LM Studio) or to any
OpenAI-compatible API.

- **Notebook-aware context.** Uses fill-in-the-middle (FIM) prompting: earlier cells go before the
  cursor, later cells after it, and markdown cells are included as `#` comments.
- **Streaming.** Suggestions appear as soon as the first tokens arrive.
- **No CORS or key leakage.** The browser talks to the Jupyter server, which forwards to the LLM.
  API keys stay on the server. Stale requests are cancelled, which frees the model's slot.
- **Clean suggestions.** Continue-style post-processing (Apache-2.0, see `NOTICE`): repetition and
  suffix-echo filters, single- vs multi-line heuristics, an LRU cache, and type-through reuse.

## Requirements

- Python ≥ 3.10 and JupyterLab ≥ 4.4, < 5 (or Notebook 7)
- **Node.js ≥ 20**, needed only to build the extension when you install from source
- An LLM server with a **code model that supports FIM**, e.g. Qwen2.5-Coder, Qwen3-Coder,
  StarCoder2, DeepSeek-Coder, Codestral, CodeGemma, Granite-Code. Chat-only models also work
  through the `chat` backend, but they're slower and less accurate.

## Install

The extension isn't on PyPI yet, so install it from source. Use a fresh environment. The example
uses conda, but any venv with Node.js available works.

```bash
conda create -n autocomp -c conda-forge python=3.12 nodejs=22
conda activate autocomp
pip install "jupyterlab>=4.4,<5"

git clone https://github.com/rmanak/jupyter-ai-autocomplete.git
cd jupyter_ai_autocomplete
pip install .
```

`pip install .` compiles the TypeScript frontend. The first build downloads npm packages, so it
takes a minute. Then check that both halves are installed and enabled:

```bash
jupyter labextension list          # should show: jupyter_ai_autocomplete v0.1.0 enabled OK
jupyter server extension list      # should show: jupyter_ai_autocomplete enabled
```

## Run a model server

Pick **one** option. Each command serves a small, fast coder model that suits autocomplete.

**llama.cpp** (default backend `infill`, port 8080). [Install llama.cpp](https://github.com/ggml-org/llama.cpp), then:

```bash
llama-server -hf ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF --host 127.0.0.1 --port 8080 -ngl 99
```

(`-ngl 99` puts the model on the GPU. Drop it for CPU-only. Bigger options:
`ggml-org/Qwen2.5-Coder-7B-Q8_0-GGUF`, or a Qwen3-Coder GGUF.)

**Ollama** (backend `ollama`, port 11434):

```bash
ollama pull qwen2.5-coder:1.5b-base
ollama serve        # if it isn't already running as a service
```

**vLLM** (backend `completions`):

```bash
vllm serve Qwen/Qwen2.5-Coder-1.5B --host 127.0.0.1 --port 8001
```

Check that the server answers before going on, e.g. `curl http://localhost:8080/v1/models`
(or `curl http://localhost:11434/api/tags` for Ollama).

## Configure

If you use **llama.cpp on `localhost:8080`**, there's nothing to configure. Skip to _Use_.

Otherwise, either:

- **Set it in JupyterLab:** _Settings → Settings Editor → Inline Completer_, find
  _LLM autocomplete (jupyter_ai_autocomplete)_ under providers, and set **Backend** and **Base URL**:

  | Server                                                       | Backend       | Base URL                     |
  | ------------------------------------------------------------ | ------------- | ---------------------------- |
  | llama.cpp                                                    | `infill`      | `http://localhost:8080`      |
  | Ollama                                                       | `ollama`      | `http://localhost:11434`     |
  | vLLM / LM Studio / other OpenAI-compatible `/v1/completions` | `completions` | e.g. `http://localhost:8001` |
  | Chat-only API (`/v1/chat/completions`)                       | `chat`        | the API's URL                |

- **Or set the server default with environment variables** before starting Jupyter. This is the
  only place to put an API key, which is never sent to the browser:

  ```bash
  export JUPYTER_AI_AUTOCOMPLETE_BASE_URL=http://localhost:11434
  export JUPYTER_AI_AUTOCOMPLETE_API_KEY=sk-...        # only if your server needs one
  ```

  You still pick the **Backend** in the Settings Editor.

### Choosing the model

When **Model** is empty, the extension uses the first model the server lists at `/v1/models`. That
is fine for llama.cpp and vLLM serving a single model. Set it explicitly when the server hosts
several models (Ollama usually does), or when you want a specific one.

1. **Find the model id** your server uses:

   ```bash
   curl -s http://localhost:8080/v1/models | python -m json.tool   # llama.cpp / vLLM / LM Studio: the "id" fields
   ollama list                                                     # Ollama: the NAME column, e.g. qwen2.5-coder:1.5b-base
   ```

2. **Set it** in _Settings → Settings Editor → Inline Completer_ → providers →
   _LLM autocomplete (jupyter_ai_autocomplete)_ → **Model**. Or open the JSON editor (_Advanced Settings
   Editor_, or the `{}` button in the Settings Editor) for _Inline Completer_ and add:

   ```json
   {
     "providers": {
       "jupyter-ai-autocomplete": {
         "backend": "ollama",
         "baseUrl": "http://localhost:11434",
         "model": "qwen2.5-coder:1.5b-base"
       }
     }
   }
   ```

The change applies immediately, with no restart. Hover the status-bar dot to check which model is
in use. Notes:

- The model can only be set in the settings, not with an environment variable.
- The id must match the server exactly, including any `:tag` or `org/` prefix (vLLM uses the
  Hugging Face name, e.g. `Qwen/Qwen2.5-Coder-1.5B`, unless started with `--served-model-name`).
- With `infill`, the setting has no effect: llama.cpp's `/infill` always uses the model that
  llama-server loaded. To switch models there, restart llama-server with another one.
- With **FIM template** on `auto`, the prompt format is picked from the model name. If your model
  id doesn't contain the family name (`qwen`, `starcoder`, `deepseek`, …), set the template
  explicitly.

<details>
<summary>All settings</summary>

| Setting                               | Default            | Meaning                                                                                                                                            |
| ------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend                               | `infill`           | `infill` / `completions` / `ollama` / `chat` (see above)                                                                                           |
| Base URL                              | _(empty)_          | LLM server. Empty means `$JUPYTER_AI_AUTOCOMPLETE_BASE_URL` or `http://localhost:8080`. `/v1` is added when the URL has no path.                   |
| Model                                 | _(empty)_          | Model id. Empty means the first one at `/v1/models`.                                                                                               |
| FIM template                          | `auto`             | For `completions`/`ollama`: picked from the model name, or force `qwen`, `starcoder`, `deepseek`, `codestral`, `codellama`, `codegemma`, `granite` |
| Max tokens (multi-line / single-line) | 128 / 48           | Generation limits                                                                                                                                  |
| Temperature                           | 0.01               |                                                                                                                                                    |
| Multi-line completions                | `auto`             | `auto` gives a single line when mid-line or in a comment, multi-line otherwise. Also `always` / `never`.                                           |
| Max context before / after cursor     | 12000 / 4000 chars | The farthest cells are dropped first when over budget                                                                                              |
| Include markdown cells as comments    | on                 |                                                                                                                                                    |
| Suggest on new lines                  | on                 | Request a suggestion after **Enter**. JupyterLab otherwise never triggers on an empty line.                                                        |
| Debounce delay                        | 250 ms             | Wait after the last keystroke before asking the model                                                                                              |
| Timeout                               | 10000 ms           |                                                                                                                                                    |

</details>

## Use

```bash
jupyter lab        # or: jupyter notebook
```

Open a notebook and start typing in a code cell. The first suggestion can take a few seconds while
the model warms up.

| Key                  | Action                    |
| -------------------- | ------------------------- |
| **Tab** (or Alt+End) | Accept the suggestion     |
| Esc / keep typing    | Dismiss it                |
| Alt+[ / Alt+]        | Cycle through suggestions |
| Alt+\\               | Ask for a suggestion now  |

The **status-bar dot** shows ready / thinking / error / off. Hover it to see the backend, model,
latency, or the last error. Click it, or run _Disable/Enable LLM Autocomplete_ from the command
palette, to turn completions off and on.

**Only want the LLM suggestions?** JupyterLab's own Tab dropdown (kernel/jedi and in-notebook
word completions) is separate from this extension. To turn it off, add the following under
_Settings → Code Completion_ (JSON editor). A negative rank disables a provider:

```json
{
  "availableProviders": {
    "CompletionProvider:kernel": -1,
    "CompletionProvider:context": -1
  }
}
```

Tab then accepts the ghost text when there is some, and indents otherwise. Also keep the built-in
`@jupyterlab/inline-completer:history` provider disabled under _Settings → Inline Completer_. It's
off by default.

## Troubleshooting

- **No ghost text at all.**
  - Check that both extensions show as enabled (see _Install_), then restart `jupyter lab` and
    hard-reload the browser tab.
  - Check that the status-bar dot isn't "off".
  - Check that the provider is enabled under _Settings → Inline Completer_.
- **The dot turns red, or an error toast appears.** The Jupyter server can't reach the model.
  Hover the dot for the error, and check the server-side connection at
  `http://localhost:8888/jupyter-ai-autocomplete/health` (open it in the same browser, while logged in to
  Jupyter). Make sure the Base URL and Backend match your server.
- **Suggestions are garbage or just repeat the code.**
  - The model probably isn't a FIM coder model, or the FIM template is wrong. Use a `*-Coder` base
    or instruct model.
  - With `completions` or `ollama`, try setting **FIM template** explicitly.
  - Plain chat models only work with the `chat` backend.
- **llama.cpp returns errors on `infill`.** The loaded model has no FIM tokens. Load a coder model,
  or switch to the `chat` backend.
- **Ollama completions don't fit the code around them.** Use the `ollama` backend, not
  `completions`: Ollama's `/v1/completions` puts the prompt through the chat template, which
  breaks FIM.

## Uninstall

```bash
pip uninstall jupyter_ai_autocomplete
```

## Development

```bash
pip install -e ".[test]"
jupyter labextension develop . --overwrite
jupyter server extension enable jupyter_ai_autocomplete
jlpm build              # or: jlpm watch, then reload the browser. Python changes need a server restart.

jlpm jest               # frontend unit tests (context building, filters, cache, streaming)
pytest -q jupyter_ai_autocomplete                  # server handler tests
cd ui-tests && npx playwright test          # end-to-end tests on 127.0.0.1:8898; needs a FIM model on :8080
AUTOCOMP_BACKEND=ollama AUTOCOMP_BASE_URL=http://localhost:11434 npx playwright test
```

The request flow is **browser provider → Jupyter server proxy (`/jupyter-ai-autocomplete/stream`) → LLM**.
The UI is JupyterLab's built-in inline completer. This extension registers a provider for it, see
`src/index.ts` and `src/provider.ts`. The server-side backends are in `jupyter_ai_autocomplete/backends.py`.

### Offline eval

Measures line-completion accuracy and latency on your own notebooks. It uses the extension's real
prompt building and post-processing.

```bash
python eval/build_tasks.py ~/notebooks -o eval/tasks.jsonl   # hide the rest of random lines
python eval/run_eval.py                                     # every reachable config in eval/configs.json
python eval/run_eval.py --only ollama-fim --limit 50 --context-mode edit
```

Results go to `eval/results/<stamp>/summary.md`. Tasks and results contain your notebook code, so
they're gitignored.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

BSD-3-Clause. Parts of the completion post-processing are adapted from
[Continue](https://github.com/continuedev/continue) (Apache-2.0). See `NOTICE`.
