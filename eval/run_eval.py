"""Offline eval for jupyter_ai_autocomplete: line completion on real notebooks.

Pipeline (each step uses the code the extension ships):
  1. tasks.jsonl (build_tasks.py)
  2. prompts: src/context.ts via eval/cli.ts, the same prefix/suffix as in JupyterLab
  3. generation: jupyter_ai_autocomplete/backends.py, the same requests the server sends
  4. cleanup: src/filters.ts via eval/cli.ts, the same post-processing
  5. scoring: the first suggested line against the hidden rest of the line

    python eval/run_eval.py                                  # all reachable configs
    python eval/run_eval.py --only ollama-fim,ollama-chat --limit 50
    python eval/run_eval.py --context-mode edit              # also show code after the cursor

Metrics (per config, overall and by task kind):
  EM        exact match of the first suggested line with the target
  ES        edit similarity, 1 - Levenshtein/max(len), averaged
  safe      the suggestion is a non-empty prefix of the target, so accepting is
            never wrong (it may just be incomplete)
  empty     no suggestion shown
  latency   ms at the backend (no browser). "cold" = first request for that
            notebook prompt; "warm" = the same prompt again with the server's prompt
            cache primed, which is close to the next keystroke in the same notebook
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

from jupyter_ai_autocomplete import backends  # noqa: E402

BUILD = HERE / ".build"
CLI = BUILD / "eval" / "cli.js"

# Mirrors DEFAULT_SETTINGS in src/provider.ts.
DEFAULTS = {
    "maxTokens": 128, "maxTokensSingleLine": 48, "temperature": 0.01,
    "maxPrefixChars": 12000, "maxSuffixChars": 4000, "includeMarkdown": True,
    "multiline": "auto", "context": "notebook", "template": "auto", "model": "",
}


# ---------------------------------------------------------------- helpers ---

def build_cli() -> None:
    srcs = [ROOT / "src/context.ts", ROOT / "src/filters.ts", HERE / "cli.ts"]
    if CLI.exists() and all(CLI.stat().st_mtime > s.stat().st_mtime for s in srcs):
        return
    cmd = ["npx", "tsc", "--module", "commonjs", "--target", "es2018", "--lib", "es2018,dom",
           "--types", "node", "--skipLibCheck", "--outDir", str(BUILD), "--rootDir", str(ROOT),
           *map(str, srcs)]
    subprocess.run(cmd, cwd=ROOT, check=True)


def node(mode: str, rows: list[dict]) -> list[dict]:
    inp = "".join(json.dumps(r) + "\n" for r in rows)
    res = subprocess.run(["node", str(CLI), mode], input=inp, capture_output=True,
                         text=True, check=True)
    return [json.loads(l) for l in res.stdout.splitlines() if l.strip()]


def levenshtein(a: str, b: str) -> int:
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def edit_sim(a: str, b: str) -> float:
    if not a and not b:
        return 1.0
    return 1 - levenshtein(a, b) / max(len(a), len(b))


def pct(xs, q):
    if not xs:
        return float("nan")
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))]


# -------------------------------------------------------------- pipeline ---

def prepare_rows(tasks: list[dict], cfg: dict, context_mode: str) -> list[dict]:
    rows = []
    for t in tasks:
        text = t["cell_before_cursor"]
        offset = len(text)
        after_cells = []
        if context_mode == "edit":
            text = text + t["cell_after"]
            after_cells = t["cells_after"]
        if cfg["context"] == "cell":
            cells, active = [], -1
        else:
            cells = t["cells_before"] + [{"cellType": "code", "source": text}] + after_cells
            active = len(t["cells_before"])
        rows.append({
            "id": t["id"], "cells": cells, "activeIndex": active, "text": text,
            "offset": offset, "maxPrefixChars": cfg["maxPrefixChars"],
            "maxSuffixChars": cfg["maxSuffixChars"], "includeMarkdown": cfg["includeMarkdown"],
            "multiline": cfg["multiline"],
        })
    return node("prepare", rows)


async def _timed(gen, req, client):
    t0 = time.perf_counter()
    first, chunks, err = None, [], ""
    try:
        async for c in gen(req, client):
            if first is None:
                first = (time.perf_counter() - t0) * 1000
            chunks.append(c)
    except (backends.BackendError, httpx.HTTPError) as e:
        err = f"{type(e).__name__}: {e}"
    return "".join(chunks), first, (time.perf_counter() - t0) * 1000, err


async def generate(prompts: list[dict], cfg: dict, progress: bool, warm: bool) -> list[dict]:
    gen = backends.get_backend(cfg["backend"])
    out = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=3.0)) as client:
        for i, p in enumerate(prompts):
            req = backends.CompletionRequest.from_json({
                "prefix": p["prefix"], "suffix": p["suffix"], "backend": cfg["backend"],
                "base_url": cfg["base_url"], "model": cfg["model"], "template": cfg["template"],
                "multiline": p["multiline"],
                "max_tokens": cfg["maxTokens"] if p["multiline"] else cfg["maxTokensSingleLine"],
                "temperature": cfg["temperature"],
            })
            text, first, total, err = await _timed(gen, req, client)
            # Warm: the same prompt again. The KV/prompt cache now holds it, which is
            # what the next keystroke in the same notebook sees.
            wfirst = wtotal = None
            if warm and not err:
                _, wfirst, wtotal, _ = await _timed(gen, req, client)
            out.append({"id": p["id"], "completion": text, "prefix": p["prefix"],
                        "suffix": p["suffix"], "multiline": p["multiline"], "first_ms": first,
                        "total_ms": total, "warm_first_ms": wfirst, "warm_total_ms": wtotal,
                        "error": err, "model": req.model})
            if progress and (i + 1) % 25 == 0:
                print(f"    {cfg['name']}: {i + 1}/{len(prompts)}", file=sys.stderr)
    return out


def score(tasks: list[dict], gens: list[dict], post: list[dict]) -> list[dict]:
    by_task = {t["id"]: t for t in tasks}
    texts = {p["id"]: p["text"] for p in post}
    rows = []
    for g in gens:
        t = by_task[g["id"]]
        text = texts.get(g["id"], "")
        pred = text.split("\n", 1)[0].rstrip()
        # At a line start the model often emits the newline first; postprocess
        # keeps it in multi-line mode, so score the first non-empty line.
        if not pred and text.strip():
            pred = next(l for l in text.split("\n") if l.strip()).strip()
        target = t["target"]
        rows.append({
            "id": g["id"], "kind": t["kind"], "target": target, "pred": pred,
            "em": pred == target, "es": edit_sim(pred, target),
            "safe": bool(pred) and target.startswith(pred), "empty": not pred,
            "first_ms": g["first_ms"], "total_ms": g["total_ms"],
            "warm_first_ms": g["warm_first_ms"], "warm_total_ms": g["warm_total_ms"],
            "error": g["error"],
            "raw": g["completion"], "multiline": g["multiline"],
        })
    return rows


def summarize(rows: list[dict]) -> dict:
    n = len(rows)
    if not n:
        return {}
    firsts = [r["first_ms"] for r in rows if r["first_ms"] is not None]
    wfirsts = [r["warm_first_ms"] for r in rows if r["warm_first_ms"] is not None]
    wtotals = [r["warm_total_ms"] for r in rows if r["warm_total_ms"] is not None]
    return {
        "n": n,
        "EM": 100 * sum(r["em"] for r in rows) / n,
        "ES": 100 * statistics.mean(r["es"] for r in rows),
        "safe": 100 * sum(r["safe"] for r in rows) / n,
        "empty": 100 * sum(r["empty"] for r in rows) / n,
        "errors": sum(bool(r["error"]) for r in rows),
        "cold_first_p50": pct(firsts, 0.5),
        "warm_first_p50": pct(wfirsts, 0.5), "warm_first_p90": pct(wfirsts, 0.9),
        "warm_total_p50": pct(wtotals, 0.5),
    }


def reachable(cfg: dict) -> tuple[bool, str]:
    url = backends._v1(cfg["base_url"]) + "/models"
    try:
        r = httpx.get(url, timeout=2.0)
        ids = [m.get("id") for m in r.json().get("data", [])]
        return r.status_code == 200, ", ".join(map(str, ids))
    except (httpx.HTTPError, ValueError) as e:
        return False, str(e)


def table(results: dict[str, dict[str, dict]]) -> str:
    hdr = ("| config | kind | n | EM % | ES % | safe % | empty % | first token cold p50 "
           "| first token warm p50/p90 | total warm p50 | errors |")
    lines = [hdr, "|" + "---|" * 11]
    for name, by_kind in results.items():
        for kind, s in by_kind.items():
            if not s:
                continue
            lines.append(
                f"| {name} | {kind} | {s['n']} | {s['EM']:.1f} | {s['ES']:.1f} | {s['safe']:.1f} "
                f"| {s['empty']:.1f} | {s['cold_first_p50']:.0f} "
                f"| {s['warm_first_p50']:.0f} / {s['warm_first_p90']:.0f} "
                f"| {s['warm_total_p50']:.0f} | {s['errors']} |")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tasks", type=Path, default=HERE / "tasks.jsonl")
    ap.add_argument("--configs", type=Path, default=HERE / "configs.json")
    ap.add_argument("--only", default="", help="comma-separated config names")
    ap.add_argument("--limit", type=int, default=0, help="use only the first N tasks")
    ap.add_argument("--context-mode", choices=["write", "edit"], default="write",
                    help="write: nothing after the cursor exists yet (default); "
                         "edit: the rest of the cell and later cells are visible")
    ap.add_argument("--no-warm", action="store_true", help="skip the warm (cached) re-run")
    ap.add_argument("--out", type=Path, default=HERE / "results")
    args = ap.parse_args(argv)

    tasks = [json.loads(l) for l in args.tasks.read_text().splitlines() if l.strip()]
    if args.limit:
        tasks = tasks[: args.limit]
    configs = json.loads(args.configs.read_text())
    if args.only:
        wanted = set(args.only.split(","))
        configs = [c for c in configs if c["name"] in wanted]
    build_cli()

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    outdir = args.out / f"{stamp}-{args.context_mode}"
    outdir.mkdir(parents=True, exist_ok=True)
    results: dict[str, dict[str, dict]] = {}
    for c in configs:
        cfg = {**DEFAULTS, **c}
        ok, detail = reachable(cfg)
        if not ok:
            print(f"skip {cfg['name']}: {cfg['base_url']} unreachable ({detail[:80]})", file=sys.stderr)
            continue
        print(f"run  {cfg['name']} ({cfg['backend']} @ {cfg['base_url']}; models: {detail})",
              file=sys.stderr)
        prompts = prepare_rows(tasks, cfg, args.context_mode)
        gens = asyncio.run(generate(prompts, cfg, progress=True, warm=not args.no_warm))
        post = node("postprocess", [{k: g[k] for k in ("id", "completion", "prefix", "suffix",
                                                         "multiline")} for g in gens])
        rows = score(tasks, gens, post)
        with (outdir / f"{cfg['name']}.jsonl").open("w") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
        results[cfg["name"]] = {
            "all": summarize(rows),
            "mid": summarize([r for r in rows if r["kind"] == "mid"]),
            "start": summarize([r for r in rows if r["kind"] == "start"]),
        }
        s = results[cfg["name"]]["all"]
        print(f"     EM {s['EM']:.1f}%  ES {s['ES']:.1f}%  safe {s['safe']:.1f}%  "
              f"first token cold/warm p50 {s['cold_first_p50']:.0f}/{s['warm_first_p50']:.0f} ms",
              file=sys.stderr)

    md = (f"# jupyter_ai_autocomplete eval ({stamp}, context={args.context_mode}, "
          f"{len(tasks)} tasks)\n\n" + table(results) + "\n")
    (outdir / "summary.md").write_text(md)
    (outdir / "summary.json").write_text(json.dumps(results, indent=2))
    print(md)
    print(f"per-task results: {outdir}", file=sys.stderr)


if __name__ == "__main__":
    main()
