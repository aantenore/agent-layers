import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleDeltas, GuardrailBlocked, guardedModel, messageText, partsText, replyText, runGuards, textMessage, type CachePort, type GuardPort, type ModelDelta } from '../src/index.ts';
import { ctx, fakeGuard, fakeModel, recorder, reply } from './helpers.ts';

function memoryCache(log: string[]): CachePort {
  const m = new Map<string, unknown>();
  return { get: async (k) => { log.push(m.has(k) ? 'cache:hit' : 'cache:miss'); return m.get(k); }, set: async (k, v) => { log.push('cache:set'); m.set(k, v); } };
}

test('order: input guard → cache → router → model → cache store → output guard', async () => {
  const log: string[] = [];
  const { model } = fakeModel(() => reply('answer'), log);
  const m = guardedModel(model, {
    guards: [fakeGuard('g', () => ({ action: 'allow' }), log)],
    cache: memoryCache(log),
    router: { select: (req) => { log.push('router'); return `${req.model}-routed`; } },
  });
  await m.chat({ model: 'base', messages: [textMessage('user', 'hi')] }, ctx());
  assert.deepEqual(log, ['g:input', 'cache:miss', 'router', 'model', 'cache:set', 'g:output']);
  log.length = 0;
  await m.chat({ model: 'base', messages: [textMessage('user', 'hi')] }, ctx());
  assert.deepEqual(log, ['g:input', 'cache:hit', 'g:output'], 'a cache hit skips router and model but still runs output guards');
});

test('router choice reaches the model', async () => {
  const { model, requests } = fakeModel();
  await guardedModel(model, { router: { select: () => 'small' } }).chat({ model: 'big', messages: [textMessage('user', 'x')] }, ctx());
  assert.equal(requests[0]!.model, 'small');
});

test('input block throws GuardrailBlocked and never calls the model', async () => {
  const { model, requests } = fakeModel();
  const m = guardedModel(model, { guards: [fakeGuard('pii', (t) => (t.includes('secret') ? { action: 'block', reason: 'nope' } : { action: 'allow' }))] });
  await assert.rejects(m.chat({ model: 'x', messages: [textMessage('user', 'my secret')] }, ctx()), (e: unknown) =>
    e instanceof GuardrailBlocked && e.message === 'blocked by guard pii at input' && e.stage === 'input' && e.reason === 'nope'
    && e.stopReason.code === 'guard_block' && e.stopReason.by === 'pii');
  assert.equal(requests.length, 0);
});

test('redact rewrites only new user content, and the output', async () => {
  const { model, requests } = fakeModel(() => reply('call 555-0100'));
  const redact = fakeGuard('r', (t) => ({ action: 'redact', text: t.replace(/\d{3}-\d{4}/g, '[PHONE]').replace('bob@x.io', '[EMAIL]') }));
  const res = await guardedModel(model, { guards: [redact] }).chat({
    model: 'x',
    messages: [
      textMessage('user', 'old bob@x.io'),
      textMessage('assistant', 'ok'),
      { role: 'user', parts: [{ type: 'text', text: 'new bob@x.io' }, { type: 'media', mediaType: 'image/png', url: 'u' }] },
    ],
  }, ctx());
  assert.equal(messageText(requests[0]!.messages[0]), 'old bob@x.io', 'history is not re-guarded');
  assert.deepEqual(requests[0]!.messages[2]!.parts, [{ type: 'text', text: 'new [EMAIL]' }, { type: 'media', mediaType: 'image/png', url: 'u' }]);
  assert.equal(replyText(res), 'call [PHONE]');
});

test('output block throws with stage output; a throwing guard fails closed', async () => {
  const { model } = fakeModel(() => reply('bad words'));
  await assert.rejects(guardedModel(model, { guards: [fakeGuard('o', (t, s) => (s === 'output' ? { action: 'block' } : { action: 'allow' }))] })
    .chat({ model: 'x', messages: [textMessage('user', 'hi')] }, ctx()), /blocked by guard o at output/);
  const broken = { name: 'broken', check: async () => { throw new Error('down'); } };
  await assert.rejects(guardedModel(model, { guards: [broken] }).chat({ model: 'x', messages: [textMessage('user', 'hi')] }, ctx()), /blocked by guard broken at input/);
});

test('guards with stages run only there', async () => {
  const log: string[] = [];
  const { model } = fakeModel();
  await guardedModel(model, { guards: [fakeGuard('in-only', () => ({ action: 'allow' }), log, ['input'])] }).chat({ model: 'x', messages: [textMessage('user', 'hi')] }, ctx());
  assert.deepEqual(log, ['in-only:input']);
});

