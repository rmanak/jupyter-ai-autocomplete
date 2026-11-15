import { expect, galata, test } from '@jupyterlab/galata';

/**
 * End-to-end tests against a live FIM-capable LLM.
 * Defaults to llama.cpp on :8080. Other servers:
 *   AUTOCOMP_BACKEND=ollama AUTOCOMP_BASE_URL=http://localhost:11434 npx playwright test
 *   AUTOCOMP_BACKEND=completions AUTOCOMP_BASE_URL=http://localhost:8002 npx playwright test  # vLLM
 */
const BACKEND = process.env.AUTOCOMP_BACKEND ?? 'infill';
const BASE: Record<string, any> = {
  backend: BACKEND,
  baseUrl: process.env.AUTOCOMP_BASE_URL ?? ''
};
const INLINE = '@jupyterlab/completer-extension:inline-completer';

/** Galata keeps settings in memory per test; seed our provider's settings. */
function withProvider(settings: Record<string, any>) {
  return {
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      [INLINE]: { providers: { 'jupyter-autocomp': { ...BASE, ...settings } } }
    }
  };
}

test.use({ autoGoto: false, ...withProvider({}) });

test('registers the provider', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', m => logs.push(m.text()));
  await page.goto();
  expect(
    logs.filter(s =>
      s.includes('jupyter_autocomp: inline completion provider registered')
    )
  ).toHaveLength(1);
});

test('ghost text appears and Tab accepts it', async ({ page }) => {
  await page.goto();
  await page.notebook.createNew('ghost.ipynb');
  await page.notebook.setCell(0, 'code', 'import numpy as np');
  await page.notebook.addCell('markdown', 'Compute the mean of the array `x`');
  await page.notebook.addCell('code', 'x = np.arange(10)\n');
  const editor = page.locator('.jp-Cell').nth(2).locator('.cm-content');
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('mean_x = ', { delay: 30 });

  const ghost = page.locator('.jp-GhostText');
  await expect(ghost).toBeVisible({ timeout: 15000 });
  const suggestion = (await ghost.innerText()).trim();
  expect(suggestion.length).toBeGreaterThan(0);

  await page.keyboard.press('Tab');
  await expect(ghost).toHaveCount(0);
  const src = await page.notebook.getCellTextInput(2);
  expect(src).toContain('mean_x = ' + suggestion.split('\n')[0]);
  console.log('accepted suggestion:', JSON.stringify(suggestion));
});

async function typeInNewNotebook(page: any, name: string) {
  await page.notebook.createNew(name);
  await page.notebook.setCell(0, 'code', 'import numpy as np');
  await page.notebook.addCell('code', 'x = np.arange(10)\n');
  await focusLastCellEnd(page);
  await page.keyboard.type('mean_x = ', { delay: 30 });
}

async function focusLastCellEnd(page: any) {
  await page.locator('.jp-Cell').last().locator('.cm-content').click();
  await page.keyboard.press('Control+End');
}

test('status item toggles completions off and on', async ({ page }) => {
  await page.goto();
  const status = page.locator('.jp-AutocompStatus');
  await expect(status).toHaveText('LLM');
  await status.click();
  await expect(status).toHaveText('LLM off');
  await expect(status).toHaveClass(/jp-mod-disabled/);

  await typeInNewNotebook(page, 'off.ipynb');
  await page.waitForTimeout(1500);
  await expect(page.locator('.jp-GhostText')).toHaveCount(0);

  await status.click();
  await expect(status).toHaveText('LLM');
  await focusLastCellEnd(page); // clicking the status bar took focus away
  await page.keyboard.type('n', { delay: 30 });
  await expect(page.locator('.jp-GhostText')).toBeVisible({ timeout: 15000 });
});

test.describe('unreachable server', () => {
  test.use(withProvider({ baseUrl: 'http://127.0.0.1:9' }));
  test('shows error state and a notification', async ({ page }) => {
    await page.goto();
    await typeInNewNotebook(page, 'err.ipynb');
    const status = page.locator('.jp-AutocompStatus');
    await expect(status).toHaveClass(/jp-mod-error/, { timeout: 15000 });
    await expect(page.locator('.Toastify__toast').first()).toContainText(
      'LLM autocomplete'
    );
  });
});

test.describe('completions backend', () => {
  test.skip(
    BACKEND === 'ollama',
    'Ollama /v1/completions applies a chat template; use the ollama backend'
  );
  test.use(withProvider({ backend: 'completions' }));
  test('/v1/completions + FIM template gives ghost text', async ({ page }) => {
    await page.goto();
    await typeInNewNotebook(page, 'compl.ipynb');
    await expect(page.locator('.jp-GhostText')).toBeVisible({
      timeout: 15000
    });
    const title = await page
      .locator('.jp-AutocompStatus')
      .getAttribute('title');
    expect(title).toContain('backend: completions');
    expect(title).toMatch(/model: \S+/);
  });
});

test('streams a multi-line suggestion and accepts all of it', async ({
  page
}) => {
  await page.goto();
  await page.notebook.createNew('stream.ipynb');
  await page.notebook.setCell(0, 'code', 'import numpy as np');
  await page.notebook.addCell(
    'markdown',
    'Define `normalize(v)` that returns v scaled to unit L2 norm'
  );
  await page.notebook.addCell('code', '');
  await focusLastCellEnd(page);
  await page.keyboard.type('def normalize(v):\n', { delay: 20 });
  const ghost = page.locator('.jp-GhostText');
  await expect(ghost).toBeVisible({ timeout: 15000 });
  // Wait until streaming finishes (the streaming indicator disappears).
  await expect(page.locator('.jp-GhostText-streamingIndicator')).toHaveCount(
    0,
    {
      timeout: 15000
    }
  );
  const suggestion = await ghost.innerText();
  expect(suggestion).toContain('return');
  await page.keyboard.press('Tab');
  const src = await page.notebook.getCellTextInput(2);
  expect(src).toContain('def normalize(v):');
  expect(src).toContain('return');
  console.log('streamed suggestion:', JSON.stringify(suggestion));
});

test.describe('chat backend', () => {
  test.use(withProvider({ backend: 'chat' }));
  test('/v1/chat/completions fallback gives ghost text', async ({ page }) => {
    await page.goto();
    await typeInNewNotebook(page, 'chat.ipynb');
    await expect(page.locator('.jp-GhostText')).toBeVisible({
      timeout: 20000
    });
  });
});
