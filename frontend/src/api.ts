import { z } from 'zod';

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

// Authentication belongs to the gateway. Never send API requests to an upstream host.
export async function fetchJson<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error('API requests must be same-origin');
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  const response = await fetch(url, {
    ...init,
    headers,
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
  });
  const body: unknown = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : null;
  if (!response.ok || body === null) throw new ApiError(response.status, body);
  return schema.parse(body);
}
