import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

import {
  postprocessCompletion,
  stopAtRepeatingLines,
  stopAtSuffix
} from './filters';

export interface IStreamEvent {
  text?: string;
  done?: boolean;
  error?: string;
  model?: string;
  ms?: number;
}

/** Parse Server-Sent Events from a fetch Response body. */
export async function* readSSE(
  response: Response
): AsyncGenerator<IStreamEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) {
          try {
            yield JSON.parse(line.slice(5).trim());
          } catch {
            // ignore malformed lines
          }
        }
      }
    }
  }
}

/**
 * Whether the raw stream so far has gone where we'd cut it anyway, so we can
 * stop generating early. This is Continue's "fullStop" idea. The checks:
 * single-line mode reaching a line break, the output repeating the code below
 * the cursor, or repeated lines.
 */
export function shouldStopEarly(
  raw: string,
  suffix: string,
  multiline: boolean
): boolean {
  if (!multiline) {
    return raw.replace(/^\n/, '').includes('\n');
  }
  const cut = stopAtRepeatingLines(stopAtSuffix(raw, suffix));
  return cut.replace(/\s+$/, '').length < raw.replace(/\s+$/, '').length;
}

/**
 * One streaming completion request. Several inline-completion items can read
 * from it: when the user types characters that match the text being streamed,
 * the provider keeps reading this session instead of starting a new request.
 */
export class StreamSession {
  raw = '';
  done = false;
  error: string | null = null;
  model = '';
  /** True when abort() was called (superseded), as opposed to an early stop. */
  cancelled = false;
  /** ms from start to the first displayable text, and to the end. */
  firstMs: number | undefined;
  totalMs: number | undefined;

  constructor(
    readonly prefix: string,
    readonly suffix: string,
    readonly multiline: boolean,
    private _onFinish: (session: StreamSession) => void
  ) {}

  /** The post-processed text so far ('' if nothing displayable yet). */
  get text(): string {
    return (
      postprocessCompletion({
        completion: this.raw,
        prefix: this.prefix,
        suffix: this.suffix,
        multiline: this.multiline
      }) ?? ''
    );
  }

  get aborted(): boolean {
    return this._controller.signal.aborted;
  }

  abort(): void {
    this.cancelled = true;
    this._controller.abort();
    this._finish();
  }

  start(
    serverSettings: ServerConnection.ISettings,
    body: Record<string, unknown>
  ): void {
    void this._run(serverSettings, body);
  }

  /** Resolves on the next change (new text, done, error). */
  changed(): Promise<void> {
    if (this.done) {
      return Promise.resolve();
    }
    return new Promise(resolve => this._waiters.push(resolve));
  }

  private _notify(): void {
    const w = this._waiters;
    this._waiters = [];
    w.forEach(r => r());
  }

  private _finish(): void {
    if (!this.done) {
      this.done = true;
      this.totalMs = performance.now() - this._t0;
      this._onFinish(this);
    }
    this._notify();
  }

  private async _run(
    serverSettings: ServerConnection.ISettings,
    body: Record<string, unknown>
  ): Promise<void> {
    const url = URLExt.join(
      serverSettings.baseUrl,
      'jupyter-autocomp',
      'stream'
    );
    try {
      const response = await ServerConnection.makeRequest(
        url,
        {
          method: 'POST',
          body: JSON.stringify(body),
          signal: this._controller.signal
        },
        serverSettings
      );
      if (!response.ok) {
        const t = await response.text();
        throw new Error(`HTTP ${response.status}: ${t.slice(0, 300)}`);
      }
      for await (const ev of readSSE(response)) {
        if (ev.text) {
          this.raw += ev.text;
          if (shouldStopEarly(this.raw, this.suffix, this.multiline)) {
            // We'd cut the rest anyway; free the LLM slot now.
            this._controller.abort();
            break;
          }
          if (this.firstMs === undefined && this.text) {
            this.firstMs = performance.now() - this._t0;
          }
          this._notify();
        } else if (ev.error) {
          this.error = ev.error;
          break;
        } else if (ev.done) {
          this.model = ev.model ?? '';
          break;
        }
      }
    } catch (e: any) {
      if (!this.aborted) {
        this.error = String(e?.message ?? e);
      }
    }
    this._finish();
  }

  private _t0 = performance.now();
  private _controller = new AbortController();
  private _waiters: Array<() => void> = [];
}
