import { defineConfig, devices } from '@playwright/test';

const image = process.env.OBSERVATORY_CONTAINER_IMAGE;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  workers: 2,
  timeout: 90_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: 'http://127.0.0.1:8080', trace: 'retain-on-failure' },
  projects: image
    ? [{ name: 'container', testMatch: 'container.spec.ts', use: { ...devices['Desktop Chrome'] } }]
    : [
        { name: 'ui', testMatch: 'fleet.spec.ts', use: { ...devices['Desktop Chrome'] } },
        { name: 'collectors', testMatch: 'collectors.spec.ts' },
        { name: 'auth', testMatch: 'auth.spec.ts' },
      ],
  webServer: {
    command: 'node scripts/test-gateway.mjs',
    url: 'http://127.0.0.1:8080/healthz',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
