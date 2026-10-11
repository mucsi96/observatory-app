import type { ApplicationSignals, DependencyUpdate } from './schema';

export type FleetFilter = 'all' | 'attention' | 'healthy';

const failures = new Set([
  'unhealthy',
  'failed',
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
  'stale',
]);
const pending = new Set([
  'running',
  'queued',
  'in_progress',
  'deploying',
  'degraded',
  'pending',
  'waiting',
  'requested',
]);

export function statusTone(status: string) {
  if (['healthy', 'passed', 'success'].includes(status)) return 'good';
  if (failures.has(status)) return 'bad';
  if (pending.has(status)) return 'pending';
  return 'neutral';
}

export function dependencyNeedsAttention(update: DependencyUpdate | null | undefined) {
  return Boolean(
    update?.run &&
    (failures.has(update.run.status) ||
      ['no PR created', 'unknown'].includes(update.outcome) ||
      update.error),
  );
}

export function needsAttention(app: ApplicationSignals) {
  const repo = app.repositoryData;
  return (
    app.health !== 'healthy' ||
    app.errors.length > 0 ||
    repo?.mrs.some((pr) => pr.pipeline === 'failed') ||
    (repo?.deployment && failures.has(repo.deployment.status)) ||
    dependencyNeedsAttention(repo?.dependencyUpdate)
  );
}

export function filterApplications(apps: ApplicationSignals[], query: string, filter: FleetFilter) {
  const search = query.toLocaleLowerCase().trim();
  return apps.filter(
    (app) =>
      `${app.name} ${app.namespace} ${app.repository}`.toLocaleLowerCase().includes(search) &&
      (filter === 'all' || (filter === 'healthy' ? app.health === 'healthy' : needsAttention(app))),
  );
}

export function relativeAge(date: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(date)) / 60_000));
  if (!Number.isFinite(minutes)) return 'unknown time';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export function imageVersion(image: string) {
  if (image.includes('@')) return image.split('@')[1].slice(0, 19);
  const name = image.slice(image.lastIndexOf('/') + 1);
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : 'latest (implicit)';
}

export function hostname(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'Address unavailable';
  }
}
