import { expect, galata, test } from '@jupyterlab/galata';

/**
 * End-to-end test: typing in a notebook cell shows LLM ghost text and Tab
 * accepts it. Needs a live FIM-capable LLM at $JUPYTER_AUTOCOMP_BASE_URL
 * (default http://localhost:8080).
 */
test.use({ autoGoto: false });

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

const INLINE = '@jupyterlab/completer-extension:inline-completer';

/** Galata keeps settings in memory per test; seed our provider's settings. */
function withProvider(settings: Record<string, any>) {
  return {
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      [INLINE]: { providers: { 'jupyter-autocomp': settings } }
    }
  };
}

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
    expect(title).toContain('model: qwen3-coder');
  });
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
