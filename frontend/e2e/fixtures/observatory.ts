import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import type { Snapshot } from '../../src/features/fleet/schema';

export interface AppDescriptor {
  name: string;
  namespace: string;
  repository?: string;
  url: string;
  deploymentWorkflow?: string;
  stack?: { frontend?: string | null; backend?: string | null };
}

export interface UpstreamRequest {
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
  accept: string | undefined;
  logsUrl: string;
}

export interface UpstreamResponse {
  status?: number;
  json?: unknown;
  body?: Uint8Array | string;
  headers?: Record<string, string>;
}

export type Handler = (request: UpstreamRequest) => UpstreamResponse | Promise<UpstreamResponse>;

interface Options {
  apps?: AppDescriptor[];
  github?: Handler;
  kubernetes?: Handler;
  logs?: Handler;
}

export interface Observatory {
  url: string;
  requests: { github: UpstreamRequest[]; kubernetes: UpstreamRequest[]; logs: UpstreamRequest[] };
  logsUrl: string;
  process: ChildProcess;
  snapshot: () => Promise<Snapshot>;
  close: () => Promise<void>;
}

export function descriptor(namespace = 'app', repository = 'o/r'): AppDescriptor {
  return { name: namespace, namespace, repository, url: `https://${namespace}.example.com` };
}

export function defaultGitHub(request: UpstreamRequest): UpstreamResponse {
  if (request.path === '/search/issues')
    return { json: { total_count: 3, incomplete_results: false } };
  if (request.path.endsWith('/pulls')) return { json: [] };
  if (request.path.endsWith('/actions/runs')) return { json: { workflow_runs: [] } };
  if (request.path.endsWith('/actions/workflows')) return { json: { workflows: [] } };
  if (request.path.endsWith('/git/trees/HEAD')) return { json: { tree: [], truncated: false } };
  return { status: 404, json: { message: 'Unexpected request' } };
}

export function deployment(
  options: {
    name?: string;
    generation?: number;
    observed?: number;
    desired?: number;
    ready?: number;
    replicas?: number;
    updated?: number;
    conditions?: { type: string; status: string }[];
  } = {},
) {
  return {
    metadata: { name: options.name ?? 'server', generation: options.generation ?? 2 },
    spec: {
      replicas: options.desired ?? 1,
      template: { spec: { containers: [{ name: 'app', image: 'app:prod-12' }] } },
    },
    status: {
      observedGeneration: options.observed ?? 2,
      replicas: options.replicas ?? 1,
      updatedReplicas: options.updated ?? 1,
      availableReplicas: options.ready ?? 1,
      conditions: options.conditions ?? [],
    },
  };
}

