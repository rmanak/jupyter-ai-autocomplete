/**
 * Turns a notebook into one FIM "file": a prefix and a suffix.
 *
 * Cells before the active cell, plus the active cell up to the cursor, form the
 * prefix. The rest of the active cell, plus the cells after it, form the suffix.
 * Markdown cells become `#` comments because they often state intent. Cells are
 * separated with `# %%` markers (the "percent" format), which code models have
 * seen a lot in training.
 */

export interface ICellLike {
  cellType: string; // 'code' | 'markdown' | 'raw'
  source: string;
}

export interface IContextOptions {
  maxPrefixChars: number;
  maxSuffixChars: number;
  includeMarkdown: boolean;
}

export interface IFimContext {
  prefix: string;
  suffix: string;
  /** Text of the current line before / after the cursor. */
  linePrefix: string;
  lineSuffix: string;
}

export const DEFAULT_CONTEXT_OPTIONS: IContextOptions = {
  maxPrefixChars: 12000,
  maxSuffixChars: 4000,
  includeMarkdown: true
};

export function renderCell(cell: ICellLike, includeMarkdown: boolean): string {
  if (cell.cellType === 'code') {
    return `# %%\n${cell.source}`;
  }
  if (cell.cellType === 'markdown' && includeMarkdown && cell.source.trim()) {
    const body = cell.source
      .trim()
      .split('\n')
      .map(l => (l ? `# ${l}` : '#'))
      .join('\n');
    return `# %% [markdown]\n${body}`;
  }
  return '';
}

/**
 * Keep whole cells, nearest first, until the budget runs out. The nearest
 * cell is always kept, but it gets cut at a line boundary if it alone goes
 * over budget.
 */
function packCells(
  rendered: string[],
  budget: number,
  fromEnd: boolean
): string {
  const order = fromEnd ? [...rendered].reverse() : rendered;
  const kept: string[] = [];
  let used = 0;
  for (const r of order) {
    if (!r) {
      continue;
    }
    if (used + r.length + 2 > budget) {
      if (kept.length === 0) {
        kept.push(truncateLines(r, budget, fromEnd));
      }
      break;
    }
    kept.push(r);
    used += r.length + 2;
  }
  if (fromEnd) {
    kept.reverse();
  }
  return kept.join('\n\n');
}

function truncateLines(text: string, budget: number, keepEnd: boolean): string {
  if (text.length <= budget) {
    return text;
  }
  if (keepEnd) {
    const cut = text.slice(text.length - budget);
    const nl = cut.indexOf('\n');
    return nl >= 0 ? cut.slice(nl + 1) : cut;
  }
  const cut = text.slice(0, budget);
  const nl = cut.lastIndexOf('\n');
  return nl >= 0 ? cut.slice(0, nl) : cut;
}

/**
 * @param cells all notebook cells; `activeIndex` is the one being edited (may
 *   be -1 when the widget is not a notebook, e.g. console or file editor)
 * @param text current editor text (the live text of the active cell)
 * @param offset cursor offset within `text`
 */
export function buildFimContext(
  cells: ICellLike[],
  activeIndex: number,
  text: string,
  offset: number,
  opts: IContextOptions = DEFAULT_CONTEXT_OPTIONS
): IFimContext {
  const before = text.slice(0, offset);
  const after = text.slice(offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEndRel = after.indexOf('\n');
  const linePrefix = before.slice(lineStart);
  const lineSuffix = lineEndRel >= 0 ? after.slice(0, lineEndRel) : after;

  if (activeIndex < 0) {
    return {
      prefix: truncateLines(before, opts.maxPrefixChars, true),
      suffix: truncateLines(after, opts.maxSuffixChars, false),
      linePrefix,
      lineSuffix
    };
  }

  const head = `# %%\n${before}`;
  const prevRendered = cells
    .slice(0, activeIndex)
    .map(c => renderCell(c, opts.includeMarkdown));
  const prevBudget = Math.max(0, opts.maxPrefixChars - head.length);
  const prevText = packCells(prevRendered, prevBudget, true);
  const prefix =
    (prevText ? prevText + '\n\n' : '') +
    truncateLines(head, opts.maxPrefixChars, true);

  const nextRendered = cells
    .slice(activeIndex + 1)
    .map(c => renderCell(c, opts.includeMarkdown));
  const nextBudget = Math.max(0, opts.maxSuffixChars - after.length);
  const nextText = packCells(nextRendered, nextBudget, false);
  const suffix =
    truncateLines(after, opts.maxSuffixChars, false) +
    (nextText ? '\n\n' + nextText : '');

  return { prefix, suffix, linePrefix, lineSuffix };
}

/**
 * Port of Continue's shouldCompleteMultiline (simplified for notebooks).
 * Use single-line when typing mid-line or inside a `#` comment.
 */
export function shouldCompleteMultiline(
  ctx: IFimContext,
  mode: 'auto' | 'always' | 'never'
): boolean {
  if (mode === 'always') {
    return true;
  }
  if (mode === 'never') {
    return false;
  }
  if (ctx.lineSuffix.trim().length > 0) {
    return false;
  }
  if (ctx.linePrefix.replace(/^\s+/, '').startsWith('#')) {
    return false;
  }
  return true;
}
