import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConsoleTelemetry, type ConsoleTelemetryOptions } from '../src/index.ts';

const attrs = { 'agent.layer': 'knowledge' as const, 'knowledge.source': 'docs', 'knowledge.tags': ['a', 'b'] };

function capture(options: ConsoleTelemetryOptions = {}) {
  const lines: string[] = [];
  return { lines, port: createConsoleTelemetry({ color: false, ...options }, { write: (l) => lines.push(l) }) };
}

test('pretty span line has label, name, duration, status and attributes', async () => {
  const { lines, port } = capture();
  await port.span('knowledge.search', attrs, async (span) => { span.setAttributes({ 'knowledge.passages': 3 }); });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\[L4 knowledge\] knowledge\.search \d+ms ok knowledge\.source=docs knowledge\.tags=a,b knowledge\.passages=3$/);
});

test('error spans show the message and still rethrow', async () => {
  const { lines, port } = capture();
  await assert.rejects(port.span('tool.call', { 'agent.layer': 'tool' }, async () => { throw new Error('boom'); }), /boom/);
  assert.match(lines[0]!, /^\[L5 tool\] tool\.call \d+ms error boom$/);
});

test('events print by default, metrics only when enabled', async () => {
  const off = capture();
  off.port.event('guard.block', { 'agent.layer': 'guardrail', stage: 'input' });
  off.port.metric('tokens', 12, { 'agent.layer': 'llm' });
  assert.deepEqual(off.lines, ['[L7 guardrail] guard.block event stage=input']);
  const on = capture({ metrics: true });
  on.port.metric('tokens', 12, { 'agent.layer': 'llm' });
  assert.deepEqual(on.lines, ['[L1 llm] tokens metric 12']);
});

test('spans and events can be switched off', async () => {
  const { lines, port } = capture({ spans: false, events: false });
  await port.span('x', attrs, async () => {});
  port.event('y', attrs);
  assert.deepEqual(lines, []);
});

test('json format writes one parseable record per line', async () => {
  const { lines, port } = capture({ format: 'json' });
  await port.span('knowledge.search', attrs, async () => {});
  port.event('e', attrs);
  assert.equal(lines.length, 2);
  const [span, event] = lines.map((l) => JSON.parse(l));
  assert.equal(span.type, 'span');
  assert.equal(span.layer, 'knowledge');
  assert.equal(event.type, 'event');
});

test('values with spaces are quoted and secret-looking keys are masked', () => {
  const { lines, port } = capture();
  port.event('e', { 'agent.layer': 'identity', note: 'two words', 'api_key': 'sk-123' });
  assert.equal(lines[0], '[L6 identity] e event note="two words" api_key=[redacted]');
});

test('color adds ANSI codes only when enabled', async () => {
  const { lines, port } = capture({ color: true });
  await port.span('s', attrs, async () => {});
  assert.match(lines[0]!, /\u001b\[/);
});
