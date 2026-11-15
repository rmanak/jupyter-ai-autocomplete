import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICompletionProviderManager } from '@jupyterlab/completer';

import { LLMInlineProvider } from './provider';

/**
 * Registers an inline (ghost-text) completion provider backed by a local or
 * OpenAI-compatible LLM. Configure it in Settings → Inline Completer.
 * Tab accepts, Alt+[ / Alt+] cycle, Alt+\ requests a completion explicitly.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyter_autocomp:plugin',
  description:
    'Ghost-text inline code completion backed by local or OpenAI-compatible LLMs',
  autoStart: true,
  requires: [ICompletionProviderManager],
  activate: (app: JupyterFrontEnd, manager: ICompletionProviderManager) => {
    manager.registerInlineProvider(
      new LLMInlineProvider(app.serviceManager.serverSettings)
    );
    console.log('jupyter_autocomp: inline completion provider registered');
  }
};

export default plugin;
