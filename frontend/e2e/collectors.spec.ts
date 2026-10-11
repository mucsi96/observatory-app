import { strToU8, zipSync } from 'fflate';
import {
  test,
  expect,
  defaultGitHub,
  deployment,
  descriptor,
  type Handler,
  type UpstreamRequest,
} from './fixtures/observatory';

const finished = '2026-10-01T10:10:00Z INFO: Repository finished (repository=o/r)\n';
const created =
  '2026-10-01T10:05:00Z INFO: PR created (repository=o/r, branch=renovate/all)\n2026-10-01T10:05:00Z        "pr": 42,\n';
const logLimit = 16 * 1024 * 1024;
const archive = (...logs: string[]) =>
  zipSync(Object.fromEntries(logs.map((log, index) => [`${index}_job.txt`, strToU8(log)])));

function dependencyHandler(
  options: {
    logs?: string;
    status?: string;
    logStatus?: number;
    noWorkflow?: boolean;
    noRun?: boolean;
    download?: (request: UpstreamRequest) => ReturnType<Handler>;
  } = {},
): Handler {
  return (request) => {
    if (request.path === '/repos/o/r/actions/workflows') {
      return {
        json: {
          workflows: options.noWorkflow
            ? []
            : [{ id: 12, path: '.github/workflows/update_dependencies.yml' }],
        },
      };
    }
    if (request.path === '/repos/o/r/actions/workflows/12/runs') {
      return {
        json: {
          workflow_runs: options.noRun
            ? []
            : [
                {
                  id: 7,
                  run_attempt: 2,
                  status: options.status ?? 'completed',
                  conclusion: 'success',
                  html_url: 'https://github.com/o/r/actions/runs/7',
                  updated_at: '2026-10-01T10:10:00Z',
                },
              ],
        },
      };
    }
    if (request.path === '/repos/o/r/actions/runs/7/attempts/2/logs') {
      return (
        options.download?.(request) ?? {
          status: options.logStatus ?? 200,
          body: archive(options.logs ?? finished),
        }
      );
    }
    if (request.path === '/repos/o/r/pulls/42') {
      return {
        json: { title: 'Update dependencies', state: 'closed', merged_at: '2026-10-01T11:00:00Z' },
      };
    }
    return defaultGitHub(request);
  };
}

test('real collectors preserve rollout readiness, versions, partial failures, API headers and React details', async ({
  observatory,
  page,
  request,
}) => {
  const deployments = {
    healthy: [deployment()],
    old: [deployment({ observed: 1 })],
    surge: [deployment({ replicas: 2, ready: 2 })],
    failed: [deployment({ conditions: [{ type: 'Progressing', status: 'False' }] })],
    scaled: [deployment({ desired: 0, replicas: 0, ready: 0, updated: 0 })],
    empty: [],
    mixed: [
      deployment(),
      deployment({ name: 'worker', conditions: [{ type: 'ReplicaFailure', status: 'True' }] }),
    ],
  };
  const app = await observatory({
    apps: [...Object.keys(deployments), 'broken'].map((namespace) => descriptor(namespace)),
    kubernetes: (event) => {
      const namespace = event.path.split('/')[5];
      return namespace === 'broken'
        ? {
            status: 403,
            json: {
              kind: 'Status',
              apiVersion: 'v1',
              status: 'Failure',
              reason: 'Forbidden',
              message: 'private',
              code: 403,
            },
          }
        : { json: { metadata: {}, items: deployments[namespace as keyof typeof deployments] } };
    },
    github: (event) =>
      event.path.endsWith('/actions/workflows') ? { status: 403 } : defaultGitHub(event),
  });
  const snapshot = await app.snapshot();
  expect(snapshot.apps.map((signal) => signal.health)).toEqual([
    'healthy',
    'degraded',
    'degraded',
    'unhealthy',
    'degraded',
    'not deployed',
    'unhealthy',
    'unknown',
  ]);
  expect(snapshot.apps[0].workloads[0].images).toEqual(['app:prod-12']);
  expect(snapshot.apps[0].repositoryData?.issues).toBe(3);
  expect(snapshot.apps[0].repositoryData?.dependencyUpdate?.error).toContain('HTTP 403');
  expect(snapshot.apps[7].errors).toContain('Kubernetes: upstream HTTP 403');
  expect(
    app.requests.kubernetes.every(
      (event) => event.authorization === 'Bearer kubernetes-private-token',
    ),
  ).toBe(true);
  expect(
    app.requests.github.every((event) => event.authorization === 'Bearer github-private-token'),
  ).toBe(true);
  const response = await request.get(`${app.url}/api/apps`);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(response.headers()['referrer-policy']).toBe('no-referrer');
  expect(await response.text()).not.toMatch(/private-token|127\.0\.0\.1/);
  await page.goto(app.url);
  await page.getByRole('button', { name: 'healthy', exact: true }).click();
  await expect(page.getByText('app:prod-12', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'broken', exact: true }).click();
  await expect(page.getByText('Kubernetes: upstream HTTP 403', { exact: true })).toBeVisible();
});

