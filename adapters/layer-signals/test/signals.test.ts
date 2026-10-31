import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Attributes, Layer, TelemetryRecord } from '@agent-layers/core';
import { createLayerSignals, scoreLayers } from '../src/index.ts';

const span = (name: string, layer: Layer, attrs: Attributes = {}, status: 'ok' | 'error' = 'ok'): TelemetryRecord =>
  ({ type: 'span', name, layer, start: new Date(0).toISOString(), durationMs: 1, status, attrs: { 'agent.layer': layer, ...attrs }, events: [] });
const byLayer = (items: Parameters<typeof scoreLayers>[0], status = 'completed', reason?: string) =>
  Object.fromEntries(scoreLayers(items, { status, ...(reason ? { reason } : {}) }).map((s) => [s.layer, s]));

describe('from telemetry records', () => {
  test('guardrail: allow 1, redact 0.5, block 0, with where and never the text', () => {
    assert.equal(byLayer([span('guard.check', 'guardrail', { 'guard.action': 'allow' })]).guardrail!.value, 1);
    const redact = byLayer([span('guard.check', 'guardrail', { 'guard.action': 'redact', 'guard.name': 'presidio', 'guard.stage': 'input' })]).guardrail!;
    assert.equal(redact.value, 0.5);
    assert.match(redact.reason!, /1 redacted \(presidio@input\)/);
    const block = byLayer([span('guard.check', 'guardrail', { 'guard.action': 'redact' }), span('guard.check', 'guardrail', { 'guard.action': 'block', 'guard.name': 'g', 'guard.stage': 'output' })]).guardrail!;
    assert.equal(block.value, 0);
  });

  test('a run stopped by a guard blames the guardrail layer, not the harness', () => {
    const scores = byLayer([], 'stopped', 'guardrail:regex-guard:input');
    assert.equal(scores.guardrail!.value, 0);
    assert.equal(scores.harness, undefined);
  });

  test('identity: share of denied authorizations', () => {
    const s = byLayer([
      span('authorize', 'identity', { 'policy.decision': 'allow', 'gen_ai.tool.name': 'a' }),
      span('authorize', 'identity', { 'policy.decision': 'deny', 'gen_ai.tool.name': 'crm__delete' }),
    ]).identity!;
    assert.equal(s.value, 0.5);
    assert.match(s.reason!, /crm__delete/);
  });

  test('tool: errors count, denied and blocked calls belong to other layers', () => {
    const s = byLayer([
      span('execute_tool', 'tool', { 'tool.outcome': 'ok' }),
      span('execute_tool', 'tool', { 'tool.outcome': 'error', 'gen_ai.tool.name': 'flaky' }),
      span('execute_tool', 'tool', { 'tool.outcome': 'denied' }),
      span('execute_tool', 'tool', { 'tool.outcome': 'blocked' }),
    ]);
    assert.equal(s.tool!.value, 0.5);
    assert.match(s.tool!.reason!, /1\/2 calls failed: flaky/);
    assert.equal(byLayer([span('execute_tool', 'tool', { 'tool.outcome': 'denied' })]).tool, undefined);
  });

  test('knowledge: failed searches and knowledge-layer tools; an empty search is reported, not failed', () => {
    const s = byLayer([
      span('knowledge.search', 'knowledge', { 'knowledge.passages': 3 }),
      span('knowledge.search', 'knowledge', { 'knowledge.passages': 0 }),
      span('knowledge.search', 'knowledge', {}, 'error'),
      span('execute_tool', 'knowledge', { 'tool.outcome': 'error' }),
    ]).knowledge!;
    assert.equal(s.value, 0.5);
    assert.match(s.reason!, /1 searches failed, 1 knowledge tool errors \(of 4\); 1 returned no passages/);
    const offTopic = byLayer([span('knowledge.search', 'knowledge', { 'knowledge.passages': 0 })]).knowledge!;
    assert.equal(offTopic.value, 1, 'a question the sources do not cover is not a knowledge failure');
    assert.match(offTopic.reason!, /1 searches ok; 1 returned no passages/);
  });

  test('llm: errored calls and cut-off answers', () => {
    const s = byLayer([
      span('chat', 'llm', { 'gen_ai.response.finish_reasons': ['stop'] }),
      span('chat', 'llm', { 'gen_ai.response.finish_reasons': ['length'] }),
      span('chat', 'llm', {}, 'error'),
      span('chat', 'llm', { 'gen_ai.response.finish_reasons': ['stop'] }),
    ]).llm!;
    assert.equal(s.value, 0.5);
  });

  test('cache: a miss is healthy, a failed lookup is not; the reason has the hit rate', () => {
    const s = byLayer([span('cache.lookup', 'cache', { 'cache.hit': true }), span('cache.lookup', 'cache', { 'cache.hit': false })]).cache!;
    assert.equal(s.value, 1);
    assert.equal(s.reason, '1/2 lookups hit');
    assert.equal(byLayer([span('cache.lookup', 'cache', {}, 'error')]).cache!.value, 0);
  });

  test('telemetry that is not a span is ignored', () => {
    const items: TelemetryRecord[] = [
      { type: 'metric', name: 'agent.tool.calls', layer: 'tool', time: '', value: 1, attrs: { 'agent.layer': 'tool' } },
      { type: 'event', name: 'knowledge.error', layer: 'knowledge', time: '', attrs: { 'agent.layer': 'knowledge' } },
    ];
    assert.deepEqual(scoreLayers(items, { status: 'completed' }).map((s) => s.layer), ['harness']);
  });
});