function send(response: ServerResponse, result: UpstreamResponse) {
  const body = result.json === undefined ? (result.body ?? '') : JSON.stringify(result.json);
  response.writeHead(result.status ?? 200, {
    'Content-Type': result.json === undefined ? 'application/octet-stream' : 'application/json',
    ...result.headers,
  });
  response.end(body);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock server did not bind');
  return `https://127.0.0.1:${address.port}`;
}

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local port available');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function startObservatory(
  request: APIRequestContext,
  options: Options,
): Promise<Observatory> {
  const directory = await mkdtemp(join(tmpdir(), 'observatory-e2e-'));
  const keyFile = join(directory, 'key.pem');
  const caFile = join(directory, 'ca.pem');
  const caKeyFile = join(directory, 'ca-key.pem');
  const certFile = join(directory, 'server.pem');
  const csrFile = join(directory, 'server.csr');
  const extensionsFile = join(directory, 'server.ext');
  const tokenFile = join(directory, 'token');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      caKeyFile,
      '-out',
      caFile,
      '-subj',
      '/CN=Observatory E2E CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ],
    { stdio: 'ignore' },
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      csrFile,
      '-subj',
      '/CN=localhost',
    ],
    { stdio: 'ignore' },
  );
  await writeFile(
    extensionsFile,
    'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',
  );
  execFileSync(
    'openssl',
    [
      'x509',
      '-req',
      '-in',
      csrFile,
      '-CA',
      caFile,
      '-CAkey',
      caKeyFile,
      '-CAcreateserial',
      '-days',
      '1',
      '-out',
      certFile,
      '-extfile',
      extensionsFile,
    ],
    { stdio: 'ignore' },
  );
  const tls = { key: await readFile(keyFile), cert: await readFile(certFile) };
  await writeFile(tokenFile, 'kubernetes-private-token', { mode: 0o600 });
  const configFile = join(directory, 'config.json');
  await writeFile(
    configFile,
    JSON.stringify({ environment: 'test', apps: options.apps ?? [descriptor()] }),
  );
  const requests: Observatory['requests'] = { github: [], kubernetes: [], logs: [] };

  function upstream(kind: keyof typeof requests, handler: Handler) {
    return createHttpsServer(tls, async (incoming: IncomingMessage, response: ServerResponse) => {
      const url = new URL(incoming.url ?? '/', 'https://localhost');
      const event = {
        path: url.pathname,
        query: url.searchParams,
        authorization: incoming.headers.authorization,
        accept: incoming.headers.accept,
        logsUrl,
      };
      requests[kind].push(event);
      try {
        send(response, await handler(event));
      } catch {
        send(response, { status: 500, json: { message: 'Fixture failure' } });
      }
    });
  }

  const githubServer = upstream('github', options.github ?? defaultGitHub);
  const kubeServer = upstream(
    'kubernetes',
    options.kubernetes ?? (() => ({ json: { metadata: {}, items: [deployment()] } })),
  );
  const logsServer = upstream('logs', options.logs ?? (() => ({ status: 404 })));
  const [githubUrl, kubeUrl, logsUrl] = await Promise.all([
    listen(githubServer),
    listen(kubeServer),
    listen(logsServer),
  ]);
  const url = `http://127.0.0.1:${await availablePort()}`;
  const process = spawn(
    fileURLToPath(new URL('../../../target/debug/observatory', import.meta.url)),
    [],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        ...globalThis.process.env,
        CONFIG_FILE: configFile,
        OIDC_ISSUER: 'http://127.0.0.1:9180/default',
        API_CLIENT_ID: 'observatory-test-api',
        LISTEN_ADDR: new URL(url).host,
        GITHUB_TOKEN: 'github-private-token',
        GITHUB_API_URL: githubUrl,
        GITHUB_CA_FILE: caFile,
        KUBERNETES_API_URL: kubeUrl,
        KUBERNETES_CA_FILE: caFile,
        KUBERNETES_TOKEN_FILE: tokenFile,
        RUST_LOG: 'observatory=info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  process.stdout?.on('data', (chunk) => {
    output += chunk.toString();
  });
  process.stderr?.on('data', (chunk) => {
    output += chunk.toString();
  });

  async function close() {
    if (process.exitCode === null) {
      process.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          process.kill('SIGKILL');
          resolve();
        }, 12_000);
        process.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    for (const server of [githubServer, kubeServer, logsServer]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  }

  try {
    await expect
      .poll(
        async () => {
          if (process.exitCode !== null) throw new Error(`Rust server exited: ${output}`);
          try {
            return (await request.get(`${url}/healthz`)).status();
          } catch {
            return 0;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(200);
  } catch (error) {
    await close();
    throw error;
  }

  return {
    url,
    requests,
    logsUrl,
    process,
    close,
    snapshot: async () => {
      await expect
        .poll(async () => (await request.get(`${url}/api/apps`)).status(), { timeout: 60_000 })
        .toBe(200);
      return (await request.get(`${url}/api/apps`)).json() as Promise<Snapshot>;
    },
  };
}

export const test = base.extend<{ observatory: (options?: Options) => Promise<Observatory> }>({
  page: async ({ page }, use) => {
    const response = await fetch('http://127.0.0.1:9180/token');
    const { access_token } = await response.json();
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      // Fulfilled collector documents have no network address-space metadata in
      // Chromium. Fetch their assets through Playwright too; auth.spec exercises
      // genuine cross-origin browser requests and CORS without interception.
      if (url.origin === 'http://localhost:8082') {
        return route.fulfill({ response: await route.fetch() });
      }
      if (url.pathname.startsWith('/api/')) {
        return route.continue({
          headers: { ...route.request().headers(), Authorization: `Bearer ${access_token}` },
        });
      }
      const response = await route.fetch({
        url: `http://127.0.0.1:8080${url.pathname}${url.search}`,
      });
      await route.fulfill({ response });
    });
    await use(page);
  },
  request: async ({ playwright }, use) => {
    const response = await fetch('http://127.0.0.1:9180/token');
    const { access_token } = await response.json();
    const request = await playwright.request.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${access_token}` },
    });
    await use(request);
    await request.dispose();
  },
  observatory: async ({ request }, use) => {
    const servers: Observatory[] = [];
    await use(async (options = {}) => {
      const server = await startObservatory(request, options);
      servers.push(server);
      return server;
    });
    await Promise.all(servers.map((server) => server.close()));
  },
});

export { expect };
