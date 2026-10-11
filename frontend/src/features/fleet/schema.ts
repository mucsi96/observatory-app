import { z } from 'zod';

const runSchema = z.object({ status: z.string(), url: z.string(), updatedAt: z.string() });

export const dependencyUpdateSchema = z.object({
  run: runSchema.nullable(),
  mrs: z.array(
    z.object({ number: z.number(), title: z.string(), url: z.string(), state: z.string() }),
  ),
  outcome: z.enum(['unknown', 'pending', 'no PR created', 'PR created']),
  error: z.string().optional(),
});

export const applicationSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  repository: z.string(),
  url: z.string(),
  health: z.enum(['healthy', 'degraded', 'unhealthy', 'not deployed', 'unknown']),
  workloads: z.array(
    z.object({
      name: z.string(),
      images: z.array(z.string()),
      ready: z.number(),
      desired: z.number(),
      status: z.enum(['healthy', 'deploying', 'unhealthy', 'scaled down']),
    }),
  ),
  repositoryData: z
    .object({
      openMRs: z.number(),
      issues: z.number(),
      mrs: z.array(
        z.object({
          number: z.number(),
          title: z.string(),
          url: z.string(),
          draft: z.boolean(),
          pipeline: z.enum(['passed', 'failed', 'running', 'no checks', 'unknown']),
        }),
      ),
      deployment: runSchema.nullable(),
      dependencyUpdate: dependencyUpdateSchema.nullable(),
    })
    .nullable(),
  errors: z.array(z.string()),
});

export const snapshotSchema = z.object({
  environment: z.string(),
  updatedAt: z.iso.datetime(),
  apps: z.array(applicationSchema),
});

export type Snapshot = z.infer<typeof snapshotSchema>;
export type ApplicationSignals = z.infer<typeof applicationSchema>;
export type DependencyUpdate = z.infer<typeof dependencyUpdateSchema>;
