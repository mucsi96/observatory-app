import { test, expect } from '../fixtures';

test('the UI provides the API access JWT and the API rejects missing, forged and ID tokens', async ({
  page,
  request,
}) => {
  expect((await request.get('/api/apps')).status()).toBe(401);
  expect((await request.get('/api/environment')).status()).toBe(200);
  const apiRequest = page.waitForRequest(
    (req) => new URL(req.url()).pathname === '/api/apps'
  );
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Hello +', exact: true })
  ).toBeVisible();
  const session = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.startsWith('oidc.user:')
    )!;
    return JSON.parse(localStorage.getItem(key)!);
  });
  expect((await apiRequest).headers()['authorization']).toBe(
    `Bearer ${session.access_token}`
  );
  expect(
    (
      await request.get('/api/apps', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
    ).status()
  ).toBe(200);
  expect(
    (
      await request.get('/api/apps', {
        headers: { Authorization: `Bearer ${session.id_token}` },
      })
    ).status()
  ).toBe(401);
  expect(
    (
      await request.get('/api/apps', {
        headers: { Authorization: `Bearer ${session.access_token}forged` },
      })
    ).status()
  ).toBe(401);
});

test('authority rejection stays on the error view until the user retries', async ({
  page,
}) => {
  let authorizations = 0;
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/default/authorize') authorizations++;
  });
  await page.goto(
    '/?error=invalid_client&error_description=Requested+scope+does+not+exist&state=stale-state'
  );
  await expect(
    page.getByRole('heading', { name: 'Sign-in failed' })
  ).toBeVisible();
  await expect(page.getByText('Requested scope does not exist')).toBeVisible();
  expect(authorizations).toBe(0);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: 'User profile' })).toHaveText(
    'TU'
  );
  expect(authorizations).toBe(1);
});

test('recovers when a refresh token is no longer valid', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'User profile' })).toHaveText(
    'TU'
  );
  const token = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.startsWith('oidc.user:')
    )!;
    return JSON.parse(localStorage.getItem(key)!).refresh_token;
  });
  const consumed = await page.request.post(
    'http://localhost:8070/default/token',
    { form: { grant_type: 'refresh_token', refresh_token: token } }
  );
  expect(consumed.ok()).toBe(true);
  await page.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 31_000;
    window.dispatchEvent(new Event('focus'));
    Date.now = now;
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const key = Object.keys(localStorage).find((key) =>
          key.startsWith('oidc.user:')
        )!;
        return JSON.parse(localStorage.getItem(key)!).refresh_token;
      })
    )
    .not.toBe(token);
  await expect(
    page.getByRole('button', { name: 'Hello +', exact: true })
  ).toBeVisible();
});

test('retries a 401 once after renewal without looping on 403', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Hello +', exact: true })
  ).toBeVisible();
  let requests = 0;
  await page.route('**/api/apps', (route) => {
    requests++;
    return requests === 1
      ? route.fulfill({ status: 401, json: { error: 'expired' } })
      : route.continue();
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => requests).toBe(2);
  await expect(page.getByRole('alert')).not.toBeVisible();
  await page.unroute('**/api/apps');
  await page.route('**/api/apps', (route) =>
    route.fulfill({ status: 403, json: { error: 'role required' } })
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByText('Your account needs the readApps role to view Observatory.')
  ).toBeVisible();
});
