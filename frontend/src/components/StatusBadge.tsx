import { Badge } from '@mucsi96/react-ui';
import { statusTone } from '../features/fleet/selectors';

export function StatusBadge({
  status,
  label = status.replaceAll('_', ' '),
}: {
  status: string;
  label?: string;
}) {
  return <Badge tone={statusTone(status)}>{label}</Badge>;
}
