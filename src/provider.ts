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
import { StreamSession } from './streaming';

export const PROVIDER_ID = 'jupyter-ai-autocomplete';

export type Backend = 'infill' | 'completions' | 'ollama' | 'chat';

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
  triggerOnNewLine: boolean;
  debouncerDelay: number;
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
  includeMarkdown: true,
  triggerOnNewLine: true,
  debouncerDelay: 250
};

export type StatusState = 'idle' | 'loading' | 'error' | 'disabled';

export interface IStatus {
  state: StatusState;
  /** Error text when state is 'error'. */
  message?: string;
  /** Time to the first visible text of the last request, in ms. */
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
  readonly name = 'LLM autocomplete (jupyter_ai_autocomplete)';

  readonly schema: ISettingRegistry.IProperty = {
    default: {
      timeout: 10000,
      autoFillInMiddle: true,
      ...DEFAULT_SETTINGS
    },
    properties: {
      backend: {
        title: 'Backend',
        description:
          'infill = llama.cpp native /infill (best for llama.cpp). completions = OpenAI /v1/completions with a FIM prompt: vLLM (e.g. http://localhost:8001), LM Studio, llama.cpp. ollama = Ollama /api/generate raw FIM (use base URL http://localhost:11434). chat = /v1/chat/completions fill-the-hole prompt, for chat-only models (slower).',
        type: 'string',
        enum: ['infill', 'completions', 'ollama', 'chat']
      },
      baseUrl: {
        title: 'Base URL',
        description:
          'LLM server URL, e.g. http://localhost:8080 (/v1 is added when the URL has no path). Empty = server default ($JUPYTER_AI_AUTOCOMPLETE_BASE_URL or http://localhost:8080). The Jupyter server sends the request, not the browser. Set the API key with $JUPYTER_AI_AUTOCOMPLETE_API_KEY on the server.',
        type: 'string'
      },
      model: {
        title: 'Model',
        description:
          'Model id. Empty = the first model the server lists at /v1/models.',
        type: 'string'
      },
      template: {
        title: 'FIM template (completions/ollama backends)',
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
      },
      triggerOnNewLine: {
        title: 'Suggest on new lines',
        description:
          'JupyterLab does not auto-trigger when only whitespace precedes the cursor (e.g. right after Enter). When on, pressing Enter requests a suggestion explicitly, like Continue/Copilot do.',
        type: 'boolean'
      }
    }
  };

  private _settings: IAutocompSettings = { ...DEFAULT_SETTINGS };
  private _cache = new CompletionCache();
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

    // Type-through: the user is typing exactly what the running stream predicted,
    // so keep reading it instead of starting over (Continue's GeneratorReuseManager).
    const prev = this._session;
    if (
      prev &&
      !prev.cancelled &&
      !prev.done &&
      prev.multiline === multiline &&
      prev.suffix === ctx.suffix &&
      ctx.prefix.startsWith(prev.prefix)
    ) {
      const typed = ctx.prefix.slice(prev.prefix.length);
      if (prev.text.startsWith(typed) && prev.text.length > typed.length) {
        return this._item(prev, typed.length);
      }
    }

    // Supersede the previous request: aborting it closes the server stream, and
    // the server then cancels the upstream generation.
    prev?.abort();
    const session = new StreamSession(ctx.prefix, ctx.suffix, multiline, sess =>
      this._onSessionFinished(sess)
    );
    this._session = session;
    this._setStatus({ state: 'loading' });
    session.start(this._serverSettings, {
      backend: s.backend,
      base_url: s.baseUrl,
      model: s.model,
      template: s.template,
      prefix: ctx.prefix,
      suffix: ctx.suffix,
      multiline,
      max_tokens: multiline ? s.maxTokens : s.maxTokensSingleLine,
      temperature: s.temperature
    });

    // Return as soon as there's something to show; stream() delivers the rest.
    while (!session.done && !session.text) {
      await session.changed();
    }
    if (!session.text) {
      return { items: [] };
    }
    return this._item(session, 0);
  }

  /**
   * Called by JupyterLab for items with isIncomplete=true. Yields the full
   * (cumulative) insertText each time the session gets new text.
   */
  async *stream(
    token: string
  ): AsyncGenerator<{ response: IInlineCompletionItem }, undefined, unknown> {
    const entry = this._streams.get(token);
    if (!entry) {
      return;
    }
    const { session, skip } = entry;
    try {
      let last = session.text.slice(skip);
      while (!session.done) {
        await session.changed();
        const text = session.text.slice(skip);
        if (text !== last) {
          last = text;
          yield { response: { insertText: text, isIncomplete: !session.done } };
        }
      }
      yield { response: { insertText: last, isIncomplete: false } };
    } finally {
      this._streams.delete(token);
    }
  }

  private _item(
    session: StreamSession,
    skip: number
  ): IInlineCompletionList<IInlineCompletionItem> {
    const insertText = session.text.slice(skip);
    if (session.done) {
      return { items: [{ insertText }] };
    }
    const token = `jupyter-ai-autocomplete-${++this._tokenCounter}`;
    this._streams.set(token, { session, skip });
    return { items: [{ insertText, isIncomplete: true, token }] };
  }

  private _onSessionFinished(session: StreamSession): void {
    if (session.cancelled) {
      return; // superseded; the newer session owns the status
    }
    if (session.error) {
      const msg = session.error;
      this._setStatus({ state: 'error', message: msg });
      if (msg !== this._lastError) {
        this._lastError = msg;
        console.warn('[jupyter_ai_autocomplete] completion failed:', msg);
        this._errorOccurred.emit(msg);
      }
      return;
    }
    this._lastError = '';
    this._setStatus({
      state: 'idle',
      message: undefined,
      lastMs: session.firstMs ?? session.totalMs,
      model: session.model || this._settings.model
    });
    const text = session.text;
    if (text) {
      this._cache.put(session.prefix, session.suffix, text);
    }
  }

  private _session: StreamSession | null = null;
  private _streams = new Map<
    string,
    { session: StreamSession; skip: number }
  >();
  private _tokenCounter = 0;
}
