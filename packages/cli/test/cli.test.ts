import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { gateway } from '../src/commands/gateway.ts';
import { nodeVersionProblem } from '../src/commands/init.ts';
import { referenceTests } from '../src/commands/test.ts';
import { main } from '../src/main.ts';
import { traceTelemetry } from '../src/trace.ts';
import { captureIo, linkModules, tempProject } from './helpers.ts';

let dir: string;
let root: string;
let cleanup: () => Promise<void>;

before(async () => {
  ({ dir, root, cleanup } = await tempProject());
  const { io, text } = captureIo(root);
  assert.equal(await main(['init', 'proj', '--name', 'Demo App', '--yes'], io), 0);
  assert.match(text(), /Created demo-app \(minimal\).*all eleven layers wired/);
  // The unscoped npm name belongs to another package: the hint goes through the project's scripts.
  assert.match(text(), /Next:\n  cd proj\n  npm install\n  npm run check\n  npm run dev$/);
  assert.doesNotMatch(text(), /npx agent-layers/);
  await linkModules(dir);
});
after(() => cleanup());

test('init writes a complete project and refuses a non-empty folder', async () => {
  for (const f of ['agent-layers.json', 'agents/assistant.md', 'tools/convert.ts', 'knowledge/ferry.md', 'evals/smoke.jsonl', 'tests/agent.test.ts', '.env.example', '.gitignore', 'package.json', 'README.md']) {
    assert.ok(existsSync(join(dir, f)), f);
  }
  const config = readFileSync(join(dir, 'agent-layers.json'), 'utf8');
  assert.match(config, /"adapter": "basic-runtime"/);
  assert.match(config, /"celsius": "\{\{1\}\}"/, 'capture-group placeholders survive');
  const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  const generated = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; dependencies: Record<string, string> };
  assert.equal(generated.name, 'demo-app');
  assert.equal(generated.dependencies['@agent-layers/core'], `^${version}`, 'packages pinned to the CLI version');
  const scripts = (generated as unknown as { scripts: Record<string, string> }).scripts;
  for (const name of ['dev', 'check', 'test', 'test:live', 'test:stack', 'eval', 'layers', 'diff', 'gateway', 'deploy']) assert.ok(scripts[name], name);
  assert.match(readFileSync(join(dir, 'tests/agent.test.ts'), 'utf8'), /AGENT_LAYERS_LIVE === '1' \|\| process\.env\.npm_lifecycle_event === 'test:live'/);
  const { io, errors } = captureIo(root);
  assert.equal(await main(['init', 'proj'], io), 1);
  assert.match(errors(), /is not empty \(use --force/);
  assert.equal(await main(['init', 'other', '--template', 'tools'], captureIo(root).io), 1);
});

