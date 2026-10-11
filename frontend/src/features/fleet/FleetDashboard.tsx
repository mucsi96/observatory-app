import { useState } from 'react';
import { Diamond, RefreshCw, Search } from 'lucide-react';
import { useNow } from '../../hooks/useNow';
import { useFleetSnapshot } from './api';
import { filterApplications, relativeAge, type FleetFilter } from './selectors';
import { ApplicationRow } from './components/ApplicationRow';
import { FleetSummary } from './components/FleetSummary';

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
      <header className="topbar">
        <a className="brand" href="/" aria-label="Observatory home">
          <Diamond aria-hidden="true" className="brand-mark" size={28} />
          observatory <span className="brand-divider">/</span>
          <span className="environment-name">{snapshot?.environment ?? 'connecting'}</span>
        </a>
        <span className="environment">
          <span className="dot" /> Production
        </span>
      </header>
      <main>
        <section className="intro">
          <div>
            <p className="eyebrow">YOUR APPLICATIONS, AT A GLANCE</p>
            <h1>
              A little clarity.
              <br />
              Across your entire fleet.
            </h1>
            <p className="subtitle">
              Health, releases, and work in motion. One quiet place to keep an eye on it all.
            </p>
          </div>
          <div className="sync">
            <span role="status">
              {snapshot
                ? `Updated ${relativeAge(snapshot.updatedAt, now)}`
                : 'Connecting to your fleet…'}
            </span>
            <button className="refresh" onClick={() => void refetch()} disabled={isFetching}>
              <RefreshCw
                size={15}
                aria-hidden="true"
                className={isFetching ? 'spinning' : undefined}
              />{' '}
              Refresh
            </button>
          </div>
        </section>
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        <FleetSummary snapshot={snapshot} />
        <section className="fleet" aria-labelledby="fleet-title">
          <div className="toolbar">
            <div>
              <h2 id="fleet-title">
                Application fleet <span className="visible-count">{apps.length}</span>
              </h2>
              <p>Live signals. Real production versions.</p>
            </div>
            <div className="controls">
              <label className="search">
                <Search size={16} aria-hidden="true" />
                <input
                  type="search"
                  placeholder="Find an application…"
                  aria-label="Find an application"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <label className="sr-only" htmlFor="fleet-filter">
                Filter applications
              </label>
              <select
                id="fleet-filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value as FleetFilter)}
              >
                <option value="all">All applications</option>
                <option value="attention">Needs attention</option>
                <option value="healthy">Healthy</option>
              </select>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Production application signals</caption>
              <thead>
                <tr>
                  {[
                    'Application',
                    'Health',
                    'Production version',
                    'Last deployment',
                    'Dependency update',
                    'MRs / PRs',
                    'Issues',
                  ].map((title) => (
                    <th scope="col" key={title}>
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {apps.length ? (
                  apps.map((app) => (
                    <ApplicationRow
                      key={app.namespace}
                      app={app}
                      expanded={expanded.has(app.namespace)}
                      onToggle={() => toggle(app.namespace)}
                      now={now}
                    />
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="empty">
                      {snapshot
                        ? 'No applications match this view. Try another search or filter.'
                        : error
                          ? 'Waiting for live data. Use Refresh to try again.'
                          : 'Gathering signals from your applications…'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="table-note">
            Health reflects Kubernetes readiness · Versions are deployed container images · Expand
            an app for workload and MR details
          </p>
        </section>
        <footer>
          <span>
            <Diamond size={16} aria-hidden="true" /> Built for a clearer view.
          </span>
          <span>Rust + React · Shared live fleet signals</span>
        </footer>
      </main>
    </>
  );
}
