/**
 * Post-processing of raw model output. These are ideas and small functions
 * ported from Continue (Apache-2.0), mainly
 * core/autocomplete/postprocessing/index.ts and
 * core/autocomplete/filtering/streamTransforms/lineStream.ts
 * https://github.com/continuedev/continue
 */

export interface IPostprocessInput {
  completion: string;
  prefix: string;
  suffix: string;
  multiline: boolean;
}

/** Same check as Continue's lineIsRepeated: lines equal once whitespace is ignored. */
export function lineIsRepeated(a: string, b: string): boolean {
  if (a.length <= 4 || b.length <= 4) {
    return false;
  }
  const aT = a.replace(/\s/g, '');
  const bT = b.replace(/\s/g, '');
  return aT === bT;
}

function firstNonEmptyLine(s: string): string | undefined {
  return s.split('\n').find(l => l.trim().length > 0);
}

function rewritesLineAbove(completion: string, prefix: string): boolean {
  const lines = prefix.split('\n');
  // The last prefix line is the one the cursor is on; skip it.
  const above = lines
    .slice(0, -1)
    .filter(l => l.trim().length > 0)
    .slice(-1)[0];
  const first = firstNonEmptyLine(completion);
  if (!above || !first) {
    return false;
  }
  return lineIsRepeated(above, first);
}

function isExtremeRepetition(completion: string): boolean {
  const lines = completion.split('\n').filter(l => l.trim());
  if (lines.length < 6) {
    return false;
  }
  const counts = new Map<string, number>();
  for (const l of lines) {
    counts.set(l.trim(), (counts.get(l.trim()) ?? 0) + 1);
  }
  const maxCount = Math.max(...counts.values());
  return maxCount / lines.length > 0.5 && maxCount >= 4;
}

function removeBackticks(completion: string): string {
  const lines = completion.split('\n');
  let start = 0;
  let end = lines.length;
  if (lines[0]?.trim().startsWith('```')) {
    start = 1;
  }
  if (end > start && /^`+$/.test(lines[end - 1].trim())) {
    end -= 1;
  }
  return lines.slice(start, end).join('\n');
}

/**
 * Cut the completion at the point where it starts reproducing text that
 * already follows the cursor. Matches Continue's stopAtStartOf(suffix),
 * stopAtLinesExact(lineBelowCursor), and stopAtSimilarLine.
 */
export function stopAtSuffix(completion: string, suffix: string): string {
  // Skip the rest of the cursor line (suffix line 0) and `# %%` cell markers.
  const below = suffix
    .split('\n')
    .slice(1)
    .find(l => l.trim().length > 0 && !l.trim().startsWith('# %%'));
  if (!below || below.trim().length < 3) {
    return completion;
  }
  const lines = completion.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && lines[i].trim() && lines[i].trim() === below.trim()) {
      return lines.slice(0, i).join('\n');
    }
  }
  return completion;
}

/** Stop at the first repeated line, or after a third consecutive blank line. */
export function stopAtRepeatingLines(completion: string): string {
  const lines = completion.split('\n');
  const out: string[] = [];
  let blanks = 0;
  for (const l of lines) {
    if (!l.trim()) {
      blanks += 1;
      if (blanks >= 2) {
        break;
      }
    } else {
      blanks = 0;
      const prev = out.filter(x => x.trim()).slice(-1)[0];
      if (prev !== undefined && lineIsRepeated(prev, l)) {
        break;
      }
    }
    out.push(l);
  }
  return out.join('\n');
}

export function postprocessCompletion(
  input: IPostprocessInput
): string | undefined {
  let c = input.completion;
  const { prefix, suffix } = input;

  // Reasoning models: drop <think> blocks.
  c = c.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<\/?think>/g, '');
  c = removeBackticks(c);

  if (!input.multiline) {
    const nl = c.indexOf('\n');
    if (nl >= 0) {
      // On a blank line the model sometimes opens with "\n": skip it.
      c = nl === 0 ? c.slice(1).split('\n')[0] : c.slice(0, nl);
    }
  } else {
    c = stopAtSuffix(c, suffix);
    c = stopAtRepeatingLines(c);
  }

  // Remove trailing whitespace and blank lines (they look like noise as ghost text).
  c = c.replace(/\s+$/, '');

  if (!c.trim()) {
    return undefined;
  }
  if (rewritesLineAbove(c, prefix)) {
    return undefined;
  }
  if (isExtremeRepetition(c)) {
    return undefined;
  }
  // Prefix already ends with a space: drop one leading space from the completion.
  if (prefix.endsWith(' ') && c.startsWith(' ') && !c.startsWith('  ')) {
    c = c.slice(1);
  }
  // Mid-line: don't suggest the text that already sits after the cursor.
  const lineSuffix = suffix.split('\n')[0];
  if (lineSuffix.trim() && c.endsWith(lineSuffix)) {
    c = c.slice(0, c.length - lineSuffix.length);
    if (!c.trim()) {
      return undefined;
    }
  }
  return c;
}
