import { LLMInlineProvider } from '../provider';

describe('provider status', () => {
  it('tracks enabled/disabled through configure()', () => {
    const p = new LLMInlineProvider({} as any);
    const seen: string[] = [];
    p.statusChanged.connect((_, s) => seen.push(s.state));
    p.configure({ enabled: false });
    p.configure({ enabled: true, backend: 'completions', model: 'm' });
    expect(seen).toEqual(['disabled', 'idle']);
    expect(p.status.backend).toBe('completions');
    expect(p.status.model).toBe('m');
  });
});
