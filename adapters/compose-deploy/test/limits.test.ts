import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry, type DeployPort, type ServiceSpec } from '@agent-layers/core';
import { composeFor } from '../src/generate.ts';
import { adapter, createComposeDeploy } from '../src/index.ts';
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
  await make({ healthIntervalS: '10', healthTimeoutS: '2', healthRetries: '5', errorOutputChars: '100' });
  await assert.rejects(make({ healthIntervalS: 0 }), /healthIntervalS/);
  await assert.rejects(make({ healthRetries: 'unbounded' }), /healthRetries/);
  await assert.rejects(make({ errorOutputChars: -1 }), /errorOutputChars/);
});
