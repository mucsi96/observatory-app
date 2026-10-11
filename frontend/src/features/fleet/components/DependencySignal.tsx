import { ExternalLink } from '../../../components/ExternalLink';
import { StatusBadge } from '../../../components/StatusBadge';
import type { DependencyUpdate } from '../schema';
import { relativeAge } from '../selectors';

export function DependencySignal({
  update,
  now,
}: {
  update: DependencyUpdate | null | undefined;
  now: number;
}) {
  if (!update) return <span className="sub">Unavailable</span>;
  const { run, mrs, outcome, error } = update;
  return (
    <div className="signal-stack">
      {run ? (
        <>
          <div>
            Workflow: <StatusBadge status={run.status} />{' '}
            <ExternalLink href={run.url}>Run ↗</ExternalLink>
          </div>
          <span className="sub">{relativeAge(run.updatedAt, now)}</span>
          {error || outcome === 'unknown' ? (
            <span className="sub">PR creation unverified</span>
          ) : outcome === 'pending' ? (
            <span className="sub">Awaiting run result</span>
          ) : outcome === 'no PR created' ? (
            <StatusBadge status="pending" label="No PR created by this run" />
          ) : (
            <span className="sub">PRs created by this run:</span>
          )}
        </>
      ) : (
        <span className="sub">{error ? 'Unknown' : 'No dependency update runs'}</span>
      )}
      {error && <span className="sub">Some dependency signals unavailable</span>}
      {mrs.map((pr) => (
        <span className="sub" key={pr.number}>
          <ExternalLink href={pr.url}>
            #{pr.number} {pr.title}
          </ExternalLink>{' '}
          ({pr.state})
        </span>
      ))}
    </div>
  );
}
