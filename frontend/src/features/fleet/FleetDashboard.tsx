import { useState } from 'react';
import { Alert, Badge, Button, Card, Heading, Select, Text, TextField } from '@mucsi96/react-ui';
import { Diamond, RefreshCw } from 'lucide-react';
import { useNow } from '../../hooks/useNow';
import { useFleetSnapshot } from './api';
import { filterApplications, relativeAge, type FleetFilter } from './selectors';
import { FleetTable } from './components/FleetTable';
import { FleetSummary } from './components/FleetSummary';
import styles from './FleetDashboard.module.css';

const filters = [
  { id: 'all', label: 'All applications' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'healthy', label: 'Healthy' },
];

export function FleetDashboard() {
  const { data: snapshot, error, isFetching, refetch } = useFleetSnapshot();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FleetFilter>('all');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const now = useNow();
  const apps = filterApplications(snapshot?.apps ?? [], search, filter);
  const stale = snapshot && now - Date.parse(snapshot.updatedAt) > 180_000;
  const partial = snapshot?.apps.some((app) => app.errors.length > 0);
  const notice = error
    ? `${error.message}${snapshot ? ' Showing the last received snapshot.' : ''}`
    : stale
      ? 'Signals are stale. The last snapshot is shown below; check the dashboard collector.'
      : partial
        ? 'Some signals are unavailable. Expand an application for details. + indicates a partial total.'
        : null;

  function toggle(namespace: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(namespace)) next.delete(namespace);
      else next.add(namespace);
      return next;
    });
  }

  return (
    <>
      <header className={styles.topbar}>
        <a className={styles.brand} href="/" aria-label="Observatory home">
          <Diamond aria-hidden="true" className={styles.brandMark} size={28} />
          observatory <span className={styles.brandDivider}>/</span>
          <span className={styles.environmentName}>{snapshot?.environment ?? 'connecting'}</span>
        </a>
        <Badge className={styles.environment}>Production</Badge>
      </header>
      <main className={styles.main}>
        <section className={styles.intro}>
          <div>
            <Text className={styles.eyebrow}>YOUR APPLICATIONS, AT A GLANCE</Text>
            <Heading level={1} className={styles.title}>
              A little clarity.
              <br />
              Across your entire fleet.
            </Heading>
            <Text muted className={styles.subtitle}>
              Health, releases, and work in motion. One quiet place to keep an eye on it all.
            </Text>
          </div>
          <div className={styles.sync}>
            <span role="status">
              {snapshot
                ? `Updated ${relativeAge(snapshot.updatedAt, now)}`
                : 'Connecting to your fleet…'}
            </span>
            <Button variant="outlined" onPress={() => void refetch()} isDisabled={isFetching}>
              <RefreshCw
                size={15}
                aria-hidden="true"
                className={isFetching ? styles.spinning : undefined}
              />{' '}
              Refresh
            </Button>
          </div>
        </section>
        {notice && (
          <Alert tone={error ? 'error' : 'warn'} className={styles.notice}>
            {notice}
          </Alert>
        )}
        <FleetSummary snapshot={snapshot} />
        <Card className={styles.fleet} aria-labelledby="fleet-title">
          <div className={styles.toolbar}>
            <div>
              <Heading level={2} id="fleet-title" className={styles.fleetTitle}>
                Application fleet <Badge className={styles.visibleCount}>{apps.length}</Badge>
              </Heading>
              <Text muted className={styles.fleetSubtitle}>
                Live signals. Real production versions.
              </Text>
            </div>
            <div className={styles.controls}>
              <TextField
                className={styles.search}
                type="search"
                label="Find an application"
                placeholder="Find an application…"
                value={search}
                onChange={setSearch}
              />
              <Select
                className={styles.filter}
                label="Filter applications"
                options={filters}
                value={filter}
                onChange={(value) => {
                  if (filters.some((option) => option.id === value))
                    setFilter(value as FleetFilter);
                }}
              />
            </div>
          </div>
          <FleetTable
            apps={apps}
            expanded={expanded}
            onToggle={toggle}
            now={now}
            emptyMessage={
              snapshot
                ? 'No applications match this view. Try another search or filter.'
                : error
                  ? 'Waiting for live data. Use Refresh to try again.'
                  : 'Gathering signals from your applications…'
            }
          />
          <Text muted className={styles.tableNote}>
            Health reflects Kubernetes readiness · Versions are deployed container images · Expand
            an app for workload and MR details
          </Text>
        </Card>
        <footer className={styles.footer}>
          <span>
            <Diamond size={16} aria-hidden="true" /> Built for a clearer view.
          </span>
          <span>Rust + React · Shared live fleet signals</span>
        </footer>
      </main>
    </>
  );
}
