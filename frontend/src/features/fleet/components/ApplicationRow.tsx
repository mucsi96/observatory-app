import { Button } from '@mucsi96/react-ui';
import { CircleX, LoaderCircle, Minus, Plus } from 'lucide-react';
import { ExternalLink } from '../../../components/ExternalLink';
import { StatusBadge } from '../../../components/StatusBadge';
import type { ApplicationSignals } from '../schema';
import { imageVersion, relativeAge } from '../selectors';
import { ApplicationDetails } from './ApplicationDetails';
import { DependencySignal } from './DependencySignal';
import styles from './ApplicationRow.module.css';
import signalStyles from './Signal.module.css';

interface Props {
  app: ApplicationSignals;
  expanded: boolean;
  onToggle: () => void;
  now: number;
}

export function ApplicationRow({ app, expanded, onToggle, now }: Props) {
  const repo = app.repositoryData;
  const failing = repo?.mrs.filter((pr) => pr.pipeline === 'failed').length ?? 0;
  const running = repo?.mrs.filter((pr) => pr.pipeline === 'running').length ?? 0;
  const images = [...new Set(app.workloads.flatMap((workload) => workload.images))];
  const deployment = repo?.deployment;
  const initials = app.name
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .slice(0, 2);
  return (
    <>
      <tr className={styles.row}>
        <th scope="row">
          <div className={styles.name}>
            <span className={styles.icon} aria-hidden="true">
              {initials}
            </span>
            <div>
              <Button
                variant="text"
                className={styles.toggle}
                onPress={onToggle}
                aria-expanded={expanded}
                aria-controls={expanded ? `details-${app.namespace}` : undefined}
              >
                {app.name}{' '}
                {expanded ? (
                  <Minus size={14} aria-hidden="true" />
                ) : (
                  <Plus size={14} aria-hidden="true" />
                )}
              </Button>
            </div>
          </div>
        </th>
        <td className={styles.technology}>
          <span>
            {app.stack?.frontend ?? 'Unknown'} / {app.stack?.backend ?? 'Unknown'}
          </span>
        </td>
        <td>
          <StatusBadge status={app.health} />
        </td>
        <td>
          {images.length ? (
            images.map((image) => (
              <code className={signalStyles.version} title={image} key={image}>
                {imageVersion(image)}
              </code>
            ))
          ) : (
            <span className={signalStyles.meta}>Not available</span>
          )}
        </td>
        <td>
          {deployment ? (
            <>
              <ExternalLink href={deployment.url}>
                {deployment.status.replaceAll('_', ' ')}
              </ExternalLink>
              <span className={signalStyles.meta}>{relativeAge(deployment.updatedAt, now)}</span>
            </>
          ) : (
            <span className={signalStyles.meta}>No recent deploy data</span>
          )}
        </td>
        <td>
          <DependencySignal update={repo?.dependencyUpdate} now={now} />
        </td>
        <td>
          {repo ? (
            <>
              <ExternalLink
                href={`https://github.com/${app.repository}/pulls`}
                className={styles.count}
              >
                {repo.openMRs}
              </ExternalLink>
              <span className={styles.pipelineStatuses}>
                <span
                  className={styles.failed}
                  data-empty={failing === 0}
                  role="img"
                  aria-label={`${failing} failing`}
                  title={`${failing} failing`}
                >
                  <CircleX size={14} aria-hidden="true" />
                  <span aria-hidden="true">{failing}</span>
                </span>
                <span
                  className={styles.running}
                  data-empty={running === 0}
                  role="img"
                  aria-label={`${running} running`}
                  title={`${running} running`}
                >
                  <LoaderCircle size={14} aria-hidden="true" />
                  <span aria-hidden="true">{running}</span>
                </span>
              </span>
            </>
          ) : (
            '—'
          )}
        </td>
        <td>
          {repo ? (
            <ExternalLink
              href={`https://github.com/${app.repository}/issues`}
              className={styles.count}
            >
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
