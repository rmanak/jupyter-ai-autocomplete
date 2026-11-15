import { buildFimContext, shouldCompleteMultiline } from '../context';
import { postprocessCompletion, stopAtSuffix } from '../filters';
import { CompletionCache } from '../cache';

const cells = [
  { cellType: 'code', source: 'import numpy as np' },
  { cellType: 'markdown', source: '## Compute the mean' },
  { cellType: 'code', source: 'x = np.arange(10)\nm = ' },
  { cellType: 'code', source: 'print(m)' }
];

describe('buildFimContext', () => {
  it('puts previous cells and markdown-as-comments into the prefix', () => {
    const text = cells[2].source;
    const ctx = buildFimContext(cells, 2, text, text.length);
    expect(ctx.prefix).toBe(
      '# %%\nimport numpy as np\n\n# %% [markdown]\n# ## Compute the mean\n\n# %%\nx = np.arange(10)\nm = '
    );
    expect(ctx.suffix).toBe('\n\n# %%\nprint(m)');
    expect(ctx.linePrefix).toBe('m = ');
    expect(ctx.lineSuffix).toBe('');
  });

  it('drops farthest cells first when over budget', () => {
    const text = cells[2].source;
    const ctx = buildFimContext(cells, 2, text, text.length, {
      maxPrefixChars: 70,
      maxSuffixChars: 100,
      includeMarkdown: true
    });
    expect(ctx.prefix).not.toContain('import numpy');
    expect(ctx.prefix).toContain('Compute the mean');
    expect(ctx.prefix.endsWith('m = ')).toBe(true);
  });

  it('works without a notebook (console/file editor)', () => {
    const ctx = buildFimContext([], -1, 'abc\ndef', 5);
    expect(ctx.prefix).toBe('abc\nd');
    expect(ctx.suffix).toBe('ef');
    expect(ctx.lineSuffix).toBe('ef');
  });
});

describe('shouldCompleteMultiline', () => {
  it('is single-line mid-line or in comments', () => {
    expect(
      shouldCompleteMultiline(buildFimContext([], -1, 'f(x)', 2), 'auto')
    ).toBe(false);
    expect(
      shouldCompleteMultiline(buildFimContext([], -1, '  # plot ', 9), 'auto')
    ).toBe(false);
    expect(
      shouldCompleteMultiline(buildFimContext([], -1, 'def f():\n', 9), 'auto')
    ).toBe(true);
  });
});

describe('postprocessCompletion', () => {
  const base = { prefix: 'x = 1\n', suffix: '', multiline: true };
  it('drops blank and think-only output', () => {
    expect(
      postprocessCompletion({ ...base, completion: '  \n ' })
    ).toBeUndefined();
    expect(
      postprocessCompletion({ ...base, completion: '<think>hmm</think>\n' })
    ).toBeUndefined();
  });
  it('strips code fences', () => {
    expect(
      postprocessCompletion({ ...base, completion: '```python\ny = 2\n```' })
    ).toBe('y = 2');
  });
  it('rejects rewriting the line above', () => {
    expect(
      postprocessCompletion({
        prefix: 'total = a + b\n',
        suffix: '',
        multiline: true,
        completion: 'total = a + b'
      })
    ).toBeUndefined();
  });
  it('truncates single-line to the first line', () => {
    expect(
      postprocessCompletion({
        ...base,
        multiline: false,
        completion: 'np.mean(x)\nprint(1)'
      })
    ).toBe('np.mean(x)');
  });
  it('stops when reproducing the suffix', () => {
    expect(
      stopAtSuffix('a = 1\nb = 2\nprint(m)\nc', '\n\n# %%\nprint(m)')
    ).toBe('a = 1\nb = 2');
  });
  it('removes duplicated mid-line suffix', () => {
    expect(
      postprocessCompletion({
        prefix: 'print(',
        suffix: ')\nfoo',
        multiline: false,
        completion: 'x.mean())'
      })
    ).toBe('x.mean()');
  });
  it('stops at repeated lines', () => {
    const c = 'a = foo(1)\nb = bar(2)\nb = bar(2)\nb = bar(2)';
    expect(postprocessCompletion({ ...base, completion: c })).toBe(
      'a = foo(1)\nb = bar(2)'
    );
  });
});

describe('CompletionCache', () => {
  it('serves exact hits and type-through remainders', () => {
    const c = new CompletionCache();
    c.put('m = ', '', 'np.mean(x)');
    expect(c.get('m = ', '')).toBe('np.mean(x)');
    expect(c.get('m = np.', '')).toBe('mean(x)');
    expect(c.get('m = nq', '')).toBeUndefined();
    expect(c.get('m = np.', 'other')).toBeUndefined();
  });
});

describe('cell markers', () => {
  const base = { prefix: 'df = load()\n', suffix: '', multiline: true };
  it('drops a leading code-cell marker and keeps the code', () => {
    expect(
      postprocessCompletion({
        ...base,
        completion: '\n# %%\nsummary = df.describe()\n\n# %%\nprint(1)'
      })
    ).toBe('summary = df.describe()');
  });
  it('a leading markdown marker yields nothing', () => {
    expect(
      postprocessCompletion({ ...base, completion: '# %% [markdown]\n# Title' })
    ).toBeUndefined();
  });
});
