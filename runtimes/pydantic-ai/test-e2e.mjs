// Two processes, standards only: the gateway hosts the stack of examples/minimal (profile polyglot), whose runtime
// is this Python agent over A2A; the agent calls the gateway back for its model (/v1) and tools (/mcp).
//
//   node --test runtimes/pydantic-ai/test-e2e.mjs
//
// Offline with the scripted model. POLYGLOT_LIVE=1 adds a run on the polyglot-local profile (a model served on this
// machine, LLM_BASE_URL and LLM_MODEL, default qwen3:4b); it skips when that model is not served.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');
const EXAMPLE = join(ROOT, 'examples', 'minimal');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'cli.ts');
const PYTHON = process.platform === 'win32' ? join(HERE, '.venv', 'Scripts', 'python.exe') : join(HERE, '.venv', 'bin', 'python');
const DEV_TOKEN = 'dev-token';
const WRONG_TOKEN = 'not-a-known-token-5c1e';
const STEP_MS = 30_000;

const hasUv = spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** A child process whose output is kept, for assertions on what it logs. */
function start(name, command, args, opts) {
  const child = spawn(command, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  const proc = { name, child, output: '', exited: new Promise((r) => child.once('exit', (code, signal) => r({ code, signal }))) };
  child.stdout.on('data', (d) => { proc.output += d; });
  child.stderr.on('data', (d) => { proc.output += d; });
  return proc;
}

async function stop(proc) {
  if (!proc || proc.child.exitCode !== null || proc.child.signalCode !== null) return;
  proc.child.kill('SIGTERM');
  const ended = await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r(null), 15_000))]);
  if (!ended) {
    proc.child.kill('SIGKILL');
    await proc.exited;
    assert.fail(`${proc.name} did not stop on SIGTERM`);
  }
}

