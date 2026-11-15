import { CommandRegistry } from '@lumino/commands';
import { Widget } from '@lumino/widgets';

import { IStatus, LLMInlineProvider } from './provider';

const LABELS: Record<IStatus['state'], string> = {
  idle: 'ready',
  loading: 'thinking…',
  error: 'error',
  disabled: 'off'
};

/**
 * Status-bar item: a dot plus "LLM" that shows idle / loading / error / off.
 * Click it to turn completions on or off. The tooltip shows the backend, the
 * model, the last latency, or the last error.
 */
export class AutocompStatus extends Widget {
  constructor(
    private _provider: LLMInlineProvider,
    private _commands: CommandRegistry,
    private _toggleCommand: string
  ) {
    super();
    this.addClass('jp-AutocompStatus');
    this.node.setAttribute('role', 'button');
    this.node.tabIndex = 0;
    this._dot = document.createElement('span');
    this._dot.className = 'jp-AutocompStatus-dot';
    this._label = document.createElement('span');
    this._label.className = 'jp-AutocompStatus-label';
    this.node.append(this._dot, this._label);

    this.node.addEventListener('click', this._toggle);
    this.node.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        this._toggle();
      }
    });
    _provider.statusChanged.connect(this._render, this);
    this._render();
  }

  dispose(): void {
    this._provider.statusChanged.disconnect(this._render, this);
    super.dispose();
  }

  private _toggle = (): void => {
    void this._commands.execute(this._toggleCommand);
  };

  private _render(): void {
    const st = this._provider.status;
    for (const s of Object.keys(LABELS)) {
      this.node.classList.toggle(`jp-mod-${s}`, s === st.state);
    }
    this._label.textContent = st.state === 'disabled' ? 'LLM off' : 'LLM';
    const parts = [`LLM autocomplete: ${LABELS[st.state]}`];
    parts.push(
      `backend: ${st.backend}` + (st.model ? ` · model: ${st.model}` : '')
    );
    if (st.lastMs !== undefined && st.state !== 'error') {
      parts.push(`last request: ${Math.round(st.lastMs)} ms`);
    }
    if (st.state === 'error' && st.message) {
      parts.push(`error: ${st.message}`);
    }
    parts.push(
      st.state === 'disabled' ? 'Click to enable.' : 'Click to disable.'
    );
    this.node.title = parts.join('\n');
  }

  private _dot: HTMLSpanElement;
  private _label: HTMLSpanElement;
}