test('paginated PRs and checks combine with legacy statuses and only the delivery workflow supplies deployments', async ({
  observatory,
}) => {
  const app = await observatory({
    github: (event) => {
      if (event.path === '/search/issues') {
        return { json: { total_count: 7 } };
      }
      if (event.path === '/repos/o/r/pulls') {
        return {
          json:
            event.query.get('page') === '1'
              ? Array.from({ length: 100 }, (_, index) => ({
                  number: index + 1,
                  title: `Change ${index}`,
                  draft: true,
                  html_url: `https://github.com/o/r/pull/${index + 1}`,
                  head: { sha: 'checked' },
                }))
              : [
                  {
                    number: 101,
                    title: 'Legacy failure',
                    draft: false,
                    html_url: 'https://github.com/o/r/pull/101',
                    head: { sha: 'legacy' },
                  },
                ],
        };
      }
      if (event.path.endsWith('/status'))
        return {
          json: {
            state: event.path.includes('/legacy/') ? 'failure' : 'pending',
            total_count: event.path.includes('/legacy/') ? 1 : 0,
          },
        };
      if (event.path.endsWith('/check-runs'))
        return {
          json: {
            check_runs: event.path.includes('/legacy/')
              ? [{ status: 'in_progress' }]
              : event.query.get('page') === '1'
                ? Array.from({ length: 100 }, () => ({
                    status: 'completed',
                    conclusion: 'success',
                  }))
                : [{ status: 'completed', conclusion: 'failure' }],
          },
        };
      if (event.path === '/repos/o/r/actions/runs')
        return {
          json: {
            workflow_runs: [
              { id: 2, path: '.github/workflows/pages.yml' },
              { id: 1, path: '.github/workflows/pipeline.yml', updated_at: '2026-10-01T10:00:00Z' },
            ],
          },
        };
      if (event.path === '/repos/o/r/actions/runs/1/jobs')
        return {
          json: {
            jobs:
              event.query.get('page') === '1'
                ? Array.from({ length: 100 }, () => ({
                    name: 'test',
                    status: 'completed',
                    conclusion: 'success',
                    html_url: 'https://github.com/o/r/actions/runs/1',
                  }))
                : [
                    {
                      name: 'deploy',
                      status: 'completed',
                      conclusion: 'failure',
                      html_url: 'https://github.com/o/r/actions/runs/1',
                    },
                  ],
          },
        };
      return defaultGitHub(event);
    },
  });
  const repo = (await app.snapshot()).apps[0].repositoryData!;
  expect(repo.issues).toBe(7);
  expect(repo.openMRs).toBe(101);
  expect(repo.mrs).toHaveLength(101);
  expect(repo.mrs.every((pr) => pr.pipeline === 'failed')).toBe(true);
  expect(repo.mrs[0].draft).toBe(true);
  expect(repo.deployment?.status).toBe('failure');
  expect(app.requests.github.find((event) => event.path === '/search/issues')?.query.get('q')).toBe(
    'repo:o/r is:open is:issue NOT "Dependency Dashboard" in:title',
  );
  expect(app.requests.github.some((event) => event.path.includes('/actions/runs/2/jobs'))).toBe(
    false,
  );
});

