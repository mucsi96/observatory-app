import { test, expect } from '@playwright/test';

test('API verifies signatures, issuer, audience, expiry, scope and role', async ({ request }) => {
  const api = 'http://127.0.0.1:8081/api/apps';
  expect((await request.get(api)).status()).toBe(401);
  expect((await request.get(api, { headers: { Authorization: 'Bearer forged' } })).status()).toBe(
    401,
  );
  for (const [claims, expected] of [
    [{}, 200],
    [{ iss: 'https://wrong.example' }, 401],
    [{ aud: 'wrong-api' }, 401],
    [{ exp: 1 }, 401],
    [{ nbf: 9999999999 }, 401],
    [{ scp: 'other-scope' }, 403],
    [{ roles: ['other-role'] }, 403],
  ] as const) {
    const tokens = await request.get(
      `http://127.0.0.1:9180/token?claims=${encodeURIComponent(JSON.stringify(claims))}`,
    );
    const { access_token } = await tokens.json();
    const headers = { Authorization: `Bearer ${access_token}` };
    expect((await request.get(api, { headers })).status()).toBe(expected);
    if (expected === 200) {
      // Observatory is read-only: no cookie-authenticated mutation surface.
      expect((await request.post(api, { headers })).status()).toBe(405);
    }
  }
});

test('inline config boots deep links and browser logs use the same origin', async ({ page }) => {
  const environmentRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/environment')) environmentRequests.push(request.url());
  });
  await page.goto('/fleet/nested?source=bookmark');
  await expect(page.getByRole('button', { name: 'Hello', exact: true })).toBeVisible();
  const telemetry = page.waitForRequest(
    (request) =>
      request.url().endsWith('/_telemetry/collect') &&
      (request.postData() ?? '').includes('observatory-faro-check'),
  );
  await page.evaluate(() => console.info('observatory-faro-check'));
  expect((await telemetry).postDataJSON().meta.app.name).toBe('observatory-client');
  expect(environmentRequests).toEqual([]);
});