test('check passes for the prototype profile', async () => {
  const { io, text, errors } = captureIo(dir);
  const code = await main(['check'], io);
  assert.equal(code, 0, text());
  // The probe runs reach no configured telemetry: the console-telemetry lines stay out of the output.
  assert.doesNotMatch(errors(), /\[L\d+ /);
  assert.match(text(), /profile prototype · tier prototype/);
  assert.match(text(), /ok\s+model\s+mock-model \(ModelPort\)/);
  assert.match(text(), /skip channels\s+terminal-channel/);
  assert.match(text(), /check passed/);
});

test('check --profile production finds every adapter installed; only secrets and services can be missing', async () => {
  const missing = captureIo(dir);
  assert.equal(await main(['check', '--profile', 'production', '--skip-conformance'], missing.io), 1);
  assert.match(missing.errors(), /OIDC_CLIENT_SECRET is not set \(profile production\)/);
  assert.match(missing.errors(), /SESSION_SECRET is not set \(profile production\)/);
  const { io, text } = captureIo(dir, { OIDC_CLIENT_SECRET: 'test-secret', SESSION_SECRET: 'test-session-key' });
  assert.equal(await main(['check', '--profile', 'production', '--skip-conformance'], io), 0, text());
  assert.match(text(), /tier production/);
  assert.match(text(), /requires: identity, authorization, guardrails, telemetry, state/);
  // The template's own production profile passes the readiness gate cleanly: secret, run budget, tool time limit.
  assert.doesNotMatch(text(), /not installed|prototype-only|FAIL|WARN/);
  assert.match(text(), /check passed/);
});

/** A local HTTP server on a free port; `url` is its origin. */
async function serve(handler: RequestListener): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

/** A port nothing listens on: bound and released, so connecting to it is refused. */
async function closedPort(): Promise<number> {
  const { url, server } = await serve(() => {});
  await new Promise<void>((r) => server.close(() => r()));
  return Number(new URL(url).port);
}

test('check skips an on-behalf-of credentials probe without a caller and uses the caller with --token', async () => {
  // A token endpoint that answers (so the readiness probe passes) and refuses every exchange: the probe can only fail by being run.
  const tokens = await serve((req, res) => res.writeHead(req.method === 'POST' ? 500 : 405).end());
  const cfg = JSON.parse(readFileSync(join(dir, 'agent-layers.json'), 'utf8'));
  cfg.profiles.obo = { extends: 'prototype', layers: { credentials: { adapter: 'oidc', options: { tokenEndpoint: `${tokens.url}/token`, clientId: 'agent', clientSecret: 'secret', mode: 'on-behalf-of', timeoutMs: 500 } } } };
  // Without a tool that asks for tokens there is no audience to exchange for: the probe is skipped.
  cfg.profiles['obo-unused'] = structuredClone(cfg.profiles.obo);
  // A tool that needs tokens for a downstream API gives the probe its audience.
  cfg.profiles.obo.layers.tools = { api: { adapter: 'http-tools', options: { tools: { ledger: { description: 'Ledger', method: 'GET', url: `${tokens.url}/ledger`, auth: { audience: 'ledger-api' } } } } } };
  await writeFile(join(dir, 'obo.json'), JSON.stringify(cfg));
  try {
    const anonymous = captureIo(dir);
    // The prototype dev token is the default caller; an unknown token string is refused before any probe.
    assert.equal(await main(['check', '--config', 'obo.json', '--profile', 'obo', '--layer', 'identity', '--token', 'not-a-token'], anonymous.io), 1);
    assert.match(anonymous.text(), /FAIL caller: the caller token did not verify/);
    assert.match(anonymous.text(), /skip credentials\s+oidc \(CredentialPort\)\n\s+on behalf of a caller only: needs a caller token \(--token\)/);
    // Without a caller the identity suite only refused two malformed credentials: that is a skip, not an ok.
    assert.match(anonymous.text(), /skip identity\s+static-identity \(IdentityPort\)\n\s+skip: verify valid: needs a caller token \(--token\)/);
    assert.doesNotMatch(anonymous.text(), /not-a-token/);
    const withCaller = captureIo(dir);
    assert.equal(await main(['check', '--config', 'obo.json', '--profile', 'obo', '--layer', 'identity', '--token', 'dev-token'], withCaller.io), 1);
    assert.match(withCaller.text(), /FAIL credentials\s+oidc \(CredentialPort\)\n\s+token: threw/);
    assert.match(withCaller.text(), /ok\s+identity\s+static-identity/);
    const unused = captureIo(dir);
    await main(['check', '--config', 'obo.json', '--profile', 'obo-unused', '--layer', 'identity', '--token', 'dev-token'], unused.io);
    assert.match(unused.text(), /skip credentials\s+oidc \(CredentialPort\)\n\s+no tool or adapter declares an audience/);
  } finally {
    tokens.server.close();
  }
});

test('check probes the readiness of remote services: FAIL on production, skip below it, and never ok without a live probe', async () => {
  const port = await closedPort();
  // An OpenID provider that answers discovery and an empty key set.
  const idp = await serve((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = url.pathname === '/realms/test/.well-known/openid-configuration' ? { issuer: `${idp.url}/realms/test`, jwks_uri: `${idp.url}/jwks` } : url.pathname === '/jwks' ? { keys: [] } : undefined;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? {}));
  });
  const cfg = JSON.parse(readFileSync(join(dir, 'agent-layers.json'), 'utf8'));
  cfg.profiles.dead = { extends: 'prototype', layers: {
    runtime: { adapter: 'a2a', options: { url: `http://127.0.0.1:${port}/a2a/assistant` } },
    identity: { adapter: 'oidc', options: { issuer: `http://127.0.0.1:${port}/realms/test`, audience: 'agents' } },
  } };
  cfg.profiles['dead-production'] = { extends: 'dead', tier: 'production' };
  cfg.profiles.idp = { extends: 'prototype', layers: { identity: { adapter: 'oidc', options: { issuer: `${idp.url}/realms/test`, audience: 'agents' } } } };
  await writeFile(join(dir, 'ready.json'), JSON.stringify(cfg));
  try {
    const below = captureIo(dir);
    await main(['check', '--config', 'ready.json', '--profile', 'dead'], below.io);
    assert.match(below.text(), new RegExp(`skip runtime\\s+a2a \\(RuntimePort\\)\\n\\s+remote agent unreachable \\(127\\.0\\.0\\.1:${port}\\): ECONNREFUSED`));
    assert.match(below.text(), new RegExp(`skip identity\\s+oidc \\(IdentityPort\\)\\n\\s+127\\.0\\.0\\.1:${port}: OIDC discovery: request failed \\(ECONNREFUSED\\)`));
    assert.doesNotMatch(below.text(), /ok\s+(runtime|identity)/);
    const production = captureIo(dir);
    assert.equal(await main(['check', '--config', 'ready.json', '--profile', 'dead-production'], production.io), 1);
    assert.match(production.text(), new RegExp(`FAIL runtime\\s+a2a \\(RuntimePort\\)\\n\\s+remote agent unreachable \\(127\\.0\\.0\\.1:${port}\\): ECONNREFUSED`));
    assert.match(production.text(), new RegExp(`FAIL identity\\s+oidc \\(IdentityPort\\)\\n\\s+127\\.0\\.0\\.1:${port}: OIDC discovery: request failed \\(ECONNREFUSED\\)`));
    // A provider that answers, but no caller token to verify: the row says what did not run instead of ok.
    const reachable = captureIo(dir);
    await main(['check', '--config', 'ready.json', '--profile', 'idp', '--layer', 'identity'], reachable.io);
    assert.match(reachable.text(), /skip identity\s+oidc \(IdentityPort\)\n\s+skip: verify valid: needs a caller token \(--token\)/);
    assert.doesNotMatch(reachable.text(), /ok\s+identity/);
  } finally {
    idp.server.close();
  }
});

