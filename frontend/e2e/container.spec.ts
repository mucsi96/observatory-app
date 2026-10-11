import { expect, test } from '@playwright/test';

test('the non-root read-only production image serves the real React app and shared API', async ({
  page,
  request,
}) => {
  const health = await request.get('/healthz');
  expect(await health.text()).toBe('ok');
  await expect.poll(async () => (await request.get('/api/apps')).status()).toBe(200);
  const response = await request.get('/api/apps');
  const snapshot = await response.json();
  expect(snapshot.apps).toHaveLength(2);
  expect(snapshot.apps.every((app: { health: string }) => app.health === 'unknown')).toBe(true);
  expect(response.headers()['cache-control']).toBe('no-store');
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });
  const html = await page.goto('/');
  expect(html?.headers()['content-security-policy']).toContain("script-src 'self'");
  await expect(page.getByRole('button', { name: 'Hello', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hello', exact: true }).click();
  await expect(page.getByText('No deployment data available.')).toBeVisible();
  await expect(
    page.getByText('GitHub: GITHUB_TOKEN is not configured', { exact: true }),
  ).toBeVisible();
  expect(failures).toEqual([]);
});
