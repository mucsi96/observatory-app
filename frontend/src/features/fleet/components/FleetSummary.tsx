import { Card, Text } from '@mucsi96/react-ui';
import type { Snapshot } from '../schema';
import styles from './FleetSummary.module.css';

export function FleetSummary({ snapshot }: { snapshot: Snapshot | undefined }) {
  const apps = snapshot?.apps ?? [];
  const healthy = apps.filter((app) => app.health === 'healthy').length;
  const available = apps.flatMap((app) => (app.repositoryData ? [app.repositoryData] : []));
  const partial = apps.some((app) => app.repository && !app.repositoryData);
  const total = (key: 'openMRs' | 'issues') =>
    available.length
      ? `${available.reduce((sum, repo) => sum + repo[key], 0)}${partial ? '+' : ''}`
      : '—';
  const metrics = [
    {
      label: 'Applications',
      value: snapshot ? apps.length : '—',
      caption: 'in your production fleet',
    },
    {
      label: 'Healthy',
      value: snapshot ? healthy : '—',
      caption: !snapshot
        ? 'waiting for a signal'
        : healthy === apps.length
          ? 'every application looking good'
          : `${apps.length - healthy} need a closer look`,
    },
    { label: 'Open MRs / PRs', value: total('openMRs'), caption: 'changes on the horizon' },
    { label: 'Open issues', value: total('issues'), caption: 'ideas and fixes to explore' },
  ];
  return (
    <section className={styles.metrics} aria-label="Fleet overview">
      {metrics.map((metric) => (
        <Card className={styles.metric} key={metric.label} role="article" aria-label={metric.label}>
          <Text className={styles.label}>{metric.label}</Text>
          <strong className={styles.value}>{metric.value}</strong>
          <Text muted className={styles.caption}>
            {metric.caption}
          </Text>
        </Card>
      ))}
    </section>
  );
}
