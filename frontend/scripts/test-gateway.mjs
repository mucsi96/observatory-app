// Local E2E gateway/identity fixture. Never included in production images.
import { createServer, request as proxyRequest } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { prepareClient } from './static-client.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const port = Number(process.env.TEST_GATEWAY_PORT ?? 8080);
const apiPort = port + 1;
const identityPort = Number(process.env.TEST_IDENTITY_PORT ?? 9180);
const issuer = `http://127.0.0.1:${identityPort}/default`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode({ iss: issuer, aud: 'observatory-test-api', sub: 'test-user', exp: now + 600, nbf: now - 5, scp: 'api-access', roles: ['readApps'], ...overrides })}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
const identity = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/default/.well-known/openid-configuration')
    return res.end(JSON.stringify({ issuer, jwks_uri: `http://127.0.0.1:${identityPort}/keys` }));
  if (req.url === '/keys') return res.end(JSON.stringify({ keys: [jwk] }));
  if (req.url?.startsWith('/token')) {
    const overrides = JSON.parse(new URL(req.url, issuer).searchParams.get('claims') ?? '{}');
    return res.end(JSON.stringify({ access_token: token(overrides) }));
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => identity.listen(identityPort, '127.0.0.1', resolve));
const assetBaseUrl = `http://localhost:${port + 2}/assets/`;
const prepared = await mkdtemp(`${tmpdir()}/observatory-static-`);
const documentHeaders = await prepareClient(`${root}/frontend/dist`, prepared, assetBaseUrl);
const contentTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};
const assets = createServer(async (req, res) => {
  const url = new URL(req.url, assetBaseUrl);
  // Collector fixtures use isolated random-port app origins on the same loopback host.
  if (
    /^http:\/\/127\.0\.0\.1:\d+$/.test(req.headers.origin ?? '') &&
    !url.searchParams.has('no-cors')
  ) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
  }
  const path = resolve(prepared, `.${decodeURIComponent(url.pathname)}`);
  if (!path.startsWith(`${prepared}/assets/`) || req.headers.cookie || req.headers.authorization) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(path);
    res.setHeader('Content-Type', contentTypes[extname(path)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => assets.listen(port + 2, resolve));
const inventory = process.env.CONFIG_FILE ?? `${root}/config.example.json`;
const env = {
  ...process.env,
  CONFIG_FILE: inventory,
  LISTEN_ADDR: `127.0.0.1:${apiPort}`,
  OIDC_ISSUER: issuer,
  API_CLIENT_ID: 'observatory-test-api',
};
const image = process.env.OBSERVATORY_CONTAINER_IMAGE;
const backend = image
  ? spawn(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'host',
        '--read-only',
        '--cap-drop',
        'ALL',
        '-e',
        'CONFIG_FILE=/config/config.json',
        '-e',
        `LISTEN_ADDR=${env.LISTEN_ADDR}`,
        '-e',
        `OIDC_ISSUER=${issuer}`,
        '-e',
        `API_CLIENT_ID=${env.API_CLIENT_ID}`,
        '-v',
        `${inventory}:/config/config.json:ro`,
        image,
      ],
      { stdio: 'inherit' },
    )
  : spawn(`${root}/target/debug/observatory`, [], { env, stdio: 'inherit' });
function proxy(req, res, target, headers = {}) {
  const upstream = proxyRequest(
    target,
    { method: req.method, headers: { ...req.headers, ...headers } },
    (incoming) => {
      res.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(res);
    },
  );
  upstream.on('error', () => res.writeHead(503).end());
  req.pipe(upstream);
}
const gateway = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz')
    return proxy(req, res, `http://127.0.0.1:${apiPort}${req.url}`, {
      authorization: `Bearer ${token()}`,
    });
  if (url.pathname === '/_telemetry/collect') {
    req.resume();
    res.writeHead(202).end('ok');
    return;
  }
  if (url.pathname === '/oauth2/userinfo') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ email: 'owner@example.test' }));
    return;
  }
  const document =
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    req.headers['sec-fetch-dest'] === 'document' ||
    req.headers.accept?.includes('text/html');
  if (!document) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(`${prepared}/documents/index.html`);
    for (const [name, value] of Object.entries(documentHeaders)) res.setHeader(name, value);
    res.setHeader('Content-Type', 'text/html');
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => gateway.listen(port, '127.0.0.1', resolve));
function stop() {
  backend.kill('SIGTERM');
  assets.close();
  void rm(prepared, { recursive: true, force: true });
  gateway.close();
  identity.close();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
backend.on('exit', (code) => {
  stop();
  process.exitCode = code ?? 1;
});
