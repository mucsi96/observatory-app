import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: 'http://127.0.0.1:8080', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      'CONFIG_FILE=../config.example.json STATIC_DIR=dist LISTEN_ADDR=127.0.0.1:8080 ../target/debug/observatory',
    url: 'http://127.0.0.1:8080/healthz',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
