// Live test of the compose target: Traefik answers, the seeded OpenBao secret is readable through the HTTP API,
// and the .env renderer puts it back. Skips when Docker is unavailable or the host ports are taken.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { waitFor } from '../../../lib/wait.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const l0 = join(here, '..');
const compose = join(l0, 'compose.yml');

const ports = {
  http: Number(process.env.INFRA_HTTP_PORT ?? 8088),
  dashboard: Number(process.env.INFRA_DASHBOARD_PORT ?? 8089),
  bao: Number(process.env.OPENBAO_PORT ?? 8200),
};
const token = 'test-root-token';
const secret = `test-secret-${Date.now()}`;
const env = {
  ...process.env,
  INFRA_HTTP_PORT: String(ports.http),
  INFRA_DASHBOARD_PORT: String(ports.dashboard),
  OPENBAO_PORT: String(ports.bao),
  OPENBAO_DEV_ROOT_TOKEN: token,
  BAO_ADDR: `http://127.0.0.1:${ports.bao}`,
  BAO_TOKEN: token,
  OIDC_CLIENT_SECRET: secret,
};
const project = ['compose', '-p', 'l0-infra-test', '-f', compose];

function dockerAvailable() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** GET with an explicit Host header (fetch cannot set one). */
function getWithHost(port, host, path = '/') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host }, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

let skipReason = null;
let started = false;

before(async () => {
  if (!dockerAvailable()) {
    skipReason = 'Docker is not available';
    return;
  }
  for (const [name, port] of Object.entries(ports)) {
    if (!(await portFree(port))) {
      skipReason = `host port ${port} (${name}) is taken; set INFRA_HTTP_PORT / INFRA_DASHBOARD_PORT / OPENBAO_PORT`;
      return;
    }
  }
  started = true;
  await run('docker', [...project, 'up', '-d', '--wait', '--wait-timeout', '90'], { env, timeout: 180_000 });
  await run('bash', [join(l0, 'scripts', 'seed-secrets.sh')], { env, timeout: 30_000 });
});

after(async () => {
  if (!started) return;
  await run('docker', [...project, 'down', '-v', '--remove-orphans'], { env, timeout: 60_000 }).catch((err) => {
    console.error(`teardown failed: ${err.message}`);
  });
});

test('Traefik dashboard API answers', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const res = await waitFor(`http://127.0.0.1:${ports.dashboard}/api/version`, { timeoutMs: 30_000 });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).Version);
});

test('Traefik routes openbao.localhost to OpenBao', async (t) => {
  if (skipReason) return t.skip(skipReason);
  await waitFor(`http://127.0.0.1:${ports.dashboard}/api/http/routers`, {
    timeoutMs: 30_000,
    accept: (r) => r.status === 200,
  });
  const res = await getWithHost(ports.http, 'openbao.localhost', '/v1/sys/health');
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).sealed, false);
});

test('seeded secret is readable through the OpenBao HTTP API', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const res = await fetch(`http://127.0.0.1:${ports.bao}/v1/secret/data/agents/dev/identity`, {
    headers: { 'X-Vault-Token': token },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.data.OIDC_CLIENT_SECRET, secret);
});

test('env-from-openbao renders the secret into an env file', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const dir = mkdtempSync(join(tmpdir(), 'l0-env-'));
  try {
    const out = join(dir, '.env');
    await run('bash', [join(l0, 'scripts', 'env-from-openbao.sh'), '-o', out], { env, timeout: 30_000 });
    const text = readFileSync(out, 'utf8');
    assert.match(text, new RegExp(`^OIDC_CLIENT_SECRET=${secret}$`, 'm'));
    assert.match(text, /^GATEWAY_KEY=.+$/m);
    assert.doesNotMatch(text, /^OIDC_CLIENT_SECRET=change-me$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
