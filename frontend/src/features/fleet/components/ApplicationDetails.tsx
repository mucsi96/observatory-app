import { Alert, Heading } from '@mucsi96/react-ui';
import { ExternalLink } from '../../../components/ExternalLink';
import { StatusBadge } from '../../../components/StatusBadge';
import type { ApplicationSignals } from '../schema';
import styles from './ApplicationDetails.module.css';
import signalStyles from './Signal.module.css';

export function ApplicationDetails({ app }: { app: ApplicationSignals }) {
  return (
    <tr className={styles.details} id={`details-${app.namespace}`}>
      <td colSpan={8}>
        <div className={styles.links}>
          <ExternalLink href={app.url}>Open application ↗</ExternalLink>
          {app.repository && (
            <ExternalLink href={`https://github.com/${app.repository}`}>Repository ↗</ExternalLink>
          )}
        </div>
        <div className={styles.grid}>
          <section aria-label={`${app.name} browser availability`}>
            <Heading level={3} className={styles.heading}>
              Browser availability
            </Heading>
            {app.browserCheck ? (
              <>
                <ExternalLink href={app.browserCheck.url}>{app.browserCheck.status}</ExternalLink>
                <p>Last update: {app.browserCheck.updatedAt}</p>
              </>
            ) : (
              <p>No browser check evidence</p>
            )}
            <p>Checks must succeed within the last 30 minutes to confirm availability.</p>
          </section>
          <section aria-label={`${app.name} workloads`}>
            <Heading level={3} className={styles.heading}>
              Production workloads
            </Heading>
            {app.workloads.length ? (
              app.workloads.map((workload) => (
                <div className={styles.item} key={workload.name}>
                  <div>
                    {workload.name}
                    <span className={signalStyles.meta}>
                      {workload.ready} / {workload.desired} replicas available
                    </span>
                    {[...new Set(workload.images)].map((image) => (
                      <code className={signalStyles.version} key={image}>
                        {image}
                      </code>
                    ))}
                  </div>
                  <StatusBadge status={workload.status} />
                </div>
              ))
            ) : (
              <p className={signalStyles.meta}>No deployment data available.</p>
            )}
          </section>
          <section aria-label={`${app.name} pull requests`}>
            <Heading level={3} className={styles.heading}>
              Merge requests / pull requests
            </Heading>
            {app.repositoryData ? (
              app.repositoryData.mrs.length ? (
                app.repositoryData.mrs.map((pr) => (
                  <div className={styles.item} key={pr.number}>
                    <div>
                      <ExternalLink href={pr.url}>
                        #{pr.number} {pr.title}
                      </ExternalLink>
                      {pr.draft && <span className={signalStyles.meta}>Draft</span>}
                    </div>
                    <StatusBadge status={pr.pipeline} />
                  </div>
                ))
              ) : (
                <p className={signalStyles.meta}>All clear. No open merge requests.</p>
              )
            ) : (
              <p className={signalStyles.meta}>Repository data unavailable.</p>
            )}
          </section>
        </div>
        {app.errors.map((error) => (
          <Alert tone="error" className={styles.error} key={error}>
            {error}
          </Alert>
        ))}
      </td>
    </tr>
  );
}
