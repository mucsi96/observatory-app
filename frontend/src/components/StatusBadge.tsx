import { statusTone } from '../features/fleet/selectors';

export function StatusBadge({
  status,
  label = status.replaceAll('_', ' '),
}: {
  status: string;
  label?: string;
}) {
  return <span className={`badge badge--${statusTone(status)}`}>{label}</span>;
}
