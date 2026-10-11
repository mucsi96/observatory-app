import { expect, test } from '@playwright/test';
import { fleetSnapshot } from '../src/test/fixtures';

test('Rust serves the production React bundle under CSP and fleet interactions work', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('**/api/apps', (route) => route.fulfill({ json: fleetSnapshot() }));
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
  await expect(page.getByRole('button', { name: 'Hello' })).toBeVisible();
  await page.getByRole('button', { name: 'Hello' }).click();
  await expect(page.getByText('ghcr.io/owner/hello:sha-123')).toBeVisible();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await page.getByRole('searchbox').fill('language');
  await expect(page.getByRole('button', { name: 'Hello' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Language' })).toBeVisible();
  const health = await request.get('/healthz');
  expect(await health.text()).toBe('ok');
  const snapshot = await request.get('/api/apps');
  expect(snapshot.status()).toBe(200);
  expect(snapshot.headers()['cache-control']).toBe('no-store');
  expect((await snapshot.json()).apps[0].health).toBe('unknown');
  expect(errors).toEqual([]);
});

test('mobile layout remains usable and refresh retains data after an error', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let failing = false;
  await page.route('**/api/apps', (route) =>
    route.fulfill(
      failing
        ? { status: 503, json: { error: 'Initial collection in progress' } }
        : { json: fleetSnapshot() },
    ),
  );
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Hello' })).toBeVisible();
  failing = true;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText(/Showing the last received snapshot/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hello' })).toBeVisible();
  await expect(page.getByRole('combobox')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
