import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ATTR, EVENT, SPAN, type Attributes, type EvalScore, type Layer, type RunEvent, type RunStatus, type StopReason, type TelemetryRecord } from '@agent-layers/core';
import { attributeLayer, attributedScore, createLayerSignals, scoreLayers, type SignalItem } from '../src/index.ts';

const span = (name: string, layer: Layer, attrs: Attributes = {}, status: 'ok' | 'error' = 'ok'): TelemetryRecord =>
  ({ type: 'span', name, layer, start: new Date(0).toISOString(), durationMs: 1, status, attrs: { [ATTR.layer]: layer, ...attrs }, events: [] });
const event = (e: RunEvent): RunEvent => e;
const byLayer = (items: (SignalItem)[], status: RunStatus = 'completed', reason?: StopReason) =>
  Object.fromEntries(scoreLayers(items, { status, ...(reason ? { reason } : {}) }).map((s) => [s.layer, s]));
const guardStop: StopReason = { code: 'guard_block', layer: 'guardrail', by: 'regex-guard', stage: 'input' };

describe('from telemetry records', () => {
  test('guardrail: allow 1, redact 0.5, block 0, with where and never the text', () => {
    assert.equal(byLayer([span(SPAN.guardCheck, 'guardrail', { [ATTR.guardAction]: 'allow' })]).guardrail!.value, 1);
    const redact = byLayer([span(SPAN.guardCheck, 'guardrail', { [ATTR.guardAction]: 'redact', [ATTR.guardName]: 'presidio', [ATTR.guardStage]: 'input' })]).guardrail!;
    assert.equal(redact.value, 0.5);
    assert.match(redact.reason!, /1 redacted \(presidio@input\)/);
    const block = byLayer([span(SPAN.guardCheck, 'guardrail', { [ATTR.guardAction]: 'redact' }), span(SPAN.guardCheck, 'guardrail', { [ATTR.guardAction]: 'block', [ATTR.guardName]: 'g', [ATTR.guardStage]: 'output' })]).guardrail!;
    assert.equal(block.value, 0);
  });

  test('a run stopped by a guard blames the guardrail layer, not the harness', () => {
    const scores = byLayer([], 'stopped', guardStop);
    assert.equal(scores.guardrail!.value, 0);
    assert.equal(scores.guardrail!.reason, '1 blocked; run stopped by regex-guard@input');
    assert.equal(scores.harness, undefined);
  });

  test('the stop code can come from the agent.run span when the result carries no reason', () => {
    const scores = scoreLayers([span(SPAN.run, 'harness', { [ATTR.runReason]: 'guard_block' })], { status: 'stopped' });
    assert.deepEqual(scores.map((s) => s.layer), ['guardrail']);
  });

  test('identity: share of denied authorizations', () => {
    const s = byLayer([
      span(SPAN.accessCheck, 'identity', { [ATTR.accessDecision]: 'allow', [ATTR.toolName]: 'a' }),
      span(SPAN.accessCheck, 'identity', { [ATTR.accessDecision]: 'deny', [ATTR.toolName]: 'crm__delete' }),
    ]).identity!;
    assert.equal(s.value, 0.5);
    assert.match(s.reason!, /crm__delete/);
  });

  test('identity: a call waiting for an approval is not a denial', () => {
    const s = byLayer([
      span(SPAN.accessCheck, 'identity', { [ATTR.accessDecision]: 'deny', [ATTR.toolName]: 'util__save_note' }),
      span(SPAN.toolCall, 'tool', { [ATTR.toolOutcome]: 'pending', [ATTR.toolName]: 'util__save_note' }),
    ], 'waiting', { code: 'needs_input', layer: 'identity', by: 'approvals', detail: 'ap-1' });
    assert.equal(s.identity!.value, 1);
    assert.match(s.identity!.reason!, /1 awaiting approval/);
    assert.equal(s.tool, undefined);
    assert.deepEqual([s.harness!.value, s.harness!.reason], [1, 'waiting: needs_input']);
  });

  test('tool: errors count, denied and blocked calls belong to other layers', () => {
    const s = byLayer([
      span(SPAN.toolCall, 'tool', { [ATTR.toolOutcome]: 'ok' }),
      span(SPAN.toolCall, 'tool', { [ATTR.toolOutcome]: 'error', [ATTR.toolName]: 'flaky' }),
      span(SPAN.toolCall, 'tool', { [ATTR.toolOutcome]: 'denied' }),
      span(SPAN.toolCall, 'tool', { [ATTR.toolOutcome]: 'blocked' }),
    ]);
    assert.equal(s.tool!.value, 0.5);
    assert.match(s.tool!.reason!, /1\/2 calls failed: flaky/);
    assert.equal(byLayer([span(SPAN.toolCall, 'tool', { [ATTR.toolOutcome]: 'denied' })]).tool, undefined);
  });

  test('knowledge: failed searches and knowledge-layer tools; an empty search is reported, not failed', () => {
    const s = byLayer([
      span(SPAN.knowledgeSearch, 'knowledge', { [ATTR.knowledgePassages]: 3 }),
      span(SPAN.knowledgeSearch, 'knowledge', { [ATTR.knowledgePassages]: 0 }),
      span(SPAN.knowledgeSearch, 'knowledge', {}, 'error'),
      span(SPAN.toolCall, 'knowledge', { [ATTR.toolOutcome]: 'error' }),
    ]).knowledge!;
    assert.equal(s.value, 0.5);
    assert.match(s.reason!, /1 searches failed, 1 knowledge tool errors \(of 4\); 1 returned no passages/);
    const offTopic = byLayer([span(SPAN.knowledgeSearch, 'knowledge', { [ATTR.knowledgePassages]: 0 })]).knowledge!;
    assert.equal(offTopic.value, 1, 'a question the sources do not cover is not a knowledge failure');
    assert.match(offTopic.reason!, /1 searches ok; 1 returned no passages/);
  });

  test('knowledge: the error event counts once next to its failed span, and alone', () => {
    const errorEvent: TelemetryRecord = { type: 'event', name: EVENT.knowledgeError, layer: 'knowledge', time: '', attrs: { [ATTR.layer]: 'knowledge' } };
    const both = byLayer([span(SPAN.knowledgeSearch, 'knowledge', {}, 'error'), errorEvent]).knowledge!;
    assert.deepEqual([both.value, both.reason], [0, '1 searches failed (of 1)']);
    assert.equal(byLayer([errorEvent]).knowledge!.value, 0);
  });

  test('llm: errored calls and cut-off answers', () => {
    const s = byLayer([
      span(SPAN.modelCall, 'llm', { [ATTR.modelFinish]: 'end' }),
      span(SPAN.modelCall, 'llm', { [ATTR.modelFinish]: 'limit' }),
      span(SPAN.modelCall, 'llm', {}, 'error'),
      span(SPAN.modelCall, 'llm', { [ATTR.modelFinish]: 'end' }),
    ]).llm!;
    assert.equal(s.value, 0.5);
    assert.equal(byLayer([span(SPAN.modelCall, 'llm', { [ATTR.modelFinish]: 'refused' })]).llm!.value, 0);
  });

  test('cache: a miss is healthy, a failed lookup is not; the reason has the hit rate', () => {
    const s = byLayer([span(SPAN.cacheLookup, 'cache', { [ATTR.cacheHit]: true }), span(SPAN.cacheLookup, 'cache', { [ATTR.cacheHit]: false })]).cache!;
    assert.equal(s.value, 1);
    assert.equal(s.reason, '1/2 lookups hit');
    assert.equal(byLayer([span(SPAN.cacheLookup, 'cache', {}, 'error')]).cache!.value, 0);
  });

  test('metrics and unrelated events are ignored', () => {
    const items: TelemetryRecord[] = [
      { type: 'metric', name: 'agent.tool.calls', layer: 'tool', time: '', value: 1, attrs: { [ATTR.layer]: 'tool' } },
      { type: 'event', name: EVENT.configWarning, layer: 'harness', time: '', attrs: { [ATTR.layer]: 'harness' } },
    ];
    assert.deepEqual(scoreLayers(items, { status: 'completed' }).map((s) => s.layer), ['harness']);
  });
});

