"""Build line-completion tasks from real notebooks.

Each task picks a line in a Python code cell and hides part of it:
  * ``mid``:   the cursor sits somewhere inside the line (the user typed part of it)
  * ``start``: the cursor sits after the indentation (the user just pressed Enter)
The hidden rest of the line is the target. The task records what comes before
and after it; ``run_eval.py`` decides how much of that the model gets to see.

    python eval/build_tasks.py ~/claude_workspace -o eval/tasks.jsonl
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

SKIP_DIRS = {".ipynb_checkpoints", "node_modules", "site-packages", ".venv", ".git",
             "ui-tests", "test-results"}


def notebooks(roots: list[Path]):
    for root in roots:
        for p in sorted(root.rglob("*.ipynb")):
            if SKIP_DIRS & set(p.parts):
                continue
            yield p


def load_cells(path: Path) -> list[dict] | None:
    try:
        nb = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    lang = (nb.get("metadata", {}).get("kernelspec", {}).get("language")
            or nb.get("metadata", {}).get("language_info", {}).get("name") or "python")
    if lang.lower() != "python":
        return None
    cells = []
    for c in nb.get("cells", []):
        src = c.get("source", "")
        src = "".join(src) if isinstance(src, list) else src
        cells.append({"cellType": c.get("cell_type", "code"), "source": src})
    return cells


def candidate_line(line: str) -> bool:
    s = line.strip()
    if len(s) < 8 or s.startswith(("#", "%", "!", '"""', "'''")):
        return False
    if all(ch in "()[]{}:,.;'\" " for ch in s):
        return False
    return True


def make_tasks(path: Path, cells: list[dict], rng: random.Random, per_nb: int, root: Path):
    options = []
    for ci, cell in enumerate(cells):
        if cell["cellType"] != "code":
            continue
        lines = cell["source"].split("\n")
        for li, line in enumerate(lines):
            if candidate_line(line):
                options.append((ci, li))
    rng.shuffle(options)
    for k, (ci, li) in enumerate(options[:per_nb]):
        lines = cells[ci]["source"].split("\n")
        line = lines[li]
        indent = len(line) - len(line.lstrip())
        kind = "start" if rng.random() < 0.3 else "mid"
        if kind == "start":
            cut = indent
        else:
            lo, hi = indent + 1, len(line.rstrip()) - 3
            if hi < lo:
                kind, cut = "start", indent
            else:
                cut = rng.randint(lo, hi)
        before_lines = "\n".join(lines[:li])
        cell_before = (before_lines + "\n" if li else "") + line[:cut]
        yield {
            "id": f"{path.relative_to(root)}::{ci}:{li}:{kind}",
            "notebook": str(path.relative_to(root)),
            "kind": kind,
            "cells_before": cells[:ci],
            "cell_before_cursor": cell_before,
            "target": line[cut:].rstrip(),
            "cell_after": "\n" + "\n".join(lines[li + 1:]) if li + 1 < len(lines) else "",
            "cells_after": cells[ci + 1:],
        }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("roots", nargs="+", type=Path)
    ap.add_argument("-o", "--out", type=Path, default=Path("eval/tasks.jsonl"))
    ap.add_argument("--per-notebook", type=int, default=8)
    ap.add_argument("--max-tasks", type=int, default=300)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)

    rng = random.Random(args.seed)
    tasks, n_nb = [], 0
    for root in args.roots:
        root = root.expanduser().resolve()
        for p in notebooks([root]):
            cells = load_cells(p)
            if not cells:
                continue
            got = list(make_tasks(p, cells, rng, args.per_notebook, root))
            n_nb += bool(got)
            tasks.extend(got)
    rng.shuffle(tasks)
    tasks = tasks[: args.max_tasks]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w") as f:
        for t in tasks:
            f.write(json.dumps(t) + "\n")
    kinds = {k: sum(t["kind"] == k for t in tasks) for k in ("mid", "start")}
    print(f"{len(tasks)} tasks from {n_nb} notebooks ({kinds}) -> {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
