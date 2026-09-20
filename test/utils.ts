import { createHash, randomBytes } from 'node:crypto';

// Obtain a real signed access token from the same mock OIDC provider used by
// the browser. Fixture readiness checks go through the protected API, not a
// test-only endpoint or an authentication bypass.
export async function mockAccessToken(): Promise<string> {
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: 'mock-client-id',
    redirect_uri: 'http://localhost:8170',
    scope: 'openid profile',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  });
  const authorization = await fetch(
    `http://localhost:8070/default/authorize?${params}`,
    { redirect: 'manual' }
  );
  const location = authorization.headers.get('location');
  if (authorization.status !== 302 || !location)
    throw new Error('Mock OIDC authorization failed');
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error('Mock OIDC returned no authorization code');
  const response = await fetch('http://localhost:8070/default/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'mock-client-id',
      code,
      code_verifier: verifier,
      redirect_uri: 'http://localhost:8170',
    }),
  });
  if (!response.ok) throw new Error('Mock OIDC token exchange failed');
  return (await response.json()).access_token;
}

export async function waitForSnapshot(since = 0): Promise<void> {
  const token = await mockAccessToken();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch('http://localhost:8170/api/apps', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const snapshot = await response.json();
      if (snapshot.apps.length === 3 && Date.parse(snapshot.updatedAt) >= since)
        return;
    } else if (response.status !== 503)
      throw new Error(`Snapshot request failed: ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Collector did not publish a fresh snapshot');
}
