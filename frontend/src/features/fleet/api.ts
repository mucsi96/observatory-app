import { useMutation, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, fetchJson } from '../../api';
import { snapshotSchema } from './schema';

export async function fetchSnapshot(signal: AbortSignal) {
  try {
    return await fetchJson('/api/apps', snapshotSchema, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ApiError && error.status === 503) {
      throw new Error('Initial collection is still in progress. Retrying shortly…', {
        cause: error,
      });
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      throw new Error('The collector returned an invalid snapshot. Retrying shortly…', {
        cause: error,
      });
    }
    throw new Error(
      'Could not update signals. Check your connection or sign in again by reloading this page.',
      { cause: error },
    );
  }
}

const createdIssueSchema = z.object({ number: z.number().int().positive(), url: z.url() });
const failureSchema = z.object({ error: z.string() });

interface IssueDraft {
  repository: string;
  title: string;
  description: string;
}

async function createIssue(draft: IssueDraft) {
  try {
    return await fetchJson('/api/issues', createdIssueSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Observatory-Request': 'create-issue' },
      body: JSON.stringify({ ...draft, title: draft.title.trim() }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401)
        throw new Error('Your session expired. Reload and sign in to Observatory again.', {
          cause: error,
        });
      if (error.status === 403)
        throw new Error(
          'Issue creation requires the createIssues role. Ask your Observatory administrator for access.',
          { cause: error },
        );
      const failure = failureSchema.safeParse(error.body);
      if (failure.success) throw new Error(failure.data.error, { cause: error });
    }
    throw new Error(
      'Could not confirm issue creation. Check the repository before trying again to avoid a duplicate.',
      { cause: error },
    );
  }
}

export function useCreateIssue() {
  return useMutation({
    mutationFn: createIssue,
    retry: false,
    // Do not queue a write to replay later when connectivity returns.
    networkMode: 'always',
  });
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
