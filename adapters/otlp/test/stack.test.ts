import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { compose, resolveProfile, type StackConfig } from '@agent-layers/core';
import { adapter as basicRuntime } from '@agent-layers/adapter-basic-runtime';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { adapter as regexGuard } from '@agent-layers/adapter-regex-guard';
import { adapter as otlp } from '../src/index.ts';
import { attr, collector, type Collector } from './collector.ts';

let sink: Collector;
before(async () => { sink = await collector(); });
after(() => sink.close());

const config = (endpoint: string): StackConfig => ({
  layers: {
    model: { adapter: 'mock-model' },
    runtime: { adapter: 'basic-runtime' },
    guardrails: [{ adapter: 'regex-guard', options: { detect: ['email'] } }],
    telemetry: [{ adapter: 'otlp', options: { endpoint, serviceName: 'stack-test' } }],
  },
  agents: { assistant: { instructions: 'Answer briefly.', model: 'mock', tools: [] } },
});

test('a composed stack exports one trace per run: the run span with guard and model spans below it', async () => {
  const stack = await compose(resolveProfile(config(sink.url)), { adapters: [mockModel, basicRuntime, regexGuard, otlp] });
  const result = await (await stack.agent('assistant')).run('My email is jane.doe@example.com');
  await stack.close();

  assert.equal(result.status, 'completed');
  assert.ok(!result.output.includes('jane.doe@example.com'), 'the model never saw the address');

  const spans = sink.spans();
  const run = spans.find((s) => s.name === 'invoke_agent assistant')!;
  assert.ok(run, 'run span');
  assert.equal(run.parentSpanId, undefined);
  assert.equal(attr(run, 'agent.layer'), 'harness');
  assert.equal(attr(run, 'run.status'), 'completed');
  const children = spans.filter((s) => s.parentSpanId === run.spanId);
  const layers = new Set(children.map((s) => attr(s, 'agent.layer')));
  assert.ok(layers.has('guardrail') && layers.has('llm'), `children layers: ${[...layers].join(', ')}`);
  assert.ok(children.some((s) => s.name === 'guard.check' && attr(s, 'guard.action') === 'redact'));
  assert.ok(children.some((s) => s.name === 'chat mock'));
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 1);
  assert.ok(spans.every((s) => attr(s, 'agent.layer')));
  assert.ok(sink.metrics().some((m) => m.name === 'agent.guardrail.actions'));
  assert.ok(sink.metrics().some((m) => m.name === 'gen_ai.client.token.usage'));
  assert.ok(!JSON.stringify(sink.requests).includes('jane.doe'), 'no content in the export');
});