test('version prints the cli version and the core version it resolves', async () => {
  const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  for (const argv of [['--version'], ['-v'], ['version']]) {
    const { io, text } = captureIo(dir);
    assert.equal(await main(argv, io), 0, argv.join(' '));
    assert.equal(text(), `agent-layers ${version} (core ${version})`);
  }
});

test('a production profile on prototype adapters fails the readiness gate', async () => {
  const cfg = JSON.parse(readFileSync(join(dir, 'agent-layers.json'), 'utf8'));
  cfg.profiles.staging = { extends: 'prototype', tier: 'production' };
  await writeFile(join(dir, 'staging.json'), JSON.stringify(cfg));
  const { io, text } = captureIo(dir);
  assert.equal(await main(['check', '--config', 'staging.json', '--profile', 'staging', '--skip-conformance'], io), 1);
  assert.match(text(), /identity: adapter "static-identity" is prototype-only/);
  assert.match(text(), /state: adapter "memory-state" is prototype-only/);
});

test('layers shows all eleven layers by plane with the adapter in use', async () => {
  const { io, text } = captureIo(dir);
  assert.equal(await main(['layers'], io), 0);
  const out = text();
  for (const plane of ['Foundation', 'Model plane', 'Agent plane', 'Control plane', 'Experience plane', 'Insight plane']) assert.match(out, new RegExp(plane));
  for (const l of ['L0 infra', 'L1 llm', 'L2 cache', 'L3 harness', 'L4 knowledge', 'L5 tool', 'L6 identity', 'L7 guardrail', 'L8 interface', 'L9 telemetry', 'L10 eval']) assert.match(out, new RegExp(l));
  assert.match(out, /ModelPort 1\.1\.0\s+uses mock-model/);
  assert.match(out, /KnowledgePort 1\.1\.0\s+uses docs=markdown-knowledge/);
  assert.match(out, /standard: openai-compatible/);
  assert.match(out, /native:\s+mock-model \(prototype\)/);
});

