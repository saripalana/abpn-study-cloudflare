import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  globalTimeout: process.env.CI ? 12 * 60_000 : undefined,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8787',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], browserName: 'chromium' }
    },
    {
      name: 'iphone-13-safari',
      use: {
        ...devices['iPhone 13'],
        browserName: 'webkit',
        hasTouch: true,
        isMobile: true
      }
    }
  ],
  webServer: {
    command: 'npm run dev:test',
    url: 'http://127.0.0.1:8787',
    // CI starts one job-scoped static server after source/build verification so
    // browser gates do not depend on Wrangler's local development process.
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === 'true' || !process.env.CI,
    timeout: 120_000
  }
});
