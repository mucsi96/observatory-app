import type { Snapshot } from '../../src/features/fleet/schema';

export function fleetSnapshot(): Snapshot {
  return {
    environment: 'test',
    updatedAt: new Date().toISOString(),
    apps: [
      {
        name: 'Hello',
        namespace: 'hello',
        repository: 'owner/hello',
        url: 'https://hello.example.com',
        stack: { frontend: 'React', backend: 'Rust' },
        health: 'healthy',
        errors: [],
        workloads: [
          {
            name: 'server',
            ready: 1,
            desired: 1,
            status: 'healthy',
            images: ['ghcr.io/owner/hello:sha-123'],
          },
        ],
        repositoryData: {
          openMRs: 1,
          issues: 3,
          mrs: [
            {
              number: 12,
              title: 'Improve greeting',
              url: 'https://github.com/owner/hello/pull/12',
              pipeline: 'failed',
              draft: true,
            },
          ],
          deployment: {
            status: 'success',
            url: 'https://github.com/owner/hello/actions/runs/1',
            updatedAt: new Date().toISOString(),
          },
          dependencyUpdate: {
            run: {
              status: 'success',
              url: 'https://github.com/owner/hello/actions/runs/2',
              updatedAt: new Date().toISOString(),
            },
            outcome: 'no PR created',
            mrs: [],
          },
        },
      },
      {
        name: 'Language',
        namespace: 'language',
        repository: 'owner/language',
        url: 'https://language.example.com',
        health: 'unknown',
        workloads: [],
        repositoryData: null,
        errors: ['Kubernetes: upstream HTTP 403', 'GitHub: upstream unavailable'],
      },
    ],
  };
}
