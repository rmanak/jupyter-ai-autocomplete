# Eval results (2026-11-15)

Line completion on **300 tasks** taken from 43 local Python notebooks (`build_tasks.py --seed 0`): 211 mid-line
and 89 line-start. `--context-mode write`: the model sees cells above the cursor plus the current cell up to it.
The task set is home-made and private, not a public benchmark. With n=300 the noise on exact match (EM) is
about ±3 points (one standard error).

Metrics: **EM** = exact match of the first suggested line, **ES** = edit similarity, **safe** = the suggestion
is a correct prefix of the line, **empty** = no suggestion. Latency is measured at the backend: *cold* = the
first request with this prompt, *warm* = the same prompt again (prompt cache primed, like the next keystroke).

| config | model / server | EM % | ES % | safe % | empty % | first token cold p50 (ms) | first token warm p50 / p90 (ms) |
|---|---|---|---|---|---|---|---|
| `llamacpp-completions` | Qwen3-Coder-30B-A3B Q5_K_XL · llama.cpp `/v1/completions` FIM | **45.3** | **72.2** | **47.3** | 1.7 | 495 | 14 / 19 |
| `ollama-fim`¹ | Qwen3-Coder-30B-A3B Q4_K_M · Ollama `/api/generate` raw FIM | 44.7 | 71.6 | 47.0 | 1.0 | 423 | 20 / 28 |
| `ollama-fim-no-markdown`¹ | same, markdown cells left out | 44.3 | 70.1 | 46.3 | 0.7 | 162 | 18 / 26 |
| `llamacpp-infill` | Qwen3-Coder-30B-A3B Q5_K_XL · llama.cpp `/infill` | 42.0 | 69.3 | 44.3 | 2.7 | 148 | **11** / 16 |
| `ollama-fim-cell-only`¹ | same as ollama-fim, **current cell only** | 35.0 | 62.9 | 36.3 | 0.0 | 58 | 13 / 19 |
| `vllm-1.5b-fim` | Qwen2.5-Coder-1.5B-Instruct AWQ · vLLM `/v1/completions` FIM | 34.3 | 63.9 | 35.7 | 0.0 | 88 | 26 / 42 |
| `llamacpp-chat`² | Qwen3-Coder-30B · llama.cpp chat, hole-filler prompt | 25.7 | 61.3 | 30.0 | 0.7 | 875 | 338 / 919 |
| `ollama-chat`¹ | Qwen3-Coder-30B · Ollama chat, hole-filler prompt | 23.3 | 59.3 | 25.7 | 0.3 | 844 | 369 / 888 |
| `vllm-1.5b-chat` | Qwen2.5-Coder-1.5B · vLLM chat, hole-filler prompt | 3.3 | 20.2 | 3.7 | 13.7 | 128 | 57 / 389 |

¹ ² These ran before the `# %%` cell-marker change (a server-side stop then, client-side cutting now).
Rerunning `llamacpp-infill` and `llamacpp-completions` with the change moved EM by ≤0.3 points, so they are
comparable. Chat warm latency is the whole answer, because the chat backend buffers the response.

## Takeaways
- **FIM prompting is the main factor.** On the same 30B model, FIM beats a chat-style "fill the hole" prompt by
  about 20 EM points and is about 20x faster when warm. Chat-style prompting is what jupyter-ai-lite uses.
  The 1.5B model can't follow the chat format at all (3% EM).
- **Notebook context matters.** Including the cells above adds about 10 EM points over current-cell-only.
  Markdown-as-comments makes no measurable difference overall (+0.4 EM, within noise). It helps slightly on
  line-start tasks (+3.4 EM) and stays on by default.
- **Serving stack hardly matters for quality.** llama.cpp `/v1/completions` with our Qwen FIM template (45.3)
  ≈ Ollama raw FIM (44.7) ≈ llama.cpp `/infill` (42.0, close to the noise level). Warm first-token latency is
  11–20 ms everywhere.
- **Small model trade-off:** the 1.5B model on vLLM keeps about 76% of the 30B's EM (34.3 vs 45.3) with about
  26 ms warm first token and a ~6 GB footprint. It's a reasonable choice when the GPU is busy.
- **Known gap:** most remaining "empty" cases are line-start tasks at the top of an *empty* cell. The model
  predicts that a markdown cell comes next. JupyterLab doesn't auto-trigger in an empty cell, so in practice
  this only shows up with Alt+\.
- Cold latency depends on cache state and run order (each config ran right after another), so compare the warm
  numbers.

Reproduce: `python eval/build_tasks.py ~/claude_workspace -o eval/tasks.jsonl && python eval/run_eval.py`.
