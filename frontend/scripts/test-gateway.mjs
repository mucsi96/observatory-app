// Local E2E gateway/identity fixture. Never included in production images.
import { createServer, request as proxyRequest } from 'node:http';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
const config = {
  clientAppName: 'observatory-client',
  clientLogUrl: '/_telemetry/collect',
};
const script = `window.__APP_CONFIG__ = ${JSON.stringify(config)};`;
const hash = createHash('sha256').update(script).digest('base64');
const template = await readFile(`${root}/frontend/nginx.conf.template`, 'utf8');
const csp = template
  .match(/add_header Content-Security-Policy "([^"]+)"/)[1]
  .replace('${APP_CONFIG_CSP_HASH}', hash);
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
const clientImage = process.env.OBSERVATORY_CLIENT_IMAGE;
const client = clientImage
  ? spawn(
      'docker',
      [
        'run',
        '--rm',
        '-p',
        `127.0.0.1:${port + 2}:8000`,
        '-e',
        `APP_CONFIG_CSP_HASH=${hash}`,
        clientImage,
      ],
      { stdio: 'inherit' },
    )
  : null;
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
    req.headers['sec-fetch-dest'] === 'document' ||
    req.headers.accept?.includes('text/html');
  const path = document ? '/index.html' : url.pathname;
  try {
    if (clientImage && !document) return proxy(req, res, `http://127.0.0.1:${port + 2}${req.url}`);
    const fullPath = resolve(root, `frontend/dist${path}`);
    if (!fullPath.startsWith(`${root}/frontend/dist/`)) {
      res.writeHead(404).end();
      return;
    }
    const response = clientImage ? await fetch(`http://127.0.0.1:${port + 2}/index.html`) : null;
    if (response && !response.ok) throw new Error('client not ready');
    const body = response ? Buffer.from(await response.arrayBuffer()) : await readFile(fullPath);
    res.setHeader(
      'Content-Security-Policy',
      response?.headers.get('content-security-policy') ?? csp,
    );
    res.setHeader(
      'Content-Type',
      {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
      }[extname(path)] ?? 'application/octet-stream',
    );
    res.end(
      document ? body.toString().replace('"__APP_CONFIG_JSON__"', JSON.stringify(config)) : body,
    );
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => gateway.listen(port, '127.0.0.1', resolve));
function stop() {
  backend.kill('SIGTERM');
  client?.kill('SIGTERM');
  gateway.close();
  identity.close();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
backend.on('exit', (code) => {
  stop();
  process.exitCode = code ?? 1;
});