describe('from run events', () => {
  test('tool.result failures, model.reply finish values, run.end', () => {
    const s = byLayer([
      event({ type: 'run.start', runId: 'r', agent: 'a' }),
      event({ type: 'model.reply', turn: 1, model: 'm', finish: 'tools', calls: 2 }),
      event({ type: 'tool.result', id: '1', tool: 'add', ok: true }),
      event({ type: 'tool.result', id: '2', tool: 'boom', ok: false }),
      event({ type: 'model.reply', turn: 2, model: 'm', finish: 'limit', calls: 0 }),
    ]);
    assert.equal(s.tool!.value, 0.5);
    assert.match(s.tool!.reason!, /boom/);
    assert.equal(s.llm!.value, 0.5);
    assert.equal(s.harness!.value, 1);
  });

  test('a failed run whose last model answer was cut off is the model, not the harness', () => {
    const s = byLayer([event({ type: 'model.reply', turn: 1, model: 'm', finish: 'limit', calls: 0 })], 'failed', { code: 'error' });
    assert.equal(s.llm!.value, 0);
    assert.equal(s.harness, undefined);
  });

  test('a failed run whose last model call errored, or whose reason names the llm layer, is the model', () => {
    const errored = byLayer([span(SPAN.modelCall, 'llm', {}, 'error')], 'failed', { code: 'error', detail: 'Error' });
    assert.equal(errored.llm!.value, 0);
    assert.equal(errored.harness, undefined);
    const named = byLayer([], 'failed', { code: 'timeout', layer: 'llm' });
    assert.deepEqual([named.llm!.value, named.llm!.reason, named.harness], [0, 'run failed: timeout', undefined]);
  });

  test('any other failure is the harness; the reason comes from the result or from run.end', () => {
    assert.equal(byLayer([], 'stopped', { code: 'limit', layer: 'harness', detail: 'turns' }).harness!.reason, 'run stopped: limit (turns)');
    assert.equal(byLayer([event({ type: 'run.end', status: 'stopped', reason: { code: 'aborted' } })], 'stopped').harness!.reason, 'run stopped: aborted');
  });

  test('a run waiting for a person is not a harness failure', () => {
    const s = byLayer([], 'waiting', { code: 'needs_input', layer: 'identity', by: 'approvals', detail: 'ap-1' });
    assert.deepEqual([s.harness!.value, s.harness!.reason], [1, 'waiting: needs_input']);
    assert.equal(byLayer([], 'waiting').harness!.reason, 'waiting');
  });

  test('telemetry wins over run events for the same layer: denied tools are not tool errors', () => {
    const s = byLayer([span(SPAN.toolCall, 'tool', { [ATTR.toolOutcome]: 'denied' }), event({ type: 'tool.result', id: '1', tool: 'x', ok: false })]);
    assert.equal(s.tool, undefined);
  });

  test('no events and a completed run: only the harness is scored', () => {
    assert.deepEqual(scoreLayers([], { status: 'completed' }).map((s) => [s.metric, s.value, s.layer]), [['harness_health', 1, 'harness']]);
  });
});

