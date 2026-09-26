import express from 'express';

const app = express();
app.use(express.json());
let requests = 0;
app.get('/health', (_req, res) => res.json({ status: 'UP' }));
app.post('/reset', (_req, res) => {
  requests = 0;
  res.json({ status: 'reset' });
});
app.get('/stats', (_req, res) => res.json({ requests }));
app.use((req, res, next) => {
  requests++;
  if (
    !['Bearer mock-github-token', 'Bearer mock-kubernetes-token'].includes(
      req.headers.authorization
    )
  ) {
    res.status(401).json({ error: 'Unauthorized upstream' });
    return;
  }
  next();
});
app.get('/apis/apps/v1/namespaces/:namespace/deployments', (req, res) => {
  if (req.params.namespace === 'offline') {
    res.status(503).json({ error: 'Cluster unavailable' });
    return;
  }
  const replicas = req.params.namespace === 'language' ? 0 : 1;
  res.json({
    items: [
      {
        metadata: { name: `${req.params.namespace}-server`, generation: 2 },
        spec: {
          replicas,
          template: {
            spec: {
              containers: [
                { image: `example/${req.params.namespace}:server-12` },
              ],
            },
          },
        },
        status: {
          observedGeneration: 2,
          replicas,
          updatedReplicas: replicas,
          availableReplicas: replicas,
        },
      },
    ],
  });
});
app.get('/search/issues', (req, res) => {
  if (String(req.query.q).includes('owner/offline')) {
    res.status(503).json({ error: 'GitHub unavailable' });
    return;
  }
  res.json({
    total_count: String(req.query.q).includes('owner/hello') ? 2 : 0,
    incomplete_results: false,
  });
});
app.get('/repos/:owner/:repo/pulls', (req, res) =>
  res.json(
    req.params.repo === 'hello'
      ? [
          {
            number: 12,
            title: 'Improve observability',
            html_url: 'https://github.com/owner/hello/pull/12',
            draft: false,
            head: { sha: 'abc' },
          },
        ]
      : []
  )
);
app.get('/repos/:owner/:repo/commits/:sha/status', (_req, res) =>
  res.json({ state: 'pending', total_count: 0 })
);
app.get('/repos/:owner/:repo/commits/:sha/check-runs', (_req, res) =>
  res.json({ check_runs: [{ status: 'completed', conclusion: 'failure' }] })
);
app.get('/repos/:owner/:repo/actions/runs', (_req, res) =>
  res.json({
    workflow_runs: [
      { id: 2, path: '.github/workflows/pages.yml' },
      {
        id: 1,
        path: '.github/workflows/pipeline.yml',
        updated_at: '2026-09-19T10:00:00Z',
      },
    ],
  })
);
app.get('/repos/:owner/:repo/actions/runs/:id/jobs', (req, res) =>
  res.json({
    jobs: [
      {
        name: 'deploy',
        status: 'completed',
        conclusion: req.params.repo === 'hello' ? 'success' : 'failure',
        html_url: `https://github.com/owner/${req.params.repo}/actions/runs/1`,
      },
    ],
  })
);
app.listen(3070, () => console.log('Mock GitHub/Kubernetes listening on 3070'));
