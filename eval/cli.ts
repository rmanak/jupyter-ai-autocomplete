/**
 * Batch bridge to the frontend's exact prompt-building and post-processing
 * code, so the eval measures what users get in JupyterLab.
 *
 *   node eval/.build/eval/cli.js prepare     < in.jsonl > out.jsonl
 *   node eval/.build/eval/cli.js postprocess < in.jsonl > out.jsonl
 *
 * Built by run_eval.py with tsc (CommonJS).
 */
import * as fs from 'fs';

import {
  buildFimContext,
  ICellLike,
  shouldCompleteMultiline
} from '../src/context';
import { postprocessCompletion } from '../src/filters';

interface IPrepareIn {
  id: string;
  cells: ICellLike[];
  activeIndex: number;
  text: string;
  offset: number;
  maxPrefixChars: number;
  maxSuffixChars: number;
  includeMarkdown: boolean;
  multiline: 'auto' | 'always' | 'never';
}

interface IPostIn {
  id: string;
  completion: string;
  prefix: string;
  suffix: string;
  multiline: boolean;
}

const mode = process.argv[2];
const lines = fs
  .readFileSync(0, 'utf8')
  .split('\n')
  .filter(l => l.trim());
const out: string[] = [];
for (const line of lines) {
  if (mode === 'prepare') {
    const t = JSON.parse(line) as IPrepareIn;
    const ctx = buildFimContext(t.cells, t.activeIndex, t.text, t.offset, {
      maxPrefixChars: t.maxPrefixChars,
      maxSuffixChars: t.maxSuffixChars,
      includeMarkdown: t.includeMarkdown
    });
    out.push(
      JSON.stringify({
        id: t.id,
        prefix: ctx.prefix,
        suffix: ctx.suffix,
        multiline: shouldCompleteMultiline(ctx, t.multiline)
      })
    );
  } else if (mode === 'postprocess') {
    const t = JSON.parse(line) as IPostIn;
    out.push(
      JSON.stringify({ id: t.id, text: postprocessCompletion(t) ?? '' })
    );
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
}
process.stdout.write(out.join('\n') + (out.length ? '\n' : ''));
