import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, limitFindings, limitList, noopTelemetry, type DeployPort, type ServiceSpec } from '@agent-layers/core';
import { composeFor, LIMITS } from '../src/generate.ts';
import { adapter, createComposeDeploy, type Run } from '../src/index.ts';
import { spawnRun } from '../src/run.ts';
import { fakeRun, tempProject } from './helpers.ts';

const service: ServiceSpec = { name: 'api', image: 'example/api:1', health: { command: ['true'] } };
const ctx = { name: 'deploy', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };

test('health check timing takes effect when set', () => {
  const file = composeFor([service], { healthIntervalS: 10, healthTimeoutS: 2, healthRetries: 3 });
  assert.match(file, /interval: 10s\n {6}timeout: 2s\n {6}retries: 3\n/);
  assert.match(composeFor([service]), /interval: 5s\n {6}timeout: 3s\n {6}retries: 12\n/);
});

test('errorOutputChars cuts the command output kept in the error', async () => {
  const { root, cleanup } = await tempProject();
  try {
    const { run } = fakeRun({ code: 1, stdout: '', stderr: 'e'.repeat(100) });
    const deploy = createComposeDeploy({ errorOutputChars: 12, healthRetries: 2 }, { cwd: root, run });
    await assert.rejects(deploy.up([service]), (err: Error) => err.message === `compose up failed (exit 1): ${'e'.repeat(12)}`);
  } finally {
    await cleanup();
  }
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  const make = (options: Record<string, unknown>) => registry.create('DeployPort', 'compose-deploy', options, ctx) as Promise<DeployPort>;
  await make({ healthIntervalS: '10', healthTimeoutS: '2', healthRetries: '5', errorOutputChars: '100', commandTimeoutMs: '5000' });
  await make({ commandTimeoutMs: 'unbounded' });
  await assert.rejects(make({ commandTimeoutMs: 999 }), /commandTimeoutMs/);
  await assert.rejects(make({ healthIntervalS: 0 }), /healthIntervalS/);
  await assert.rejects(make({ healthRetries: 'unbounded' }), /healthRetries/);
  await assert.rejects(make({ errorOutputChars: -1 }), /errorOutputChars/);
});

/** A runner that never finishes on its own: it ends (code -1) only when its signal aborts, like `spawnRun` does. */
const hangingRun = (seen: { signals: (AbortSignal | undefined)[] }): Run => (_cmd, _args, opts) => {
  seen.signals.push(opts.signal);
  return new Promise((resolve) => {
    const end = () => resolve({ code: -1, stdout: 'partial', stderr: 'token=hunter2' });
    if (opts.signal?.aborted) end();
    else opts.signal?.addEventListener('abort', end, { once: true });
  });
};

test('commandTimeoutMs stops a slow command and fails without echoing its output', async () => {
  const { root, cleanup } = await tempProject();
  try {
    const seen = { signals: [] as (AbortSignal | undefined)[] };
    const deploy = createComposeDeploy({ commandTimeoutMs: 1000 }, { cwd: root, run: hangingRun(seen) });
    const started = Date.now();
    await assert.rejects(deploy.up([{ name: 'llm', layer: 'llm' }]), (err: Error) => {
      assert.equal(err.message, 'compose up timed out after 1000 ms and was stopped');
      assert.ok(!/hunter2|partial/.test(err.message));
      return true;
    });
    assert.ok(Date.now() - started < 5000);
    assert.equal(seen.signals.length, 1);
    await assert.rejects(deploy.down([{ name: 'llm', layer: 'llm' }]), /compose down timed out/);
  } finally {
    await cleanup();
  }
});

test('unbounded commandTimeoutMs never reaches a timer; a caller abort is not reported as a timeout', async () => {
  const { root, cleanup } = await tempProject();
  try {
    const seen = { signals: [] as (AbortSignal | undefined)[] };
    const deploy = createComposeDeploy({ commandTimeoutMs: 'unbounded' }, { cwd: root, run: hangingRun(seen) });
    const caller = new AbortController();
    const pending = deploy.up([{ name: 'llm', layer: 'llm' }], { signal: caller.signal });
    setTimeout(() => caller.abort(), 20);
    await assert.rejects(pending, (err: Error) => /compose up failed/.test(err.message) && !/timed out/.test(err.message));
    assert.equal(seen.signals[0], caller.signal, 'only the caller signal is passed');
  } finally {
    await cleanup();
  }
});

test('the default runner kills a command on abort: SIGTERM, then SIGKILL for one that ignores it', async () => {
  const polite = await spawnRun(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: process.cwd(), signal: AbortSignal.timeout(200) });
  assert.notEqual(polite.code, 0);
  const stubborn = 'process.on("SIGTERM", () => {}); console.log("ready"); setTimeout(() => {}, 60000)';
  const started = Date.now();
  const res = await spawnRun(process.execPath, ['-e', stubborn], { cwd: process.cwd(), signal: AbortSignal.timeout(1500), killGraceMs: 300 });
  assert.notEqual(res.code, 0);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1750 && elapsed < 10_000, `SIGTERM was ignored, so exit came after the grace period (${elapsed} ms)`);
});

test('commandTimeoutMs through the real runner stops a slow command', async () => {
  const { root, cleanup } = await tempProject();
  try {
    const slow = 'setTimeout(() => {}, 60000)';
    const deploy = createComposeDeploy({ commandTimeoutMs: 1000, command: [process.execPath, '-e', slow, '--'] }, { cwd: root });
    await assert.rejects(deploy.up([{ name: 'llm', layer: 'llm' }]), /compose up timed out after 1000 ms/);
  } finally {
    await cleanup();
  }
});

test('production readiness: commandTimeoutMs warns when unbounded or above the safe range', () => {
  const specs = limitList(LIMITS).filter((s) => s.path === 'options.commandTimeoutMs');
  assert.deepEqual(limitFindings(specs, { options: {} }, 'production'), []);
  assert.deepEqual(limitFindings(specs, { options: { commandTimeoutMs: 'unbounded' } }, 'production').map((f) => f.severity), ['warn']);
  assert.deepEqual(limitFindings(specs, { options: { commandTimeoutMs: 7_200_000 } }, 'production').map((f) => f.severity), ['warn']);
  assert.deepEqual(limitFindings(specs, { options: { commandTimeoutMs: 'unbounded' } }, 'prototype'), []);
});
