import { Minus, Plus } from 'lucide-react';
import { ExternalLink } from '../../../components/ExternalLink';
import { StatusBadge } from '../../../components/StatusBadge';
import type { ApplicationSignals } from '../schema';
import { hostname, imageVersion, relativeAge } from '../selectors';
import { ApplicationDetails } from './ApplicationDetails';
import { DependencySignal } from './DependencySignal';

interface Props {
  app: ApplicationSignals;
  expanded: boolean;
  onToggle: () => void;
  now: number;
}

export function ApplicationRow({ app, expanded, onToggle, now }: Props) {
  const repo = app.repositoryData;
  const images = [...new Set(app.workloads.flatMap((workload) => workload.images))];
  const deployment = repo?.deployment;
  const initials = app.name
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .slice(0, 2);
  return (
    <>
      <tr className="app-row">
        <th scope="row">
          <div className="app-name">
            <span className="app-icon" aria-hidden="true">
              {initials}
            </span>
            <div>
              <button
                className="app-toggle"
                onClick={onToggle}
                aria-expanded={expanded}
                aria-controls={expanded ? `details-${app.namespace}` : undefined}
              >
                {app.name}{' '}
                {expanded ? (
                  <Minus size={14} aria-hidden="true" />
                ) : (
                  <Plus size={14} aria-hidden="true" />
                )}
              </button>
              <span className="sub">{hostname(app.url)}</span>
            </div>
          </div>
        </th>
        <td className="technology-stack">
          <span>
            {app.stack?.frontend ?? 'Unknown'} / {app.stack?.backend ?? 'Unknown'}
          </span>
          <span className="sub">Frontend / Backend</span>
        </td>
        <td>
          <StatusBadge status={app.health} />
        </td>
        <td>
          {images.length ? (
            images.map((image) => (
              <code className="version" title={image} key={image}>
                {imageVersion(image)}
              </code>
            ))
          ) : (
            <span className="sub">Not available</span>
          )}
        </td>
        <td>
          {deployment ? (
            <>
              <ExternalLink href={deployment.url}>
                {deployment.status.replaceAll('_', ' ')}
              </ExternalLink>
              <span className="sub">{relativeAge(deployment.updatedAt, now)}</span>
            </>
          ) : (
            <span className="sub">No recent deploy data</span>
          )}
        </td>
        <td>
          <DependencySignal update={repo?.dependencyUpdate} now={now} />
        </td>
        <td>
          {repo ? (
            <>
              <ExternalLink href={`https://github.com/${app.repository}/pulls`} className="count">
                {repo.openMRs}
              </ExternalLink>
              <span className="sub">
                {repo.mrs.filter((pr) => pr.pipeline === 'failed').length} failing ·{' '}
                {repo.mrs.filter((pr) => pr.pipeline === 'running').length} running
              </span>
            </>
          ) : (
            '—'
          )}
        </td>
        <td>
          {repo ? (
            <ExternalLink href={`https://github.com/${app.repository}/issues`} className="count">
              {repo.issues}
            </ExternalLink>
          ) : (
            '—'
          )}
        </td>
      </tr>
      {expanded && <ApplicationDetails app={app} />}
    </>
  );
}
