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
import { ISignal, Signal } from '@lumino/signaling';

import { CompletionCache } from './cache';
import {
  buildFimContext,
  DEFAULT_CONTEXT_OPTIONS,
  ICellLike,
  shouldCompleteMultiline
} from './context';
import { postprocessCompletion } from './filters';
import { requestAPI } from './request';

export const PROVIDER_ID = 'jupyter-autocomp';

export type Backend = 'infill' | 'completions' | 'chat';

export interface IAutocompSettings {
  enabled: boolean;
  backend: Backend;
  baseUrl: string;
  model: string;
  template: string;
  maxTokens: number;
  maxTokensSingleLine: number;
  temperature: number;
  multiline: 'auto' | 'always' | 'never';
  maxPrefixChars: number;
  maxSuffixChars: number;
  includeMarkdown: boolean;
}

export const DEFAULT_SETTINGS: IAutocompSettings = {
  enabled: true,
  backend: 'infill',
  baseUrl: '',
  model: '',
  template: 'auto',
  maxTokens: 128,
  maxTokensSingleLine: 48,
  temperature: 0.01,
  multiline: 'auto',
  maxPrefixChars: DEFAULT_CONTEXT_OPTIONS.maxPrefixChars,
  maxSuffixChars: DEFAULT_CONTEXT_OPTIONS.maxSuffixChars,
  includeMarkdown: true
};

export type StatusState = 'idle' | 'loading' | 'error' | 'disabled';

export interface IStatus {
  state: StatusState;
  /** Error text when state is 'error'. */
  message?: string;
  /** Round-trip time of the last successful request, in ms. */
  lastMs?: number;
  backend: Backend;
  model: string;
}

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
  readonly identifier = PROVIDER_ID;
  readonly name = 'LLM autocomplete (jupyter_autocomp)';

  readonly schema: ISettingRegistry.IProperty = {
    default: {
      debouncerDelay: 250,
      timeout: 10000,
      autoFillInMiddle: true,
      ...DEFAULT_SETTINGS
    },
    properties: {
      backend: {
        title: 'Backend',
        description:
          'infill = llama.cpp native /infill (best for llama.cpp). completions = OpenAI /v1/completions with a FIM prompt (vLLM, Ollama, LM Studio, llama.cpp). chat = /v1/chat/completions fill-the-hole prompt, for chat-only models (slower).',
        type: 'string',
        enum: ['infill', 'completions', 'chat']
      },
      baseUrl: {
        title: 'Base URL',
        description:
          'LLM server URL, e.g. http://localhost:8080 (/v1 is added when the URL has no path). Empty = server default ($JUPYTER_AUTOCOMP_BASE_URL or http://localhost:8080). The Jupyter server sends the request, not the browser. Set the API key with $JUPYTER_AUTOCOMP_API_KEY on the server.',
        type: 'string'
      },
      model: {
        title: 'Model',
        description:
          'Model id. Empty = the first model the server lists at /v1/models.',
        type: 'string'
      },
      template: {
        title: 'FIM template (completions backend)',
        description:
          'auto = pick from the model name. Otherwise force a format.',
        type: 'string',
        enum: [
          'auto',
          'qwen',
          'starcoder',
          'deepseek',
          'codestral',
          'codellama',
          'codegemma',
          'granite'
        ]
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
  private _status: IStatus = {
    state: 'idle',
    backend: DEFAULT_SETTINGS.backend,
    model: ''
  };
  private _statusChanged = new Signal<this, IStatus>(this);
  private _errorOccurred = new Signal<this, string>(this);

  constructor(private _serverSettings: ServerConnection.ISettings) {}

  /** Emits whenever the status (idle/loading/error/disabled) changes. */
  get statusChanged(): ISignal<this, IStatus> {
    return this._statusChanged;
  }

  /** Emits once per *distinct* error message, so the UI can notify without spamming. */
  get errorOccurred(): ISignal<this, string> {
    return this._errorOccurred;
  }

  get status(): IStatus {
    return this._status;
  }

  get settings(): IAutocompSettings {
    return this._settings;
  }

  configure(settings: { [property: string]: JSONValue }): void {
    const prev = this._settings;
    this._settings = { ...DEFAULT_SETTINGS, ...(settings as any) };
    const s = this._settings;
    if (
      prev.backend !== s.backend ||
      prev.baseUrl !== s.baseUrl ||
      prev.model !== s.model ||
      prev.template !== s.template
    ) {
      // A different model gives different completions: drop the cache.
      this._cache = new CompletionCache();
      this._lastError = '';
    }
    this._setStatus({
      state: s.enabled ? 'idle' : 'disabled',
      message: undefined
    });
  }

  private _setStatus(patch: Partial<IStatus>): void {
    this._status = {
      ...this._status,
      backend: this._settings.backend,
      model: this._settings.model,
      ...patch
    };
    this._statusChanged.emit(this._status);
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
    this._setStatus({ state: 'loading' });

    try {
      const res = await requestAPI<{
        completion: string;
        ms: number;
        model?: string;
      }>('complete', this._serverSettings, {
        method: 'POST',
        signal: ac.signal,
        body: JSON.stringify({
          backend: s.backend,
          base_url: s.baseUrl,
          model: s.model,
          template: s.template,
          prefix: ctx.prefix,
          suffix: ctx.suffix,
          multiline,
          max_tokens: multiline ? s.maxTokens : s.maxTokensSingleLine,
          temperature: s.temperature
        })
      });
      if (ac.signal.aborted) {
        return { items: [] };
      }
      this._lastError = '';
      this._setStatus({
        state: 'idle',
        message: undefined,
        lastMs: res.ms,
        model: res.model || s.model
      });
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
      return { items: [{ insertText: completion }] };
    } catch (e: any) {
      if (ac.signal.aborted || e?.name === 'AbortError') {
        // A newer request owns the status now; leave it alone.
        return { items: [] };
      }
      const msg = String(e?.message ?? e);
      this._setStatus({ state: 'error', message: msg });
      if (msg !== this._lastError) {
        this._lastError = msg;
        console.warn('[jupyter_autocomp] completion failed:', msg);
        this._errorOccurred.emit(msg);
      }
      return { items: [] };
    } finally {
      if (this._inflight === ac) {
        this._inflight = null;
      }
    }
  }
}