describe('attribution', () => {
  const s = (layer: Layer, value: number, reason?: string): EvalScore => ({ metric: `${layer}_health`, value, layer, ...(reason ? { reason } : {}) });

  test('the worst layer other than the harness among those below 1', () => {
    const blamed = attributeLayer([s('harness', 0, 'h'), s('tool', 0.5, 't'), s('identity', 0.25, 'i'), s('llm', 1)]);
    assert.deepEqual(blamed, { layer: 'identity', value: 0.25, reason: 'i' });
  });

  test('ties go to the layer first in LAYERS, whatever the input order', () => {
    assert.equal(attributeLayer([s('guardrail', 0), s('tool', 0), s('llm', 0)])?.layer, 'llm');
    assert.equal(attributeLayer([s('llm', 0), s('tool', 0)].reverse())?.layer, 'llm');
    assert.equal(attributeLayer([s('knowledge', 0.5), s('cache', 0.5)])?.layer, 'cache');
  });

  test('the harness only when nothing else is below 1', () => {
    assert.equal(attributeLayer([s('harness', 0), s('tool', 1), s('llm', 1)])?.layer, 'harness');
    assert.equal(attributeLayer([s('harness', 0), s('cache', 0.9)])?.layer, 'cache');
  });

  test('none when every layer is healthy, or there are no layer scores', () => {
    assert.equal(attributeLayer([s('harness', 1), s('tool', 1)]), undefined);
    assert.equal(attributeLayer([]), undefined);
    assert.equal(attributeLayer([{ metric: 'x', value: 0 }]), undefined);
  });

  test('the attributed score carries the blamed layer, its value and "<layer>: <reason>"', () => {
    assert.deepEqual(attributedScore([s('tool', 0.5, '1/2 calls failed: flaky'), s('harness', 1)]), { metric: 'attributed', value: 0.5, layer: 'tool', reason: 'tool: 1/2 calls failed: flaky' });
    assert.deepEqual(attributedScore([s('harness', 1)]), { metric: 'attributed', value: 1, reason: 'none' });
  });
});

describe('the evaluator', () => {
  const c = { id: 'c', input: 'x' };
  const completed = { runId: 'r', output: '', status: 'completed' as const };
  test('reads events and the structured reason from the run, and attributes the guard', async () => {
    const scores = await createLayerSignals().score(c, { runId: 'r', output: '', status: 'stopped', reason: guardStop });
    assert.deepEqual(scores.map((s) => [s.metric, s.layer]), [['guardrail_health', 'guardrail'], ['attributed', 'guardrail']]);
    assert.equal(scores.at(-1)!.reason, 'guardrail: 1 blocked; run stopped by regex-guard@input');
  });
  test('layers limits the health scores, and the attribution to the layers reported', async () => {
    const run = { ...completed, events: [event({ type: 'tool.result', id: '1', tool: 't', ok: false })] };
    assert.deepEqual((await createLayerSignals({ layers: ['tool'] }).score(c, run)).map((s) => s.metric), ['tool_health', 'attributed']);
    const failed = { runId: 'r', output: '', status: 'failed' as const, reason: { code: 'error' }, events: run.events };
    const only = await createLayerSignals({ layers: ['harness'] }).score(c, failed);
    assert.equal(only.at(-1)!.layer, 'harness');
  });
  test('a healthy run is attributed to none', async () => {
    const scores = await createLayerSignals().score(c, completed);
    assert.deepEqual(scores.at(-1), { metric: 'attributed', value: 1, reason: 'none' });
  });
  test('scores are bounded and the health scores carry the layer', async () => {
    const scores = await createLayerSignals().score(c, { ...completed, events: [event({ type: 'tool.result', id: '1', tool: 't', ok: false })] });
    for (const s of scores) assert.ok(s.value >= 0 && s.value <= 1);
    for (const s of scores.filter((x) => x.metric !== 'attributed')) assert.ok(s.layer && s.metric === `${s.layer}_health`);
  });
});
