import { ExternalLink } from '../../../components/ExternalLink';
import { StatusBadge } from '../../../components/StatusBadge';
import type { ApplicationSignals } from '../schema';

export function ApplicationDetails({ app }: { app: ApplicationSignals }) {
  return (
    <tr className="details" id={`details-${app.namespace}`}>
      <td colSpan={7}>
        <div className="detail-links">
          <ExternalLink href={app.url}>Open application ↗</ExternalLink>
          {app.repository && (
            <ExternalLink href={`https://github.com/${app.repository}`}>Repository ↗</ExternalLink>
          )}
        </div>
        <div className="detail-grid">
          <section aria-label={`${app.name} workloads`}>
            <h3>Production workloads</h3>
            {app.workloads.length ? (
              app.workloads.map((workload) => (
                <div className="detail-item" key={workload.name}>
                  <div>
                    {workload.name}
                    <span className="sub">
                      {workload.ready} / {workload.desired} replicas available
                    </span>
                    {[...new Set(workload.images)].map((image) => (
                      <code className="version" key={image}>
                        {image}
                      </code>
                    ))}
                  </div>
                  <StatusBadge status={workload.status} />
                </div>
              ))
            ) : (
              <p className="sub">No deployment data available.</p>
            )}
          </section>
          <section aria-label={`${app.name} pull requests`}>
            <h3>Merge requests / pull requests</h3>
            {app.repositoryData ? (
              app.repositoryData.mrs.length ? (
                app.repositoryData.mrs.map((pr) => (
                  <div className="detail-item" key={pr.number}>
                    <div>
                      <ExternalLink href={pr.url}>
                        #{pr.number} {pr.title}
                      </ExternalLink>
                      {pr.draft && <span className="sub">Draft</span>}
                    </div>
                    <StatusBadge status={pr.pipeline} />
                  </div>
                ))
              ) : (
                <p className="sub">All clear. No open merge requests.</p>
              )
            ) : (
              <p className="sub">Repository data unavailable.</p>
            )}
          </section>
        </div>
        {app.errors.map((error) => (
          <p className="error" key={error}>
            {error}
          </p>
        ))}
      </td>
    </tr>
  );
}
