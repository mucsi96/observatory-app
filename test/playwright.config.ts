import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  globalSetup: require.resolve('./global-setup'),
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  use: {
    baseURL: 'http://localhost:8170',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
});
