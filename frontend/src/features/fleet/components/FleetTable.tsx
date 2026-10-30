import type { ApplicationSignals } from '../schema';
import { applicationKey } from '../selectors';
import { ApplicationRow } from './ApplicationRow';
import styles from './FleetTable.module.css';

const columns = [
  'Application',
  'Frontend / Backend',
  'Health',
  'Production version',
  'Last deployment',
  'Dependency update',
  'MRs / PRs',
  'Issues',
];

interface Props {
  apps: ApplicationSignals[];
  expanded: ReadonlySet<string>;
  onToggle: (namespace: string) => void;
  now: number;
  emptyMessage: string;
}

export function FleetTable({ apps, expanded, onToggle, now, emptyMessage }: Props) {
  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <caption className={styles.caption}>Production application signals</caption>
        <thead>
          <tr>
            {columns.map((title) => (
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
                key={applicationKey(app)}
                app={app}
                expanded={expanded.has(applicationKey(app))}
                onToggle={() => onToggle(applicationKey(app))}
                now={now}
              />
            ))
          ) : (
            <tr>
              <td colSpan={columns.length} className={styles.empty}>
                {emptyMessage}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
