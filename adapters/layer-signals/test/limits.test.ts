import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry, type TelemetryRecord } from '@agent-layers/core';
import { adapter, scoreLayers } from '../src/index.ts';

const ctx = { name: 'signals', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const long = 'x'.repeat(300);
const authorize = (tool: string): TelemetryRecord =>
  ({ type: 'span', name: 'authorize', layer: 'identity', start: new Date(0).toISOString(), durationMs: 1, status: 'ok', attrs: { 'agent.layer': 'identity', 'policy.decision': 'deny', 'gen_ai.tool.name': tool }, events: [] });

test('reasonChars, guardReasonChars and previewItems take effect when set', () => {
  const by = (reason: string, status: string, limits = {}) => Object.fromEntries(scoreLayers([], { status, reason }, limits).map((s) => [s.layer, s.reason!]));
  assert.equal(by(long, 'failed')['harness']!.length, 'run failed: '.length + 160);
  assert.equal(by(long, 'failed', { reasonChars: 20 })['harness']!.length, 'run failed: '.length + 20);
  assert.equal(by(`guardrail:${long}`, 'stopped')['guardrail']!.length, '1 blocked; run '.length + 80);
  assert.ok(by(`guardrail:${long}`, 'stopped', { guardReasonChars: 30 })['guardrail']!.endsWith(`${'x'.repeat(19)}…`));
  const tools = ['a', 'b', 'c', 'd', 'e'].map(authorize);
  assert.match(scoreLayers(tools, { status: 'completed' })[0]!.reason!, /denied: a, b, c$/);
  assert.match(scoreLayers(tools, { status: 'completed' }, { previewItems: 5 })[0]!.reason!, /denied: a, b, c, d, e$/);
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  const make = (options: Record<string, unknown>) => registry.create('EvaluatorPort', 'layer-signals', options, ctx);
  await make({ reasonChars: '200', guardReasonChars: '100', previewItems: '5' });
  await assert.rejects(make({ reasonChars: 0 }), /reasonChars/);
  await assert.rejects(make({ guardReasonChars: 'unbounded' }), /guardReasonChars/);
  await assert.rejects(make({ previewItems: -1 }), /previewItems/);
});
