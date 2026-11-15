import { expect, test } from '@jupyterlab/galata';

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
    logs.filter(s => s.includes('jupyter_autocomp: inline completion provider registered'))
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
