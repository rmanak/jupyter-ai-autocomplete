import {
  CompletionHandler,
  IInlineCompletionContext,
  IInlineCompletionItem,
  IInlineCompletionList,
  IInlineCompletionProvider
} from '@jupyterlab/completer';
import { ServerConnection } from '@jupyterlab/services';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { JSONValue } from '@lumino/coreutils';

import { CompletionCache } from './cache';
import {
  buildFimContext,
  DEFAULT_CONTEXT_OPTIONS,
  ICellLike,
  shouldCompleteMultiline
} from './context';
import { postprocessCompletion } from './filters';
import { requestAPI } from './request';

export interface IAutocompSettings {
  backend: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  maxTokensSingleLine: number;
  temperature: number;
  multiline: 'auto' | 'always' | 'never';
  maxPrefixChars: number;
  maxSuffixChars: number;
  includeMarkdown: boolean;
}

export const DEFAULT_SETTINGS: IAutocompSettings = {
  backend: 'infill',
  baseUrl: '',
  model: '',
  maxTokens: 128,
  maxTokensSingleLine: 48,
  temperature: 0.01,
  multiline: 'auto',
  maxPrefixChars: DEFAULT_CONTEXT_OPTIONS.maxPrefixChars,
  maxSuffixChars: DEFAULT_CONTEXT_OPTIONS.maxSuffixChars,
  includeMarkdown: true
};

/** Get notebook cells from a NotebookPanel-like widget (duck-typed so it also works in Notebook 7). */
function notebookCells(
  widget: any,
  text: string
): { cells: ICellLike[]; activeIndex: number } {
  const notebook = widget?.content;
  const cellWidgets: any[] | undefined = notebook?.widgets;
  if (!cellWidgets || typeof notebook.activeCellIndex !== 'number') {
    return { cells: [], activeIndex: -1 };
  }
  const cells: ICellLike[] = cellWidgets.map(c => ({
    cellType: c.model.type,
    source: c.model.sharedModel.getSource()
  }));
  let activeIndex = notebook.activeCellIndex;
  if (cells[activeIndex]?.source !== text) {
    activeIndex = cells.findIndex(c => c.source === text);
  }
  return { cells, activeIndex };
}

export class LLMInlineProvider implements IInlineCompletionProvider {
  readonly identifier = 'jupyter-autocomp';
  readonly name = 'LLM autocomplete (jupyter_autocomp)';

  readonly schema: ISettingRegistry.IProperty = {
    default: {
      enabled: true,
      debouncerDelay: 250,
      timeout: 10000,
      autoFillInMiddle: true,
      ...DEFAULT_SETTINGS
    },
    properties: {
      backend: {
        title: 'Backend',
        description:
          'infill = llama.cpp native /infill (fill-in-the-middle). More backends in later versions.',
        type: 'string',
        enum: ['infill']
      },
      baseUrl: {
        title: 'Base URL',
        description:
          'LLM server URL, e.g. http://localhost:8080 (a trailing /v1 is fine). Empty = server default ($JUPYTER_AUTOCOMP_BASE_URL or http://localhost:8080). The Jupyter server makes the request, not the browser.',
        type: 'string'
      },
      model: {
        title: 'Model',
        description:
          'Model id to request (optional for single-model llama.cpp servers).',
        type: 'string'
      },
      maxTokens: {
        title: 'Max tokens (multi-line)',
        type: 'number',
        minimum: 1
      },
      maxTokensSingleLine: {
        title: 'Max tokens (single-line)',
        type: 'number',
        minimum: 1
      },
      temperature: { title: 'Temperature', type: 'number', minimum: 0 },
      multiline: {
        title: 'Multi-line completions',
        description:
          'auto = single line when mid-line or in a comment, multi-line otherwise.',
        type: 'string',
        enum: ['auto', 'always', 'never']
      },
      maxPrefixChars: {
        title: 'Max context before cursor (chars)',
        type: 'number',
        minimum: 100
      },
      maxSuffixChars: {
        title: 'Max context after cursor (chars)',
        type: 'number',
        minimum: 0
      },
      includeMarkdown: {
        title: 'Include markdown cells as comments',
        type: 'boolean'
      }
    }
  };

  private _settings: IAutocompSettings = { ...DEFAULT_SETTINGS };
  private _cache = new CompletionCache();
  private _inflight: AbortController | null = null;
  private _lastError = '';

  constructor(private _serverSettings: ServerConnection.ISettings) {}

  configure(settings: { [property: string]: JSONValue }): void {
    this._settings = { ...DEFAULT_SETTINGS, ...(settings as any) };
  }

  async fetch(
    request: CompletionHandler.IRequest,
    context: IInlineCompletionContext
  ): Promise<IInlineCompletionList<IInlineCompletionItem>> {
    const s = this._settings;
    const { cells, activeIndex } = notebookCells(context.widget, request.text);
    const ctx = buildFimContext(
      cells,
      activeIndex,
      request.text,
      request.offset,
      {
        maxPrefixChars: s.maxPrefixChars,
        maxSuffixChars: s.maxSuffixChars,
        includeMarkdown: s.includeMarkdown
      }
    );
    const multiline = shouldCompleteMultiline(ctx, s.multiline);

    const cached = this._cache.get(ctx.prefix, ctx.suffix);
    if (cached) {
      return { items: [{ insertText: cached }] };
    }

    // Abort the previous request: the user kept typing, so it's stale. The server
    // then cancels the upstream generation too.
    this._inflight?.abort();
    const ac = new AbortController();
    this._inflight = ac;

    try {
      const res = await requestAPI<{ completion: string; ms: number }>(
        'complete',
        this._serverSettings,
        {
          method: 'POST',
          signal: ac.signal,
          body: JSON.stringify({
            backend: s.backend,
            base_url: s.baseUrl,
            model: s.model,
            prefix: ctx.prefix,
            suffix: ctx.suffix,
            multiline,
            max_tokens: multiline ? s.maxTokens : s.maxTokensSingleLine,
            temperature: s.temperature
          })
        }
      );
      if (ac.signal.aborted) {
        return { items: [] };
      }
      const completion = postprocessCompletion({
        completion: res.completion,
        prefix: ctx.prefix,
        suffix: ctx.suffix,
        multiline
      });
      if (!completion) {
        return { items: [] };
      }
      this._cache.put(ctx.prefix, ctx.suffix, completion);
      this._lastError = '';
      return { items: [{ insertText: completion }] };
    } catch (e: any) {
      if (ac.signal.aborted || e?.name === 'AbortError') {
        return { items: [] };
      }
      const msg = String(e?.message ?? e);
      if (msg !== this._lastError) {
        // Log each distinct error once, not on every keystroke.
        console.warn('[jupyter_autocomp] completion failed:', msg);
        this._lastError = msg;
      }
      return { items: [] };
    } finally {
      if (this._inflight === ac) {
        this._inflight = null;
      }
    }
  }
}