async function waitHealthy(url, proc) {
  const until = Date.now() + STEP_MS;
  while (Date.now() < until) {
    if (proc.child.exitCode !== null) throw new Error(`${proc.name} exited early:\n${proc.output}`);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${proc.name} not healthy at ${url}:\n${proc.output}`);
}

const json = (token, extra = {}) => ({ 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra });
const rpc = (method, params) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
const message = (text) => ({ message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text }] } });

/** A2A 1.0 SendMessage, then GetTask until the task ends. */
async function a2aRun(endpoint, token, text) {
  const signal = AbortSignal.timeout(STEP_MS);
  const res = await fetch(endpoint, { method: 'POST', headers: json(token, { 'a2a-version': '1.0' }), body: rpc('SendMessage', message(text)), signal });
  assert.equal(res.status, 200);
  const body = await res.json();
  let task = body.result?.task ?? body.result;
  while (!/COMPLETED|FAILED|CANCELED|REJECTED/.test(task.status.state)) {
    await new Promise((r) => setTimeout(r, 100));
    const got = await fetch(endpoint, { method: 'POST', headers: json(token, { 'a2a-version': '1.0' }), body: rpc('GetTask', { id: task.id }), signal });
    task = (await got.json()).result;
  }
  return task;
}

const answer = (task) => (task.artifacts ?? []).flatMap((a) => a.parts).map((p) => p.text ?? '').join('');

/** Gateway and Python agent on free ports, for one profile. */
async function startPair(profile, dir) {
  const [gwPort, agentPort] = [await freePort(), await freePort()];
  const telemetry = join(dir, `${profile}-telemetry.jsonl`);
  const env = { ...process.env, A2A_AGENT_URL: `http://localhost:${agentPort}`, POLYGLOT_TELEMETRY_PATH: telemetry };
  const gateway = start('gateway', process.execPath, ['--conditions=source', '--disable-warning=ExperimentalWarning', CLI, 'gateway', '--profile', profile, '--port', String(gwPort)], { cwd: EXAMPLE, env });
  const agent = start('python agent', PYTHON, ['-m', 'agent_layers_pydantic_ai'], {
    cwd: HERE,
    env: { ...process.env, AGENT_FILE: join(EXAMPLE, 'agents', 'assistant.md'), GATEWAY_URL: `http://127.0.0.1:${gwPort}`, A2A_PORT: String(agentPort) },
  });
  const pair = { gateway, agent, gw: `http://127.0.0.1:${gwPort}`, agentUrl: `http://localhost:${agentPort}/`, telemetry };
  try {
    await waitHealthy(`${pair.gw}/healthz`, gateway);
    await waitHealthy(`http://127.0.0.1:${agentPort}/healthz`, agent);
  } catch (err) {
    await Promise.allSettled([stop(gateway), stop(agent)]);
    throw err;
  }
  return pair;
}

const records = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const spans = (file, name) => records(file).filter((r) => r.type === 'span' && r.name === name);

describe('polyglot: Pydantic AI agent as the runtime of the stack', { skip: !hasUv && 'uv is not installed', timeout: 240_000 }, () => {
  let dir;
  let pair;

  before(async () => {
    const sync = spawnSync('uv', ['sync', '--frozen', '--quiet'], { cwd: HERE, stdio: 'inherit', timeout: 180_000 });
    assert.equal(sync.status, 0, 'uv sync failed');
    dir = mkdtempSync(join(tmpdir(), 'agent-layers-polyglot-'));
    pair = await startPair('polyglot', dir);
  });

  after(async () => {
    await Promise.allSettled([stop(pair?.gateway), stop(pair?.agent)]);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('an A2A message to the gateway is answered by the Python agent through the gateway', async () => {
    const task = await a2aRun(`${pair.gw}/a2a/assistant`, DEV_TOKEN, 'Convert 100 C to Fahrenheit');
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(answer(task), '100 °C is 212 °F');
    const send = spans(pair.telemetry, 'a2a.send').at(-1);
    assert.equal(send.attrs['a2a.version'], '1.0');
    assert.equal(send.attrs['a2a.task.state'], 'completed');
  });

  test('agent:assistant over the OpenAI-compatible API runs the same remote agent', async () => {
    const res = await fetch(`${pair.gw}/v1/chat/completions`, {
      method: 'POST', headers: json(DEV_TOKEN), signal: AbortSignal.timeout(STEP_MS),
      body: JSON.stringify({ model: 'agent:assistant', messages: [{ role: 'user', content: 'Convert 37 C to Fahrenheit' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].message.content, '37 °C is 98.6 °F');
  });

  test('the model call and the tool call went through the gateway, authenticated and authorized', () => {
    const requests = spans(pair.telemetry, 'gateway.request');
    const ok = (path) => requests.filter((s) => s.attrs['url.path'] === path && s.attrs['http.response.status_code'] === 200 && s.attrs['gateway.authenticated'] === true);
    assert.ok(ok('/v1/chat/completions').length >= 4, 'model calls of the Python agent at /v1');
    assert.ok(ok('/mcp').length >= 2, 'tool calls of the Python agent at /mcp');
    const allowed = spans(pair.telemetry, 'authorize').filter((s) => s.attrs['gen_ai.tool.name'] === 'util__convert_temperature' && s.attrs['policy.decision'] === 'allow');
    assert.ok(allowed.length >= 2, 'authorization decisions for the tool');
    const executed = spans(pair.telemetry, 'execute_tool').filter((s) => s.attrs['gen_ai.tool.name'] === 'util__convert_temperature' && s.attrs['tool.outcome'] === 'ok');
    assert.ok(executed.length >= 2);
    assert.ok(spans(pair.telemetry, 'guard.check').some((s) => s.attrs['guard.stage'] === 'tool_args'), 'tool guards ran');
    assert.match(pair.gateway.output, /\[L6 identity\] authorize .*util__convert_temperature policy\.decision=allow/);
  });

  test('one trace spans gateway, A2A, the Python agent and its calls back to the gateway', async () => {
    const before = records(pair.telemetry).length;
    const task = await a2aRun(`${pair.gw}/a2a/assistant`, DEV_TOKEN, 'Convert 20 C to Fahrenheit');
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    const run = records(pair.telemetry).slice(before).filter((r) => r.type === 'span');
    const send = run.find((r) => r.name === 'a2a.send');
    assert.match(send?.traceId ?? '', /^[0-9a-f]{32}$/, 'recorded spans carry trace ids');
    const inTrace = run.filter((r) => r.traceId === send.traceId);
    const paths = new Set(inTrace.filter((r) => r.name === 'gateway.request').map((r) => r.attrs['url.path']));
    for (const path of ['/a2a/assistant', '/v1/chat/completions', '/mcp']) assert.ok(paths.has(path), `${path} is in the trace (${[...paths].join(', ')})`);
    // The Python agent's calls are children of the span that sent the A2A message.
    const callbacks = inTrace.filter((r) => r.name === 'gateway.request' && r.attrs['url.path'] !== '/a2a/assistant');
    assert.ok(callbacks.every((r) => r.parentSpanId === send.spanId));
    assert.ok(inTrace.some((r) => r.name === 'execute_tool'), 'the tool call is in the same trace');
  });

  test('requests without a credential are refused by the gateway and by the Python agent', async () => {
    const gw = await fetch(`${pair.gw}/a2a/assistant`, { method: 'POST', headers: json(null), body: rpc('SendMessage', message('Hello')) });
    assert.equal(gw.status, 401);
    const direct = await fetch(pair.agentUrl, { method: 'POST', headers: json(null), body: rpc('SendMessage', message('Hello')) });
    assert.equal(direct.status, 401);
    assert.match(direct.headers.get('www-authenticate') ?? '', /^Bearer/);
  });

  test('a credential the gateway rejects fails the run: the Python agent gets no model or tools', async () => {
    const before = spans(pair.telemetry, 'gateway.request').length;
    const task = await a2aRun(pair.agentUrl, WRONG_TOKEN, 'Convert 5 C to Fahrenheit');
    assert.equal(task.status.state, 'TASK_STATE_FAILED');
    const refused = spans(pair.telemetry, 'gateway.request').slice(before).filter((s) => s.attrs['http.response.status_code'] === 401);
    assert.ok(refused.length >= 1, 'the gateway answered 401 to the forwarded credential');
    assert.ok(refused.every((s) => s.attrs['gateway.authenticated'] !== true));
  });

  test('no credential appears in the logs of either process or in telemetry', () => {
    for (const [name, text] of [['gateway', pair.gateway.output], ['python agent', pair.agent.output], ['telemetry', readFileSync(pair.telemetry, 'utf8')]]) {
      assert.ok(text.length > 0, `${name} logged something`);
      assert.ok(!text.includes(DEV_TOKEN), `${name} must not log the dev token`);
      assert.ok(!text.includes(WRONG_TOKEN), `${name} must not log a presented credential`);
    }
  });

  test('both processes stop on SIGTERM', async () => {
    await stop(pair.agent);
    await stop(pair.gateway);
    assert.match(pair.agent.output, /Application shutdown complete/);
    assert.match(pair.gateway.output, /gateway stopping/);
  });
});

describe('polyglot-local: the same pair with a model served on this machine', { skip: process.env.POLYGLOT_LIVE !== '1' && 'set POLYGLOT_LIVE=1', timeout: 300_000 }, () => {
  test('the Python agent answers through the gateway with the local model', async (t) => {
    const base = (process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/$/, '');
    const model = process.env.LLM_MODEL ?? 'qwen3:4b';
    try {
      const ids = ((await (await fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) })).json()).data ?? []).map((m) => m.id);
      if (!ids.includes(model)) return t.skip(`model ${model} is not served at ${base}`);
    } catch {
      return t.skip(`no model server at ${base}`);
    }
    if (!hasUv) return t.skip('uv is not installed');
    const dir = mkdtempSync(join(tmpdir(), 'agent-layers-polyglot-local-'));
    const pair = await startPair('polyglot-local', dir);
    try {
      const task = await a2aRun(`${pair.gw}/a2a/assistant`, DEV_TOKEN, 'Convert 100 C to Fahrenheit. Use the tool.');
      assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
      assert.ok(answer(task).length > 0);
      assert.ok(spans(pair.telemetry, 'chat').some((s) => s.attrs['gen_ai.request.model'] === model));
      for (const text of [pair.gateway.output, pair.agent.output]) assert.ok(!text.includes(DEV_TOKEN));
    } finally {
      await Promise.allSettled([stop(pair.gateway), stop(pair.agent)]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
