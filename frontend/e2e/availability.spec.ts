import { test, expect, defaultGitHub, descriptor } from './fixtures/observatory';

test('browser evidence gates healthy workloads and exposes the failed run', async ({
  observatory,
  page,
}) => {
  const cases = [
    { name: 'success', status: 'completed', conclusion: 'success', age: 0, health: 'healthy' },
    { name: 'failure', status: 'completed', conclusion: 'failure', age: 0, health: 'unhealthy' },
    { name: 'timeout', status: 'completed', conclusion: 'timed_out', age: 0, health: 'unhealthy' },
    { name: 'stale', status: 'completed', conclusion: 'success', age: 31, health: 'unknown' },
    { name: 'future', status: 'completed', conclusion: 'success', age: -5, health: 'unknown' },
    { name: 'running', status: 'in_progress', conclusion: null, age: 0, health: 'unknown' },
    { name: 'cancelled', status: 'completed', conclusion: 'cancelled', age: 0, health: 'unknown' },
    { name: 'skipped', status: 'completed', conclusion: 'skipped', age: 0, health: 'unknown' },
    { name: 'missing', status: 'completed', conclusion: null, age: 0, health: 'unknown' },
  ];
  const app = await observatory({
    apps: cases.map((c) => descriptor(c.name, `o/${c.name}`)),
    github: (request) => {
      if (!request.path.endsWith('/actions/workflows/application_health.yml/runs'))
        return defaultGitHub(request);
      expect(request.query.get('branch')).toBe('main');
      const c = cases.find((c) => request.path.startsWith(`/repos/o/${c.name}/`))!;
      return {
        json: {
          workflow_runs:
            c.name === 'missing'
              ? []
              : [
                  {
                    id: 99,
                    status: c.status,
                    conclusion: c.conclusion,
                    updated_at: new Date(Date.now() - c.age * 60_000).toISOString(),
                    html_url: `https://github.com/o/${c.name}/actions/runs/99`,
                  },
                ],
        },
      };
    },
  });
  const snapshot = await app.snapshot();
  expect(snapshot.apps.map((app) => app.health)).toEqual(cases.map((c) => c.health));
  await page.goto(app.url);
  await page.getByRole('button', { name: 'failure', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'failure browser availability' })
      .getByRole('link', { name: 'failure' }),
  ).toHaveAttribute('href', 'https://github.com/o/failure/actions/runs/99');
});
