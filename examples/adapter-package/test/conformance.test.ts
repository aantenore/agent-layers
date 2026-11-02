import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, createMappings, noopTelemetry } from '@agent-layers/core';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter, createTemplateGuard, WORD_KEY } from '../src/index.ts';

const input = (text: string) => ({ stage: 'input' as const, text, agent: 'assistant', runId: 'r1' });

test('template adapter passes GuardPort conformance', async () => {
  const report = await checkAdapter(adapter, {
    options: { deny: ['forbidden'] },
    fixtures: { block: [{ stage: 'input', text: 'this is forbidden' }] },
  });
  assert.deepEqual(report.failures, []);
});

test('the matched word is in ext; text over maxTextChars is blocked', async () => {
  const guard = createTemplateGuard({ deny: ['forbidden'], maxTextChars: 20 });
  assert.deepEqual((await guard.check(input('forbidden'))).ext, { [WORD_KEY]: 'forbidden' });
  assert.deepEqual(await guard.check(input('a'.repeat(21))), { action: 'block', reason: 'text too long' });
  assert.equal((await guard.check(input('fine'))).action, 'allow');
});

test('in rules from the stack config build the verdict from the native result', async () => {
  const mappings = createMappings('guardrails.template', { in: [{ from: '/word', to: '/labels', map: { forbidden: ['policy'] } }] });
  const verdict = await createTemplateGuard({ deny: ['forbidden'] }, 'template', mappings).check(input('forbidden'));
  assert.deepEqual(verdict.labels, ['policy']);
});

test('limits are validated when the adapter is created', async () => {
  const registry = new AdapterRegistry().register(adapter);
  const ctx = { name: 'template', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
  await registry.create('GuardPort', 'template', { maxTextChars: 'unbounded' }, ctx);
  await assert.rejects(registry.create('GuardPort', 'template', { maxTextChars: 0 }, ctx), /maxTextChars/);
});
