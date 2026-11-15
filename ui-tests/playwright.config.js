/**
 * Configuration for Playwright using default from @jupyterlab/galata
 */
const baseConfig = require('@jupyterlab/galata/lib/playwright-config');

module.exports = {
  ...baseConfig,
  use: { ...baseConfig.use, baseURL: 'http://localhost:8898' },
  webServer: {
    command: 'jlpm start',
    url: 'http://localhost:8898/lab',
    timeout: 120 * 1000,
    // Never attach to some other server: we need ours, with the test config.
    reuseExistingServer: false
  }
};
