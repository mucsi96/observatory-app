import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const image = process.env.OBSERVATORY_CONTAINER_IMAGE;
const inventory = fileURLToPath(new URL('../config.example.json', import.meta.url));

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
      ],
  webServer: {
    command: image
      ? `docker run --rm --read-only --cap-drop ALL -p 127.0.0.1:8080:8080 -e CONFIG_FILE=/config/config.json -v ${JSON.stringify(`${inventory}:/config/config.json:ro`)} ${JSON.stringify(image)}`
      : 'CONFIG_FILE=../config.example.json STATIC_DIR=dist LISTEN_ADDR=127.0.0.1:8080 ../target/debug/observatory',
    url: 'http://127.0.0.1:8080/healthz',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
