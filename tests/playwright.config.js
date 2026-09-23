const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.js',
  fullyParallel: true,
  workers: 3,
  timeout: 30000,
  expect: { timeout: 5000 },
  outputDir: '../test-results',
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    timezoneId: 'Asia/Bangkok',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: 'node scripts/test-server.js',
    url: 'http://127.0.0.1:4173',
    cwd: require('node:path').resolve(__dirname, '..'),
    reuseExistingServer: !process.env.CI,
    timeout: 10000
  }
});
