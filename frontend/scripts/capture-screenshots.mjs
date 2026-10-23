import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, devices } from 'playwright';
import { fleetSnapshot } from '../e2e/fixtures/fleet.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = fileURLToPath(new URL('../test-results/screenshots', import.meta.url));
const socket = createServer();
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [`${root}/frontend/scripts/test-gateway.mjs`], {
  cwd: root,
  env: {
    ...process.env,
    CONFIG_FILE: `${root}/config.example.json`,
    TEST_GATEWAY_PORT: String(port),
    GITHUB_TOKEN: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk.toString();
});
server.on('error', (error) => {
  serverOutput += error.message;
});
const browsers = [];

function recordErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null || !server.pid)
      throw new Error(`Rust server exited: ${serverOutput}`);
    try {
      ready = (await fetch(`${origin}/healthz`)).ok;
    } catch {
      /* Wait for startup. */
    }
    if (ready) break;
    await delay(100);
  }
  assert(ready, `Rust server did not become ready: ${serverOutput}`);

  const snapshot = fleetSnapshot();
  const legacy = structuredClone(snapshot.apps[0]);
  legacy.name = 'Legacy';
  legacy.namespace = 'legacy';
  legacy.repository = 'owner/legacy';
  legacy.url = 'https://legacy.example.com';
  legacy.stack = { frontend: 'Angular', backend: 'Java' };
  legacy.workloads[0].images = ['ghcr.io/owner/legacy:v2.4.0'];
  legacy.repositoryData.openMRs = 0;
  legacy.repositoryData.mrs = [];
  legacy.repositoryData.issues = 2;
  legacy.repositoryData.deployment.url = 'https://github.com/owner/legacy/actions/runs/1';
  legacy.repositoryData.dependencyUpdate.run.url = 'https://github.com/owner/legacy/actions/runs/2';
  snapshot.apps.splice(1, 0, legacy);

  const browser = await chromium.launch();
  browsers.push(browser);
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  });
  const errors = recordErrors(page);
  await page.route('**/api/apps', (route) => route.fulfill({ json: snapshot }));
  await page.goto(origin);
  for (const text of ['React / Rust', 'Angular / Java', 'Unknown / Unknown']) {
    await page.getByText(text, { exact: true }).waitFor({ state: 'visible' });
  }
  await page.evaluate(() => document.fonts.ready);
  assert.match(await page.getByRole('article', { name: 'Open issues' }).innerText(), /5\+/);
  await page.screenshot({
    path: `${output}/app-stacks-desktop.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Hello', exact: true }).click();
  await page
    .getByText('ghcr.io/owner/hello:sha-123', { exact: true })
    .waitFor({ state: 'visible' });
  await page.screenshot({
    path: `${output}/react-ui-expanded-desktop.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Hello', exact: true }).click();
  await page.setViewportSize({ width: 430, height: 932 });
  await page.getByRole('button', { name: /Filter applications/ }).click();
  await page.getByRole('option', { name: 'Healthy', exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({
    path: `${output}/react-ui-filter-mobile.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const table = document.querySelector('table');
    const scroll = table.parentElement;
    const stack = table.querySelector('tbody tr > td');
    scroll.scrollLeft = Math.max(
      0,
      stack.getBoundingClientRect().right - scroll.getBoundingClientRect().right + 8,
    );
  });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'Mobile viewport has document overflow',
  );
  await page.screenshot({
    path: `${output}/app-stacks-mobile.png`,
    fullPage: true,
    animations: 'disabled',
  });
  assert.deepEqual(errors, []);
  console.log(
    'Captured desktop, expanded-row, mobile, and filter-menu screenshots without browser errors.',
  );

  if (process.env.SCREENSHOT_WEBKIT === '1') {
    const safari = await webkit.launch();
    browsers.push(safari);
    const mobile = await safari.newPage({ ...devices['iPhone 13'] });
    // Playwright changes the user agent but retains the Linux host platform.
    // Match iOS platform detection to exercise React Aria's mobile Safari path.
    await mobile.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'iPhone' });
    });
    const webkitErrors = recordErrors(mobile);
    await mobile.route('**/api/apps', (route) => route.fulfill({ json: snapshot }));
    await mobile.goto(origin);
    await mobile.getByRole('button', { name: 'Hello', exact: true }).waitFor({ state: 'visible' });
    await mobile.getByRole('button', { name: /Filter applications/ }).tap();
    await mobile
      .getByRole('option', { name: 'Healthy', exact: true })
      .waitFor({ state: 'visible' });
    const mobileStyles = await mobile
      .locator('head style')
      .evaluateAll((styles) =>
        styles.map((style) => ({ css: style.textContent, rules: style.sheet?.cssRules.length })),
      );
    assert(
      mobileStyles.some(
        (style) => style.css.includes('overscroll-behavior: contain') && style.rules > 0,
      ),
      'WebKit scroll style was not applied under CSP',
    );
    await mobile.getByRole('option', { name: 'Healthy', exact: true }).tap();
    assert.equal(await mobile.getByRole('button', { name: 'Language', exact: true }).count(), 0);
    await mobile.getByRole('button', { name: 'Hello', exact: true }).tap();
    await mobile
      .getByText('ghcr.io/owner/hello:sha-123', { exact: true })
      .waitFor({ state: 'visible' });
    await mobile.getByRole('button', { name: 'Hello', exact: true }).tap();
    await mobile.getByRole('button', { name: /Filter applications/ }).tap();
    await mobile
      .getByRole('option', { name: 'Healthy', exact: true })
      .waitFor({ state: 'visible' });
    assert(
      await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'Mobile WebKit viewport has document overflow',
    );
    assert.deepEqual(webkitErrors, []);
    // WebKit's screenshot helper injects a temporary `body {}` repaint stylesheet.
    // Verify application errors first; the rejected tooling style does not affect pixels.
    await mobile.screenshot({
      path: `${output}/react-ui-mobile-webkit.png`,
      fullPage: true,
      animations: 'disabled',
      scale: 'css',
    });
    assert(
      webkitErrors.length <= 1 &&
        webkitErrors.every(
          (message) =>
            message ===
            "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
        ),
      `Unexpected WebKit screenshot errors: ${webkitErrors.join('\n')}`,
    );
    console.log(
      'Captured mobile WebKit screenshot and verified touch filtering, disclosure, and CSP scroll styles.',
    );
  }
} finally {
  for (const browser of browsers) await browser.close();
  if (server.pid && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
}
