import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry, ATTR, SPAN, type Attributes, type TelemetryRecord } from '@agent-layers/core';
import { adapter, scoreLayers } from '../src/index.ts';

const ctx = { name: 'signals', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const long = 'x'.repeat(300);
const authorize = (tool: string): TelemetryRecord => {
  const attrs: Attributes = { [ATTR.layer]: 'identity', [ATTR.accessDecision]: 'deny', [ATTR.toolName]: tool };
  return { type: 'span', name: SPAN.accessCheck, layer: 'identity', start: new Date(0).toISOString(), durationMs: 1, status: 'ok', attrs, events: [] };
};

test('reasonChars bounds the reason detail and previewItems the listed names, when set', () => {
  const by = (limits = {}) => Object.fromEntries(scoreLayers([], { status: 'failed', reason: { code: 'error', detail: long } }, limits).map((s) => [s.layer, s.reason!]));
  assert.equal(by()['harness']!.length, 'run failed: error ()'.length + 160);
  assert.equal(by({ reasonChars: 20 })['harness']!.length, 'run failed: error ()'.length + 20);
  assert.ok(by({ reasonChars: 20 })['harness']!.endsWith(`(${'x'.repeat(19)}…)`));
  const tools = ['a', 'b', 'c', 'd', 'e'].map(authorize);
  assert.match(scoreLayers(tools, { status: 'completed' })[0]!.reason!, /denied: a, b, c$/);
  assert.match(scoreLayers(tools, { status: 'completed' }, { previewItems: 5 })[0]!.reason!, /denied: a, b, c, d, e$/);
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  const make = (options: Record<string, unknown>) => registry.create('EvaluatorPort', 'layer-signals', options, ctx);
  await make({ reasonChars: '200', previewItems: '5' });
  await assert.rejects(make({ reasonChars: 0 }), /reasonChars/);
  await assert.rejects(make({ reasonChars: 'unbounded' }), /reasonChars/);
  await assert.rejects(make({ previewItems: -1 }), /previewItems/);
  await assert.rejects(make({ guardReasonChars: 80 }), /guardReasonChars/);
});