for (const workflow of ['deploy.production.yml', 'deploy.production.yaml']) {
  test(`dotted deployment workflow ${workflow} starts and selects its deployment`, async ({
    observatory,
    page,
  }) => {
    const deploymentUrl = 'https://github.com/o/r/actions/runs/1';
    const updatedAt = '2026-10-01T10:00:00Z';
    const app = await observatory({
      apps: [{ ...descriptor(), deploymentWorkflow: workflow }],
      github: (event) => {
        if (event.path === '/repos/o/r/actions/runs') {
          return {
            json: {
              workflow_runs: [
                { id: 3, path: '.github/workflows/pipeline.yml' },
                { id: 2, path: '.github/workflows/pages.yml' },
                { id: 1, path: `.github/workflows/${workflow}`, updated_at: updatedAt },
              ],
            },
          };
        }
        if (event.path === '/repos/o/r/actions/runs/1/jobs') {
          return {
            json: {
              jobs: [
                {
                  name: 'deploy',
                  status: 'completed',
                  conclusion: 'success',
                  html_url: deploymentUrl,
                },
              ],
            },
          };
        }
        return defaultGitHub(event);
      },
    });
    const signal = (await app.snapshot()).apps[0];
    expect(signal.errors).toEqual([]);
    expect(signal.repositoryData?.deployment).toEqual({
      status: 'success',
      url: deploymentUrl,
      updatedAt,
    });
    expect(
      app.requests.github
        .filter((event) => event.path.endsWith('/jobs'))
        .map((event) => event.path),
    ).toEqual(['/repos/o/r/actions/runs/1/jobs']);
    await page.goto(app.url);
    await expect(page.getByRole('link', { name: 'success', exact: true })).toHaveAttribute(
      'href',
      deploymentUrl,
    );
  });
}

for (const [name, state, count, checks, expected] of [
  ['no checks', 'pending', 0, [], 'no checks'],
  ['running', 'success', 1, [{ status: 'in_progress' }], 'running'],
  ['cancelled', 'success', 1, [{ status: 'completed', conclusion: 'cancelled' }], 'failed'],
  ['passing', 'success', 1, [{ status: 'completed', conclusion: 'success' }], 'passed'],
] as const) {
  test(`real PR check state: ${name}`, async ({ observatory }) => {
    const app = await observatory({
      github: (event) => {
        if (event.path.endsWith('/pulls'))
          return {
            json: [
              {
                number: 12,
                title: 'A change',
                html_url: 'https://github.com/o/r/pull/12',
                head: { sha: 'abc' },
              },
            ],
          };
        if (event.path.endsWith('/status')) return { json: { state, total_count: count } };
        if (event.path.endsWith('/check-runs')) return { json: { check_runs: checks } };
        return defaultGitHub(event);
      },
    });
    expect((await app.snapshot()).apps[0].repositoryData?.mrs[0].pipeline).toBe(expected);
  });
}

test('incomplete issue searches are unknown and do not hide Kubernetes health', async ({
  observatory,
}) => {
  const app = await observatory({
    github: (event) =>
      event.path === '/search/issues'
        ? { json: { total_count: 7, incomplete_results: true } }
        : defaultGitHub(event),
  });
  const signal = (await app.snapshot()).apps[0];
  expect(signal.health).toBe('healthy');
  expect(signal.repositoryData).toBeNull();
  expect(signal.errors).toContain('GitHub: GitHub search results incomplete');
});

test('all Kubernetes deployment pages contribute to health and image signals', async ({
  observatory,
}) => {
  const app = await observatory({
    kubernetes: (event) =>
      event.query.has('continue')
        ? {
            json: {
              metadata: {},
              items: [
                deployment({
                  name: 'worker',
                  conditions: [{ type: 'ReplicaFailure', status: 'True' }],
                }),
              ],
            },
          }
        : { json: { metadata: { continue: 'next-page' }, items: [deployment()] } },
  });
  const signal = (await app.snapshot()).apps[0];
  expect(signal.health).toBe('unhealthy');
  expect(signal.workloads.map((workload) => workload.name)).toEqual(['server', 'worker']);
  expect(app.requests.kubernetes[1].query.get('continue')).toBe('next-page');
});