describe('from runtime events', () => {
  test('tool_result errors, model_response finish reasons, run_end reason', () => {
    const s = byLayer([
      { type: 'run_start', agent: 'a' },
      { type: 'model_response', finish_reason: 'tool_calls' },
      { type: 'tool_result', name: 'add', isError: false },
      { type: 'tool_result', name: 'boom', isError: true },
      { type: 'model_response', finish_reason: 'length' },
    ]);
    assert.equal(s.tool!.value, 0.5);
    assert.equal(s.llm!.value, 0.5);
    assert.equal(s.harness!.value, 1);
  });

  test('a failed run with a provider reason is the model, not the harness', () => {
    const s = byLayer([{ type: 'run_end', status: 'failed', reason: 'HTTP 503 from the provider' }], 'failed');
    assert.equal(s.llm!.value, 0);
    assert.equal(s.harness, undefined);
  });

  test('any other failure is the harness; the reason comes from the result or from run_end', () => {
    assert.equal(byLayer([], 'stopped', 'max_turns').harness!.reason, 'run stopped: max_turns');
    assert.equal(byLayer([{ type: 'run_end', status: 'stopped', reason: 'aborted' }], 'stopped').harness!.reason, 'run stopped: aborted');
  });

  test('telemetry wins over runtime events for the same layer: denied tools are not tool errors', () => {
    const s = byLayer([span('execute_tool', 'tool', { 'tool.outcome': 'denied' }), { type: 'tool_result', name: 'x', isError: true }]);
    assert.equal(s.tool, undefined);
  });

  test('no events and a completed run: only the harness is scored', () => {
    assert.deepEqual(scoreLayers([], { status: 'completed' }).map((s) => [s.metric, s.value, s.layer]), [['harness_health', 1, 'harness']]);
  });
});

describe('the evaluator', () => {
  test('reads events and reason from the run', async () => {
    const scores = await createLayerSignals().score({ id: 'c', input: 'x' }, { runId: 'r', output: '', status: 'stopped', reason: 'guardrail:g:input' } as never);
    assert.deepEqual(scores.map((s) => s.layer), ['guardrail']);
  });
  test('layers limits the report', async () => {
    const run = { runId: 'r', output: '', status: 'completed', events: [{ type: 'tool_result', isError: true }] };
    assert.deepEqual((await createLayerSignals({ layers: ['tool'] }).score({ id: 'c', input: 'x' }, run)).map((s) => s.layer), ['tool']);
  });
  test('scores are bounded and carry the layer', async () => {
    const scores = await createLayerSignals().score({ id: 'c', input: 'x' }, { runId: 'r', output: '', status: 'completed', events: [{ type: 'tool_result', isError: true }] });
    for (const s of scores) assert.ok(s.value >= 0 && s.value <= 1 && s.layer && s.metric === `${s.layer}_health`);
  });
});
