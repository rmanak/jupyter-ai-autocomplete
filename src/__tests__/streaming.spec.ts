import { readSSE, shouldStopEarly } from '../streaming';

function responseFrom(chunks: string[]): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = {
    getReader: () => ({
      read: async () =>
        i < chunks.length
          ? { value: enc.encode(chunks[i++]), done: false }
          : { value: undefined, done: true }
    })
  };
  return { body } as unknown as Response;
}

describe('readSSE', () => {
  it('parses events split across chunk boundaries', async () => {
    const r = responseFrom([
      'data: {"text":"np."}\n\ndata: {"te',
      'xt":"mean"}\n',
      '\ndata: {"done":true,"model":"m"}\n\n'
    ]);
    const out = [];
    for await (const ev of readSSE(r)) {
      out.push(ev);
    }
    expect(out).toEqual([
      { text: 'np.' },
      { text: 'mean' },
      { done: true, model: 'm' }
    ]);
  });
});

describe('shouldStopEarly', () => {
  it('stops single-line at the first line break', () => {
    expect(shouldStopEarly('np.mean(x)', '', false)).toBe(false);
    expect(shouldStopEarly('\nnp.mean(x)', '', false)).toBe(false);
    expect(shouldStopEarly('np.mean(x)\npr', '', false)).toBe(true);
  });
  it('stops multi-line when reproducing the code below', () => {
    expect(shouldStopEarly('a = 1\nb = 2\n', '\n# %%\nprint(m)', true)).toBe(
      false
    );
    expect(
      shouldStopEarly('a = 1\nb = 2\nprint(m)\n', '\n# %%\nprint(m)', true)
    ).toBe(true);
  });
});

describe('shouldStopEarly with cell markers', () => {
  it('ignores a leading marker but stops at the next one', () => {
    expect(shouldStopEarly('\n# %%\nsummary = df.describe()\n', '', true)).toBe(
      false
    );
    expect(shouldStopEarly('\n# %%\nsummary = 1\n\n# %%\npr', '', true)).toBe(
      true
    );
    expect(shouldStopEarly('\n# %%\nsummary = 1', '', false)).toBe(false);
  });
});
