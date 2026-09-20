import { test, expect } from '../fixtures';
import { query } from '../utils';

test('shows real collected signals, versions, PR checks and partial failures', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Observatory');
  await expect(page.getByRole('button', { name: 'User profile' })).toHaveText(
    'TU'
  );
  await expect(
    page.getByRole('heading', { name: 'Application fleet' })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Hello +', exact: true })
  ).toBeVisible();
  await expect(page.getByText('server-12').first()).toBeVisible();
  await expect(page.getByText(/Some signals are unavailable/)).toBeVisible();
  await page.getByRole('button', { name: 'Hello +', exact: true }).click();
  const details = page.getByRole('region', { name: 'Hello details' });
  await expect(details.getByText('1 / 1 replicas available')).toBeVisible();
  await expect(details.getByText('example/hello:server-12')).toBeVisible();
  await expect(
    details.getByRole('link', { name: '#12 Improve observability' })
  ).toHaveAttribute('href', 'https://github.com/owner/hello/pull/12');
  await expect(details.getByText('failed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Offline +', exact: true }).click();
  await expect(page.getByText('Kubernetes: upstream HTTP 503')).toBeVisible();
  await expect(page.getByText('GitHub: upstream HTTP 503')).toBeVisible();
  const { rows } = await query(
    'SELECT apps FROM observatory.snapshots WHERE environment=$1',
    ['test']
  );
  expect(
    rows[0].apps.find((app: { namespace: string }) => app.namespace === 'hello')
      .repositoryData.issues
  ).toBe(2);
});

test('searches, filters, expands and handles an empty view', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('searchbox', { name: 'Find an application' })
    .fill('language');
  await expect(
    page.getByRole('button', { name: 'Language +', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Hello +', exact: true })
  ).not.toBeVisible();
  await page.getByRole('searchbox', { name: 'Find an application' }).fill('');
  await page.getByRole('combobox', { name: 'Filter applications' }).click();
  await page.getByRole('option', { name: 'Healthy', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Hello +', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Language +', exact: true })
  ).not.toBeVisible();
  await page
    .getByRole('searchbox', { name: 'Find an application' })
    .fill('missing');
  await expect(page.getByText(/No applications match this view/)).toBeVisible();
});

test('retains the last snapshot on API failure and recovers on retry', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Hello +', exact: true })
  ).toBeVisible();
  await page.route('**/api/apps', (route) =>
    route.fulfill({
      status: 503,
      json: { error: 'Snapshot storage unavailable' },
    })
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Showing the last received snapshot'
  );
  await expect(
    page.getByRole('button', { name: 'Hello +', exact: true })
  ).toBeVisible();
  await page.unroute('**/api/apps');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('alert')).not.toBeVisible();
});

test('shows stale data and works on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/apps', async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    await route.fulfill({
      json: { ...snapshot, updatedAt: '2020-01-01T00:00:00Z' },
    });
  });
  await page.goto('/');
  await expect(
    page.getByText('Signals are stale. Showing the last collected snapshot.')
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Hello +', exact: true })
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});