test('stream passes through without output guards and buffers with them', async () => {
  const deltas: ModelDelta[] = [
    { type: 'text', text: 'mail ' },
    { type: 'text', text: 'a@b.co' },
    { type: 'end', finish: 'end', model: 'f' },
  ];
  const streaming = { name: 's', chat: async () => reply('unused'), async *stream() { yield* deltas; } };
  const plain: ModelDelta[] = [];
  for await (const c of guardedModel(streaming).stream!({ model: 'x', messages: [textMessage('user', 'hi')] }, ctx())) plain.push(c);
  assert.deepEqual(plain, deltas);
  const guarded: ModelDelta[] = [];
  const redact = fakeGuard('r', (t) => ({ action: 'redact', text: t.replace('a@b.co', '[EMAIL]') }));
  for await (const c of guardedModel(streaming, { guards: [redact] }).stream!({ model: 'x', messages: [textMessage('user', 'hi')] }, ctx())) guarded.push(c);
  assert.equal(partsText(assembleDeltas(guarded).message.parts), 'mail [EMAIL]');
});

test('every step is a span tagged with its layer; usage becomes metrics', async () => {
  const { records, telemetry } = recorder();
  const { model } = fakeModel();
  await guardedModel(model, {
    telemetry, guards: [fakeGuard('g', () => ({ action: 'allow' }))], router: { select: () => 'm' },
    cache: { get: async () => undefined, set: async () => {} },
  }).chat({ model: 'x', messages: [textMessage('user', 'hi')] }, ctx());
  const spans = records.filter((r) => r.type === 'span').map((r) => `${r.name}@${r.layer}`);
  assert.deepEqual(spans, ['agent.guard.check@guardrail', 'agent.cache.lookup@cache', 'agent.router.select@cache', 'agent.model.call@llm', 'agent.guard.check@guardrail']);
  assert.ok(records.some((r) => r.type === 'metric' && r.name === 'agent.model.tokens' && r.attrs['agent.tokens.kind'] === 'input' && r.value === 3));
  assert.ok(records.some((r) => r.type === 'metric' && r.name === 'agent.model.tokens' && r.attrs['agent.tokens.kind'] === 'output' && r.value === 2));
});

test('a guard that throws blocks with the fixed reason "guard error", never the thrown message', async () => {
  const { model, requests } = fakeModel();
  const { records, telemetry } = recorder();
  const boom: GuardPort = { name: 'flaky', async check() { throw new Error('backend said: token sk-live-123 rejected for "my secret"'); } };
  const m = guardedModel(model, { guards: [boom], telemetry });
  await assert.rejects(m.chat({ model: 'x', messages: [textMessage('user', 'my secret')] }, ctx()), (e: unknown) =>
    e instanceof GuardrailBlocked && e.reason === 'guard error' && e.message === 'blocked by guard flaky at input');
  assert.equal(requests.length, 0);
  assert.ok(!JSON.stringify(records).includes('sk-live-123'), 'the thrown message never reaches telemetry');
  const out = await runGuards([boom], 'tool_args', '{}', ctx(), telemetry, 'util__x');
  assert.deepEqual(out, { action: 'block', text: '{}', guard: 'flaky', reason: 'guard error', labels: ['other'] });
});

test('output guards also read reasoning parts: redacted in a reply and in a buffered stream, blocked when a guard blocks', async () => {
  const withReasoning = { ...reply('done'), message: { role: 'assistant' as const, parts: [{ type: 'reasoning' as const, text: 'mail a@b.co first' }, { type: 'text' as const, text: 'done' }] } };
  const { model } = fakeModel(() => withReasoning);
  const redact = fakeGuard('r', (t) => ({ action: 'redact', text: t.replace('a@b.co', '[EMAIL]') }));
  const res = await guardedModel(model, { guards: [redact] }).chat({ model: 'x', messages: [textMessage('user', 'hi')] }, ctx());
  assert.deepEqual(res.message.parts[0], { type: 'reasoning', text: 'mail [EMAIL] first' });
  const onlyReasoning = { ...reply(null), message: { role: 'assistant' as const, parts: [{ type: 'reasoning' as const, text: 'a@b.co' }] } };
  const block = fakeGuard('b', (t, s) => (s === 'output' && t.includes('a@b.co') ? { action: 'block' } : { action: 'allow' }));
  await assert.rejects(guardedModel(fakeModel(() => onlyReasoning).model, { guards: [block] }).chat({ model: 'x', messages: [textMessage('user', 'hi')] }, ctx()), /blocked by guard b at output/);
  const streaming = { name: 's', chat: async () => reply('unused'), async *stream(): AsyncGenerator<ModelDelta> {
    yield { type: 'reasoning', text: 'a@b' }; yield { type: 'reasoning', text: '.co' }; yield { type: 'text', text: 'ok' }; yield { type: 'end', finish: 'end' };
  } };
  const out: ModelDelta[] = [];
  for await (const d of guardedModel(streaming, { guards: [redact] }).stream!({ model: 'x', messages: [textMessage('user', 'hi')] }, ctx())) out.push(d);
  assert.ok(!JSON.stringify(out).includes('a@b.co'), 'the buffered stream releases only guarded reasoning');
  assert.deepEqual(assembleDeltas(out).message.parts.find((p) => p.type === 'reasoning'), { type: 'reasoning', text: '[EMAIL]' });
});
