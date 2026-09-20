import { test, expect } from '../fixtures';
test('keeps the SPA fresh and caches only hashed bundles immutably', async ({
  request,
}) => {
  for (const path of ['/', '/index.html', '/some/deep/link'])
    expect((await request.get(path)).headers()['cache-control']).toContain(
      'no-cache'
    );
  const html = await (await request.get('/')).text();
  const bundles = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(
    ([, path]) => path
  );
  expect(bundles.length).toBeGreaterThan(0);
  for (const path of bundles)
    expect(
      (await request.get(`/${path}`)).headers()['cache-control']
    ).toContain('immutable');
});
