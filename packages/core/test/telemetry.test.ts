import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTelemetry, type TelemetryPort } from '../src/index.ts';
import { recorder } from './helpers.ts';

test('agent.layer is mandatory', async () => {
  const t = createTelemetry([]);
  await assert.rejects(t.span('x', {} as never, async () => 1), /agent\.layer/);
  assert.throws(() => t.event('x', { 'agent.layer': 'nope' } as never), /agent\.layer/);
});

test('fan-out masks secret-looking attributes and survives a broken event sink', async () => {
  const a = recorder();
  const broken: TelemetryPort = { span: (_n, _a, fn) => fn({ setAttributes() {}, addEvent() {}, setError() {} }), event() { throw new Error('x'); }, metric() {} };
  const t = createTelemetry([a.telemetry, broken]);
  const v = await t.span('s', { 'agent.layer': 'tool', 'auth.token': 'abc', 'http.api_key': 'k', ok: 'y' }, async (s) => { s.setAttributes({ password: 'p' }); return 7; });
  assert.equal(v, 7);
  t.event('e', { 'agent.layer': 'tool', authorization: 'Bearer z' });
  const dump = JSON.stringify(a.records);
  assert.ok(!/abc|"k"|Bearer z|"p"/.test(dump), dump);
  assert.match(dump, /"ok":"y"/);
  t.metric('gen_ai.client.token.usage', 5, { 'agent.layer': 'llm', 'gen_ai.token.type': 'input', 'gen_ai.usage.input_tokens': 5 } as never);
  assert.match(JSON.stringify(a.records.at(-1)), /"gen_ai.token.type":"input","gen_ai.usage.input_tokens":5/, 'semantic-convention keys are not masked');
});

test('span records errors and rethrows', async () => {
  const a = recorder();
  await assert.rejects(createTelemetry([a.telemetry]).span('s', { 'agent.layer': 'llm' }, async () => { throw new Error('bad'); }), /bad/);
  assert.equal(a.records[0]!.type === 'span' && a.records[0]!.status, 'error');
});
