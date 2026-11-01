import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { gateway } from '../src/commands/gateway.ts';
import { referenceTests } from '../src/commands/test.ts';
import { main } from '../src/main.ts';
import { captureIo, linkModules, tempProject } from './helpers.ts';

let dir: string;
let root: string;
let cleanup: () => Promise<void>;

before(async () => {
  ({ dir, root, cleanup } = await tempProject());
  const { io, text } = captureIo(root);
  assert.equal(await main(['init', 'proj', '--name', 'Demo App', '--yes'], io), 0);
  assert.match(text(), /Created demo-app \(minimal\).*all eleven layers wired/);
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
  assert.match(readFileSync(join(dir, 'package.json'), 'utf8'), /"name": "demo-app"[\s\S]*"@agent-layers\/core": "\^0\.1\.0"/);
  const { io, errors } = captureIo(root);
  assert.equal(await main(['init', 'proj'], io), 1);
  assert.match(errors(), /is not empty \(use --force/);
  assert.equal(await main(['init', 'other', '--template', 'tools'], captureIo(root).io), 1);
});

test('check passes for the prototype profile', async () => {
  const { io, text } = captureIo(dir);
  const code = await main(['check'], io);
  assert.equal(code, 0, text());
  assert.match(text(), /profile prototype · tier prototype/);
  assert.match(text(), /ok\s+model\s+mock-model \(ModelPort\)/);
  assert.match(text(), /skip channels\s+terminal-channel/);
  assert.match(text(), /check passed/);
});

test('check --profile production finds every adapter installed; only secrets and services can be missing', async () => {
  const missing = captureIo(dir);
  assert.equal(await main(['check', '--profile', 'production', '--skip-conformance'], missing.io), 1);
  assert.match(missing.errors(), /OIDC_CLIENT_SECRET is not set \(profile production\)/);
  const { io, text } = captureIo(dir, { OIDC_CLIENT_SECRET: 'test-secret' });
  assert.equal(await main(['check', '--profile', 'production', '--skip-conformance'], io), 0, text());
  assert.match(text(), /tier production/);
  assert.match(text(), /requires: identity, authorization, guardrails, telemetry, state/);
  assert.doesNotMatch(text(), /not installed|prototype-only|FAIL/);
  assert.match(text(), /check passed/);
});

test('check skips an on-behalf-of credentials probe without a caller and uses the caller with --token', async () => {
  const cfg = JSON.parse(readFileSync(join(dir, 'agent-layers.json'), 'utf8'));
  // An unreachable token endpoint: the probe can only fail by being run.
  cfg.profiles.obo = { extends: 'prototype', layers: { credentials: { adapter: 'oidc', options: { tokenEndpoint: 'http://127.0.0.1:9/token', clientId: 'agent', clientSecret: 'secret', mode: 'on-behalf-of', timeoutMs: 500 } } } };
  // Without a tool that asks for tokens there is no audience to exchange for: the probe is skipped.
  cfg.profiles['obo-unused'] = structuredClone(cfg.profiles.obo);
  // A tool that needs tokens for a downstream API gives the probe its audience.
  cfg.profiles.obo.layers.tools = { api: { adapter: 'http-tools', options: { tools: { ledger: { description: 'Ledger', method: 'GET', url: 'http://127.0.0.1:9/ledger', auth: { audience: 'ledger-api' } } } } } };
  await writeFile(join(dir, 'obo.json'), JSON.stringify(cfg));
  const anonymous = captureIo(dir);
  // The prototype dev token is the default caller; an unknown token string is refused before any probe.
  assert.equal(await main(['check', '--config', 'obo.json', '--profile', 'obo', '--layer', 'identity', '--token', 'not-a-token'], anonymous.io), 1);
  assert.match(anonymous.text(), /FAIL caller: the caller token did not verify/);
  assert.match(anonymous.text(), /skip credentials\s+oidc \(CredentialPort\)\n\s+on behalf of a caller only: needs a caller token \(--token\)/);
  assert.doesNotMatch(anonymous.text(), /not-a-token/);
  const withCaller = captureIo(dir);
  assert.equal(await main(['check', '--config', 'obo.json', '--profile', 'obo', '--layer', 'identity', '--token', 'dev-token'], withCaller.io), 1);
  assert.match(withCaller.text(), /FAIL credentials\s+oidc \(CredentialPort\)\n\s+token: threw/);
  assert.match(withCaller.text(), /ok\s+identity\s+static-identity/);
  const unused = captureIo(dir);
  await main(['check', '--config', 'obo.json', '--profile', 'obo-unused', '--layer', 'identity', '--token', 'dev-token'], unused.io);
  assert.match(unused.text(), /skip credentials\s+oidc \(CredentialPort\)\n\s+no tool or adapter declares an audience/);
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
  assert.match(out, /ModelPort 1\.0\.0\s+uses mock-model/);
  assert.match(out, /KnowledgePort 1\.0\.0\s+uses docs=markdown-knowledge/);
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

test('deploy --dry-run plans through the deploy slot', async () => {
  await mkdir(join(dir, 'reference', 'knowledge'), { recursive: true });
  await writeFile(join(dir, 'reference', 'knowledge', 'compose.yml'), 'services: {}\n');
  const { io, text } = captureIo(dir);
  assert.equal(await main(['deploy', '--dry-run'], io), 0, text());
  assert.match(text(), /deploy prototype with compose-deploy/);
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
