import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fleetSnapshot } from '../e2e/fixtures/fleet.ts';

// Serve either the historical or current production bundle with Vite preview.
const [origin, prefix] = process.argv.slice(2);
assert(
  origin && prefix,
  'Usage: node scripts/capture-layout-reference.mjs <origin> <output-prefix>',
);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/apps', (route) => route.fulfill({ json: fleetSnapshot() }));
  await page.goto(origin);
  await page.getByRole('button', { name: 'Hello', exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  for (const [name, width, height] of [
    ['desktop', 1600, 1000],
    ['mobile', 430, 932],
  ]) {
    await page.setViewportSize({ width, height });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: `${prefix}-${name}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
