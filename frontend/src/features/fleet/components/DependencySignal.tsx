import { ExternalLink } from '../../../components/ExternalLink';
import { StatusBadge } from '../../../components/StatusBadge';
import type { DependencyUpdate } from '../schema';
import { relativeAge } from '../selectors';
import styles from './DependencySignal.module.css';
import signalStyles from './Signal.module.css';

export function DependencySignal({
  update,
  now,
}: {
  update: DependencyUpdate | null | undefined;
  now: number;
}) {
  if (!update) return <span className={signalStyles.meta}>Unavailable</span>;
  const { run, mrs, outcome, error } = update;
  return (
    <div className={styles.stack}>
      {run ? (
        <>
          <div>
            Workflow: <StatusBadge status={run.status} />{' '}
            <ExternalLink href={run.url}>Run ↗</ExternalLink>
          </div>
          <span className={signalStyles.meta}>{relativeAge(run.updatedAt, now)}</span>
          {error || outcome === 'unknown' ? (
            <span className={signalStyles.meta}>PR creation unverified</span>
          ) : outcome === 'pending' ? (
            <span className={signalStyles.meta}>Awaiting run result</span>
          ) : outcome === 'no PR created' ? (
            <StatusBadge status="pending" label="No PR created by this run" />
          ) : (
            <span className={signalStyles.meta}>PRs created by this run:</span>
          )}
        </>
      ) : (
        <span className={signalStyles.meta}>{error ? 'Unknown' : 'No dependency update runs'}</span>
      )}
      {error && <span className={signalStyles.meta}>Some dependency signals unavailable</span>}
      {mrs.map((pr) => (
        <span className={signalStyles.meta} key={pr.number}>
          <ExternalLink href={pr.url}>
            #{pr.number} {pr.title}
          </ExternalLink>{' '}
          ({pr.state})
        </span>
      ))}
    </div>
  );
}