test('diff prints per-slot changes between profiles', async () => {
  const { io, text } = captureIo(dir);
  assert.equal(await main(['diff', 'prototype', 'pilot'], io), 0);
  assert.match(text(), /^prototype → pilot/);
  assert.match(text(), /model\s+changed\s+mock-model → openai-compatible/);
  assert.match(text(), /knowledge\s+changed\s+docs=markdown-knowledge → docs=mcp/);
  assert.match(text(), /guardrails\s+same\s+regex-guard/);
});

test('dev --message runs the agent once through every layer', async () => {
  const { io, text, errors } = captureIo(dir);
  assert.equal(await main(['dev', '--profile', 'test', '--message', 'Convert 100 C to Fahrenheit', '--trace'], io), 0, errors());
  assert.equal(text(), '100 °C is 212 °F');
  assert.match(errors(), /\[L5 tool\] agent\.tool\.call .*tool=util__convert_temperature/);
  assert.match(errors(), /\[L7 guardrail\] agent\.guard\.check/);
});

test('dev prints a failing knowledge source on stderr whatever telemetry is configured, unless --quiet', async () => {
  const config = JSON.parse(readFileSync(join(dir, 'agent-layers.json'), 'utf8')) as { profiles: Record<string, unknown> };
  config.profiles.broken = {
    extends: 'test',
    layers: { knowledge: { docs: { adapter: 'http-knowledge', options: { url: `http://127.0.0.1:${await closedPort()}/search` } } } },
  };
  await writeFile(join(dir, 'broken.json'), JSON.stringify(config));
  const loud = captureIo(dir);
  assert.equal(await main(['dev', '--config', 'broken.json', '--profile', 'broken', '--message', 'Convert 100 C to Fahrenheit'], loud.io), 0, loud.errors());
  assert.match(loud.errors(), /\[L4 knowledge\] knowledge source docs failed: /);
  const quiet = captureIo(dir);
  assert.equal(await main(['dev', '--config', 'broken.json', '--profile', 'broken', '--message', 'Convert 100 C to Fahrenheit', '--quiet'], quiet.io), 0);
  assert.equal(quiet.errors(), '');
});

test('a rejected token stops dev before any run and is never printed', async () => {
  const { io, text, errors } = captureIo(dir);
  assert.equal(await main(['dev', '--profile', 'test', '--message', 'hi', '--token', 'wrong-token'], io), 1);
  assert.match(errors(), /credential was rejected/);
  assert.doesNotMatch(text() + errors(), /wrong-token/);
});

test('eval scores the smoke dataset', async () => {
  const { io, text, errors } = captureIo(dir);
  assert.equal(await main(['eval', 'evals/smoke.jsonl', '--agent', 'assistant', '--profile', 'test', '--min', '1'], io), 0, errors());
  const lines = text().split('\n').map((l) => JSON.parse(l) as { id: string; scores: { value: number }[]; usage?: { inputTokens: number } });
  assert.deepEqual(lines.map((l) => l.id), ['tool-convert', 'knowledge-ferry', 'greeting']);
  assert.ok(lines.every((l) => (l.usage?.inputTokens ?? 0) > 0), 'eval rows carry the run usage');
  assert.match(errors(), /3\/3 scores passed/);
});