test('invalid application descriptors are rejected at process startup', async ({ observatory }) => {
  for (const apps of [
    [{ ...descriptor(), url: 'javascript:alert(1)' }],
    [{ ...descriptor(), url: 'https://secret@example.com' }],
    [{ ...descriptor(), namespace: '../app' }],
    [{ ...descriptor(), repository: '../o/r' }],
    [{ ...descriptor(), deploymentWorkflow: '../pipeline.yml' }],
    [{ ...descriptor(), deploymentWorkflow: 'nested/deploy.production.yml' }],
    [{ ...descriptor(), deploymentWorkflow: '..\\deploy.production.yml' }],
    [descriptor(), descriptor()],
  ]) {
    await expect(observatory({ apps })).rejects.toThrow('invalid app configuration');
  }
});

test('initial collection returns 503 and browser refresh never triggers upstream calls', async ({
  observatory,
  request,
  page,
}) => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = await observatory({
    github: async (event) => {
      await waiting;
      return defaultGitHub(event);
    },
  });
  const initial = await request.get(`${app.url}/api/apps`);
  expect(initial.status()).toBe(503);
  expect(initial.headers()['content-type']).toContain('application/json');
  release();
  await app.snapshot();
  const calls = app.requests.github.length + app.requests.kubernetes.length;
  await page.goto(app.url);
  await page.getByRole('button', { name: 'app', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  expect(app.requests.github.length + app.requests.kubernetes.length).toBe(calls);
});

test('paginated workflow discovery uses the latest attempt and never forwards credentials to HTTPS log storage', async ({
  observatory,
}) => {
  const handler = dependencyHandler({
    download: (event) => ({
      status: 302,
      headers: { Location: `${event.logsUrl}/logs?signed=private` },
    }),
  });
  const app = await observatory({
    github: (event) => {
      if (event.path === '/repos/o/r/actions/workflows' && event.query.get('page') === '1')
        return {
          json: {
            workflows: Array.from({ length: 100 }, () => ({
              id: 1,
              path: '.github/workflows/pipeline.yml',
            })),
          },
        };
      return handler(event);
    },
    logs: () => ({
      body: archive(
        created + finished,
        created.replace('42', '43') + created.replace('repository=o/r', 'repository=other/r'),
      ),
    }),
  });
  // Include a second created PR in a separate log file and preserve closed/merged state.
  // A missing lookup stays explicitly unverified while retaining the run and first PR.
  const update = (await app.snapshot()).apps[0].repositoryData?.dependencyUpdate;
  expect(update?.run?.status).toBe('success');
  expect(update?.mrs[0]).toMatchObject({
    number: 42,
    state: 'merged',
    url: 'https://github.com/o/r/pull/42',
  });
  expect(update?.error).toContain('HTTP 404');
  expect(update?.outcome).toBe('unknown');
  expect(app.requests.logs).toHaveLength(1);
  expect(app.requests.logs[0].authorization).toBeUndefined();
  expect(app.requests.logs[0].query.get('signed')).toBe('private');
  expect(
    app.requests.github.some((event) => event.path === '/repos/o/r/actions/runs/7/attempts/2/logs'),
  ).toBe(true);
  expect(
    app.requests.github
      .find((event) => event.path === '/repos/o/r/actions/workflows/12/runs')
      ?.query.get('per_page'),
  ).toBe('1');
  expect(JSON.stringify(update)).not.toMatch(/signed=|private-token|127\.0\.0\.1/);
});

for (const [name, logs, expected, error] of [
  ['created', created + finished, 'PR created', false],
  ['deduplicated', created + created + finished, 'PR created', false],
  [
    'updated is not created',
    created.replace('PR created', 'PR updated') + finished,
    'no PR created',
    false,
  ],
  [
    'dry runs are not created',
    created.replace('PR created', 'DRY-RUN: Would create PR') + finished,
    'no PR created',
    false,
  ],
  [
    'other repository',
    created.replace('repository=o/r', 'repository=other/r') + finished,
    'no PR created',
    false,
  ],
  ['no updates', finished, 'no PR created', false],
  ['missing completion', created, 'unknown', true],
  ['unknown format', 'unrecognized log format', 'unknown', true],
  [
    'incomplete creation',
    '2026-10-01T10:05:00Z INFO: PR created (repository=o/r)\n' + finished,
    'unknown',
    true,
  ],
] as const) {
  test(`dependency creation evidence: ${name}`, async ({ observatory }) => {
    const app = await observatory({ github: dependencyHandler({ logs }) });
    const signal = (await app.snapshot()).apps[0];
    const update = signal.repositoryData?.dependencyUpdate;
    expect(signal.repositoryData?.issues).toBe(3);
    expect(update?.outcome).toBe(expected);
    expect(Boolean(update?.error)).toBe(error);
    expect(update?.mrs).toHaveLength(expected === 'PR created' ? 1 : 0);
  });
}

for (const [name, options, outcome, hasRun, hasError] of [
  ['running', { status: 'in_progress' }, 'pending', true, false],
  ['no workflow', { noWorkflow: true }, 'unknown', false, false],
  ['no runs', { noRun: true }, 'unknown', false, false],
  ['expired logs', { logStatus: 410 }, 'unknown', true, true],
] as const) {
  test(`dependency run state: ${name}`, async ({ observatory }) => {
    const app = await observatory({ github: dependencyHandler(options) });
    const update = (await app.snapshot()).apps[0].repositoryData?.dependencyUpdate;
    expect(update?.outcome).toBe(outcome);
    expect(Boolean(update?.run)).toBe(hasRun);
    expect(Boolean(update?.error)).toBe(hasError);
    if (outcome === 'pending')
      expect(app.requests.github.some((event) => event.path.endsWith('/logs'))).toBe(false);
  });
}

for (const [name, download] of [
  [
    'insecure redirect',
    () => ({ status: 302, headers: { Location: 'http://example.com/private' } }),
  ],
  [
    'redirect credentials',
    () => ({ status: 302, headers: { Location: 'https://secret@example.com/private' } }),
  ],
  ['oversized download', () => ({ body: new Uint8Array(logLimit + 1) })],
  ['oversized decompression', () => ({ body: archive('x'.repeat(logLimit + 1)) })],
  [
    'cumulative archive budget',
    () => ({ body: archive('x'.repeat(logLimit / 2 + 1), 'x'.repeat(logLimit / 2 + 1)) }),
  ],
] as const) {
  test(`dependency logs reject ${name}`, async ({ observatory }) => {
    const app = await observatory({ github: dependencyHandler({ download }) });
    const signal = (await app.snapshot()).apps[0];
    expect(signal.repositoryData?.issues).toBe(3);
    expect(signal.repositoryData?.dependencyUpdate?.outcome).toBe('unknown');
    expect(signal.repositoryData?.dependencyUpdate?.error).toBeTruthy();
    expect(JSON.stringify(signal)).not.toMatch(/secret|private-token|example\.com\/private/);
  });
}

test('the 50-second collection deadline bounds active and queued apps without losing independent Kubernetes signals', async ({
  observatory,
}) => {
  const started = Date.now();
  const app = await observatory({
    apps: Array.from({ length: 8 }, (_, index) => descriptor(`app-${index}`)),
    github: async (event) => {
      if (event.path.endsWith('/pulls'))
        return {
          json: Array.from({ length: 100 }, (_, index) => ({
            number: index + 1,
            title: 'Slow checks',
            html_url: `https://github.com/o/r/pull/${index + 1}`,
            head: { sha: 'slow' },
          })),
        };
      if (event.path.endsWith('/status') || event.path.endsWith('/check-runs')) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return {
          json: event.path.endsWith('/status')
            ? { state: 'pending', total_count: 0 }
            : { check_runs: [] },
        };
      }
      return defaultGitHub(event);
    },
  });
  const snapshot = await app.snapshot();
  expect(Date.now() - started).toBeLessThan(60_000);
  expect(snapshot.apps).toHaveLength(8);
  expect(
    snapshot.apps.every((signal) => signal.errors.includes('GitHub: collection deadline exceeded')),
  ).toBe(true);
  expect(snapshot.apps.slice(0, 4).every((signal) => signal.health === 'healthy')).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain('private-token');
});
