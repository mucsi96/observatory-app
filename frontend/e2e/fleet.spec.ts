import { expect, test } from '@playwright/test';
import { fleetSnapshot } from './fixtures/fleet';

test('storage serves the production React bundle under CSP and fleet interactions work', async ({
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
  expect(response?.headers()['content-security-policy']).not.toContain("'unsafe-inline'");
  await expect(page.getByRole('button', { name: 'Hello' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Frontend / Backend' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'React / Rust', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hello' }).click();
  await expect(page.getByText('ghcr.io/owner/hello:sha-123')).toBeVisible();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Filter applications/ }).click();
  await page.getByRole('option', { name: 'All applications', exact: true }).click();
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
  await expect(page.getByText('React / Rust', { exact: true })).toBeVisible();
  failing = true;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText(/Showing the last received snapshot/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hello' })).toBeVisible();
  const filter = page.getByRole('button', { name: /Filter applications/ });
  await filter.click();
  const healthy = page.getByRole('option', { name: 'Healthy', exact: true });
  await expect(healthy).toBeVisible();
  const bounds = await healthy.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await healthy.click();
  await expect(page.getByRole('button', { name: 'Language', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('stack labels are searchable and missing or partial metadata stays explicit', async ({
  page,
}) => {
  const snapshot = fleetSnapshot();
  snapshot.apps.push({
    ...snapshot.apps[0],
    name: 'Legacy',
    namespace: 'legacy',
    stack: { frontend: 'Angular', backend: 'Java' },
  });
  await page.route('**/api/apps', (route) => route.fulfill({ json: snapshot }));
  await page.goto('/');
  await expect(page.getByText('Angular / Java', { exact: true })).toBeVisible();
  await expect(page.getByText('Unknown / Unknown', { exact: true })).toBeVisible();
  for (const query of [' react ', 'RUST']) {
    await page.getByRole('searchbox').fill(query);
    await expect(page.getByRole('button', { name: 'Hello', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Legacy', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Language', exact: true })).toHaveCount(0);
  }
  await page.getByRole('searchbox').fill('java');
  await expect(page.getByRole('button', { name: 'Legacy', exact: true })).toBeVisible();
  await page.getByRole('searchbox').clear();
  snapshot.apps[1].stack = { frontend: null, backend: 'Go' };
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Unknown / Go', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Legacy', exact: true }).click();
  await expect(page.locator('#details-legacy > td')).toHaveAttribute('colspan', '8');
  await page.getByRole('searchbox').fill('no match');
  await expect(page.getByRole('cell', { name: /No applications match/ })).toHaveAttribute(
    'colspan',
    '8',
  );
});

test('partial totals, search, filters and expansion state work through the browser', async ({
  page,
}) => {
  await page.route('**/api/apps', (route) => route.fulfill({ json: fleetSnapshot() }));
  await page.goto('/');
  await expect(page.getByRole('article', { name: 'Open issues' })).toContainText('3+');
  await expect(page.getByRole('article', { name: 'Open MRs / PRs' })).toContainText('1+');
  await page.getByRole('button', { name: 'Hello', exact: true }).click();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '#12 Improve greeting' })).toHaveAttribute(
    'href',
    'https://github.com/owner/hello/pull/12',
  );
  await page.getByRole('searchbox').fill('language');
  await expect(page.getByRole('button', { name: 'Hello', exact: true })).toHaveCount(0);
  await page.getByRole('searchbox').clear();
  await expect(page.getByRole('button', { name: 'Hello', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await page.getByRole('button', { name: /Filter applications/ }).click();
  await page.getByRole('option', { name: 'Healthy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Language', exact: true })).toHaveCount(0);
  await page.getByRole('searchbox').fill('no match');
  await expect(
    page.getByText('No applications match this view. Try another search or filter.'),
  ).toBeVisible();
});

test('dependency attention reflects evidence separately from workflow success and escapes untrusted links', async ({
  page,
}) => {
  const snapshot = fleetSnapshot();
  snapshot.apps = [snapshot.apps[0]];
  const repo = snapshot.apps[0].repositoryData!;
  repo.mrs[0].pipeline = 'passed';
  await page.route('**/api/apps', (route) => route.fulfill({ json: snapshot }));
  await page.goto('/');
  await page.getByRole('button', { name: /Filter applications/ }).click();
  await page.getByRole('option', { name: 'Needs attention', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Hello', exact: true })).toBeVisible();
  await expect(page.getByText('No PR created or updated by this run')).toBeVisible();
  repo.dependencyUpdate!.outcome = 'PR updated';
  repo.dependencyUpdate!.mrs = [
    {
      number: 42,
      title: 'Update dependencies',
      url: 'https://github.com/o/r/pull/42',
      state: 'merged',
    },
  ];
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('button', { name: 'Hello', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /Filter applications/ }).click();
  await page.getByRole('option', { name: 'All applications', exact: true }).click();
  await expect(page.getByText('PRs updated by this run:')).toBeVisible();
  await expect(page.getByRole('link', { name: '#42 Update dependencies' })).toHaveAttribute(
    'href',
    'https://github.com/o/r/pull/42',
  );
  await page.getByRole('button', { name: /Filter applications/ }).click();
  await page.getByRole('option', { name: 'Needs attention', exact: true }).click();
  repo.dependencyUpdate!.outcome = 'pending';
  repo.dependencyUpdate!.run!.status = 'in_progress';
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('button', { name: 'Hello', exact: true })).toHaveCount(0);
  repo.dependencyUpdate = {
    run: { status: 'success', url: 'javascript:alert(1)', updatedAt: new Date().toISOString() },
    outcome: 'unknown',
    error: 'Dependency updates: upstream HTTP 410',
    mrs: [
      {
        number: 42,
        title: '<script>alert("x")</script>',
        url: 'javascript:alert(1)',
        state: 'merged',
      },
    ],
  };
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('PR activity unverified')).toBeVisible();
  await expect(page.getByText('#42 <script>alert("x")</script>', { exact: true })).toBeVisible();
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.locator('table script')).toHaveCount(0);
  await expect(page.getByText('No PR created or updated by this run')).toHaveCount(0);
});

test('keyboard filtering and disclosure preserve focus and expansion under CSP', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('**/api/apps', (route) => route.fulfill({ json: fleetSnapshot() }));
  await page.goto('/');
  const hello = page.getByRole('button', { name: 'Hello', exact: true });
  await hello.focus();
  await hello.press('Enter');
  await expect(hello).toHaveAttribute('aria-expanded', 'true');
  const filter = page.getByRole('button', { name: /Filter applications/ });
  await filter.focus();
  await filter.press('Enter');
  await page.getByRole('option', { name: 'All applications', exact: true }).press('End');
  await page.getByRole('option', { name: 'Healthy', exact: true }).press('Enter');
  await expect(filter).toBeFocused();
  await expect(page.getByRole('button', { name: 'Language', exact: true })).toHaveCount(0);
  await expect(hello).toHaveAttribute('aria-expanded', 'true');
  await filter.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(filter).toBeFocused();
  await hello.focus();
  await hello.press('Space');
  await expect(hello).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#details-hello')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('initial collection recovers, expired sessions and invalid responses retain the previous snapshot', async ({
  page,
}) => {
  let mode: 'initial' | 'live' | 'session' | 'invalid' = 'initial';
  await page.route('**/api/apps', (route) =>
    route.fulfill(
      mode === 'initial'
        ? { status: 503, json: { error: 'Initial collection in progress' } }
        : mode === 'live'
          ? { json: fleetSnapshot() }
          : mode === 'session'
            ? { contentType: 'text/html', body: '<html>Sign in</html>' }
            : { json: { apps: [] } },
    ),
  );
  await page.goto('/');
  await expect(
    page.getByText('Initial collection is still in progress. Retrying shortly…'),
  ).toBeVisible();
  mode = 'live';
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('button', { name: 'Hello', exact: true })).toBeVisible();
  mode = 'session';
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText(/sign in again.*Showing the last received snapshot/)).toBeVisible();
  mode = 'invalid';
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(
    page.getByText(/invalid snapshot.*Showing the last received snapshot/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hello', exact: true })).toBeVisible();
});

test('stale snapshots remain visible and production versions handle registry ports and digests', async ({
  page,
}) => {
  const snapshot = fleetSnapshot();
  snapshot.updatedAt = new Date(Date.now() - 240_000).toISOString();
  snapshot.apps[0].workloads[0].images = [
    'registry:5000/team/app:v2',
    'registry:5000/team/app',
    'app@sha256:0123456789abcdef',
  ];
  await page.route('**/api/apps', (route) => route.fulfill({ json: snapshot }));
  await page.goto('/');
  await expect(page.getByText(/Signals are stale/)).toBeVisible();
  await expect(page.getByText('v2', { exact: true })).toBeVisible();
  await expect(page.getByText('latest (implicit)', { exact: true })).toBeVisible();
  await expect(page.getByText('sha256:0123456789ab', { exact: true })).toBeVisible();
});
