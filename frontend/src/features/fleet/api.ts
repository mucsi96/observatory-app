import { useQuery } from '@tanstack/react-query';
import { snapshotSchema } from './schema';

export async function fetchSnapshot(signal: AbortSignal) {
  const response = await fetch('/api/apps', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (response.status === 503) {
    throw new Error('Initial collection is still in progress. Retrying shortly…');
  }
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error(
      'Could not update signals. Check your connection or sign in again by reloading this page.',
    );
  }
  const parsed = snapshotSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('The collector returned an invalid snapshot. Retrying shortly…');
  }
  return parsed.data;
}

export function useFleetSnapshot() {
  return useQuery({
    queryKey: ['fleet', 'snapshot'],
    queryFn: ({ signal }) => fetchSnapshot(signal),
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
    retry: false,
  });
}