test('eval validates --min, exits 1 below it, and hints when it is unset', async () => {
  await writeFile(join(dir, 'evals', 'failing.jsonl'), '{"id":"never","input":"hello","expected":"zzz-not-an-answer"}\n');
  const invalid = captureIo(dir);
  assert.equal(await main(['eval', 'evals/smoke.jsonl', '--profile', 'test', '--min', 'abc'], invalid.io), 1);
  assert.match(invalid.errors(), /eval: --min must be a number between 0 and 1/);
  assert.equal(await main(['eval', 'evals/smoke.jsonl', '--profile', 'test', '--min', '2'], captureIo(dir).io), 1);
  const below = captureIo(dir);
  assert.equal(await main(['eval', 'evals/failing.jsonl', '--profile', 'test', '--min', '1'], below.io), 1);
  assert.match(below.errors(), /0\/1 scores passed/);
  assert.doesNotMatch(below.errors(), /hint:/);
  const unset = captureIo(dir);
  assert.equal(await main(['eval', 'evals/failing.jsonl', '--profile', 'test'], unset.io), 0);
  assert.match(unset.errors(), /hint: the exit code is 0 without --min/);
});

test('deploy --dry-run says when there is nothing to deploy and needs no secret', async () => {
  const empty = captureIo(dir);
  assert.equal(await main(['deploy', '--dry-run'], empty.io), 0, empty.errors());
  assert.match(empty.text(), /^nothing to deploy for profile prototype: compose-deploy has nothing to start for any of the \d+ service\(s\)/);
  assert.doesNotMatch(empty.text(), /would need/);
  const production = captureIo(dir);
  assert.equal(await main(['deploy', '--profile', 'production', '--dry-run'], production.io), 0, production.errors());
  assert.match(production.text(), /would need: OIDC_CLIENT_SECRET, SESSION_SECRET \(not set\)/);
  const layersOut = captureIo(dir);
  assert.equal(await main(['layers', '--profile', 'production'], layersOut.io), 0, layersOut.errors());
  assert.match(layersOut.text(), /would need: OIDC_CLIENT_SECRET, SESSION_SECRET \(not set\)/);
  const diffOut = captureIo(dir);
  assert.equal(await main(['diff', 'pilot', 'production'], diffOut.io), 0, diffOut.errors());
  assert.match(diffOut.text(), /would need: OIDC_CLIENT_SECRET, SESSION_SECRET \(not set\)/);
  // A real deploy still needs every secret.
  const real = captureIo(dir);
  assert.equal(await main(['deploy', '--profile', 'production'], real.io), 1);
  assert.match(real.errors(), /OIDC_CLIENT_SECRET is not set/);
});

test('deploy --dry-run plans through the deploy slot', async () => {
  await mkdir(join(dir, 'reference', 'knowledge'), { recursive: true });
  await writeFile(join(dir, 'reference', 'knowledge', 'compose.yml'), 'services: {}\n');
  const { io, text } = captureIo(dir);
  assert.equal(await main(['deploy', '--dry-run'], io), 0, text());
  assert.match(text(), /deploy prototype with compose-deploy: 1 step\(s\) for \d+ service\(s\)/);
  assert.match(text(), /docker compose .*reference\/knowledge\/compose\.yml/);
});

