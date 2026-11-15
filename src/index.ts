import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette, Notification } from '@jupyterlab/apputils';
import { ICompletionProviderManager } from '@jupyterlab/completer';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStatusBar } from '@jupyterlab/statusbar';
import { JSONObject } from '@lumino/coreutils';

import { LLMInlineProvider, PROVIDER_ID } from './provider';
import { AutocompStatus } from './status';

const INLINE_COMPLETER_PLUGIN =
  '@jupyterlab/completer-extension:inline-completer';
const TOGGLE_COMMAND = 'jupyter-autocomp:toggle';
const INVOKE_INLINE = 'inline-completer:invoke';

/**
 * JupyterLab skips automatic inline completion when only whitespace precedes
 * the cursor, which is always the case right after Enter. For those lines we
 * request a suggestion explicitly.
 */
function installNewLineTrigger(
  app: JupyterFrontEnd,
  provider: LLMInlineProvider
): void {
  let timer: number | undefined;
  document.addEventListener(
    'keyup',
    (ev: KeyboardEvent) => {
      const s = provider.settings;
      if (
        ev.key !== 'Enter' ||
        ev.shiftKey ||
        ev.ctrlKey ||
        ev.altKey ||
        ev.metaKey ||
        !s.enabled ||
        !s.triggerOnNewLine
      ) {
        return;
      }
      const target = ev.target as HTMLElement | null;
      if (!target?.closest('.cm-editor')) {
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (app.commands.hasCommand(INVOKE_INLINE)) {
          void app.commands.execute(INVOKE_INLINE);
        }
      }, s.debouncerDelay);
    },
    true
  );
}

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
  optional: [ISettingRegistry, IStatusBar, ICommandPalette],
  activate: (
    app: JupyterFrontEnd,
    manager: ICompletionProviderManager,
    settingRegistry: ISettingRegistry | null,
    statusBar: IStatusBar | null,
    palette: ICommandPalette | null
  ) => {
    const provider = new LLMInlineProvider(app.serviceManager.serverSettings);
    manager.registerInlineProvider(provider);

    // Enabled/disabled lives in the inline completer's own settings
    // (providers.<id>.enabled), so the toggle persists and matches the Settings Editor.
    app.commands.addCommand(TOGGLE_COMMAND, {
      label: () =>
        provider.settings.enabled
          ? 'Disable LLM Autocomplete'
          : 'Enable LLM Autocomplete',
      caption: 'Turn LLM ghost-text completions on or off',
      isToggled: () => provider.settings.enabled,
      isEnabled: () => settingRegistry !== null,
      describedBy: { args: { type: 'object', properties: {} } },
      execute: async () => {
        if (!settingRegistry) {
          return;
        }
        const settings = await settingRegistry.load(INLINE_COMPLETER_PLUGIN);
        const user = (settings.user.providers ?? {}) as JSONObject;
        const mine = (user[PROVIDER_ID] ?? {}) as JSONObject;
        await settings.set('providers', {
          ...user,
          [PROVIDER_ID]: { ...mine, enabled: !provider.settings.enabled }
        });
      }
    });
    palette?.addItem({ command: TOGGLE_COMMAND, category: 'Completer' });

    provider.errorOccurred.connect((_, message) => {
      Notification.warning(`LLM autocomplete: ${message}`, {
        autoClose: 8000
      });
    });

    installNewLineTrigger(app, provider);

    if (statusBar) {
      const item = new AutocompStatus(provider, app.commands, TOGGLE_COMMAND);
      statusBar.registerStatusItem('jupyter_autocomp:status', {
        item,
        align: 'left',
        rank: 100
      });
    }

    console.log('jupyter_autocomp: inline completion provider registered');
  }
};

export default plugin;