test('the generated offline test passes', () => {
  const r = spawnSync(process.execPath, ['--conditions=@agent-layers/source', '--test', 'tests/**/*.test.ts'], {
    cwd: dir, encoding: 'utf8', timeout: 120_000, env: { PATH: process.env.PATH, LLM_BASE_URL: 'http://127.0.0.1:9/v1' },
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /pass 1\n/);
  assert.match(r.stdout, /skipped 1\n/);
});

test('usage errors exit 1 with a message', async () => {
  const { io, errors } = captureIo(dir);
  assert.equal(await main(['frobnicate'], io), 1);
  assert.match(errors(), /unknown command "frobnicate"/);
  assert.equal(await main(['gateway', '--port', 'nope'], captureIo(dir).io), 1);
});

test('reference tests live only in reference/<layer id>/test', async () => {
  await mkdir(join(root, 'reference', 'tool', 'test'), { recursive: true });
  await mkdir(join(root, 'layers', 'l4-tools', 'test'), { recursive: true });
  assert.deepEqual(referenceTests(root, 'tool'), [join(root, 'reference', 'tool', 'test')]);
  assert.deepEqual(referenceTests(root, 'guardrail'), []);
});

test('gateway hosts the profile on the network until stopped; production needs the readiness gate', async () => {
  const { io, errors } = captureIo(dir);
  let health = 0;
  const code = await gateway(io, { port: '0' }, async () => {
    const url = /gateway (http:\/\/\S+)/.exec(errors())![1]!;
    health = (await fetch(`${url}/healthz`)).status;
  });
  assert.equal(code, 0);
  assert.equal(health, 200);
  assert.match(errors(), /tier prototype/);
  for (const route of ['POST /v1/chat/completions (openai-compatible)', 'POST|GET|DELETE /mcp (mcp)', 'GET /.well-known/agent-card.json (a2a)', 'POST /v1/events (cloudevents)']) {
    assert.ok(errors().includes(route), route);
  }
  const cfg = JSON.parse(readFileSync(join(dir, 'agent-layers.json'), 'utf8'));
  cfg.profiles.hardened = { extends: 'prototype', tier: 'production' };
  await writeFile(join(dir, 'hardened.json'), JSON.stringify(cfg));
  const prod = captureIo(dir);
  assert.equal(await main(['gateway', '--config', 'hardened.json', '--profile', 'hardened'], prod.io), 1);
  assert.match(prod.errors(), /fails the readiness gate[\s\S]*prototype-only/);
});

test('gateway on a busy port fails with one line naming the address and the fix', async () => {
  const busy = createServer();
  await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
  const { port } = busy.address() as AddressInfo;
  try {
    const { io, errors } = captureIo(dir);
    assert.equal(await main(['gateway', '--port', String(port), '--host', '127.0.0.1'], io), 1);
    assert.equal(errors(), `agent-layers gateway: cannot listen on 127.0.0.1:${port}: address already in use; pick another port with --port <n> or gateway.port in agent-layers.json`);
  } finally {
    await new Promise((resolve) => busy.close(resolve));
  }
});

test('the trace shows gateway requests answered with 4xx or 5xx as rejected or error', async () => {
  const lines: string[] = [];
  const t = traceTelemetry((l) => lines.push(l));
  for (const code of [200, 401, 503]) {
    await t.span('gateway.request', { 'agent.layer': 'interface' }, async (span) => { span.setAttributes({ 'http.response.status_code': code }); });
  }
  assert.match(lines[0]!, /gateway\.request \d+ms ok$/);
  assert.match(lines[1]!, /gateway\.request \d+ms rejected 401$/);
  assert.match(lines[2]!, /gateway\.request \d+ms error 503$/);
});

test('init refuses a Node.js older than the engines range, with what to install', () => {
  assert.match(nodeVersionProblem('22.17.1', '>=22.18') ?? '', /Node\.js 22\.17\.1 is too old .* needs >=22\.18/);
  assert.match(nodeVersionProblem('20.19.0', '>=22.18') ?? '', /too old/);
  assert.equal(nodeVersionProblem('22.18.0', '>=22.18'), undefined);
  assert.equal(nodeVersionProblem('24.1.0', '>=22.18'), undefined);
  assert.equal(nodeVersionProblem('22.17.0', '^22.18 || >=24'), undefined, 'other range forms are left to npm');
});
