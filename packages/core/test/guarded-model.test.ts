import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleChunks, GuardrailBlocked, guardedModel, runGuards, type CachePort, type ChatChunk, type GuardPort } from '../src/index.ts';
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
  await m.chat({ model: 'base', messages: [{ role: 'user', content: 'hi' }] }, ctx());
  assert.deepEqual(log, ['g:input', 'cache:miss', 'router', 'model', 'cache:set', 'g:output']);
  log.length = 0;
  await m.chat({ model: 'base', messages: [{ role: 'user', content: 'hi' }] }, ctx());
  assert.deepEqual(log, ['g:input', 'cache:hit', 'g:output'], 'a cache hit skips router and model but still runs output guards');
});

test('router choice reaches the model', async () => {
  const { model, requests } = fakeModel();
  await guardedModel(model, { router: { select: () => 'small' } }).chat({ model: 'big', messages: [{ role: 'user', content: 'x' }] }, ctx());
  assert.equal(requests[0]!.model, 'small');
});

test('input block throws GuardrailBlocked and never calls the model', async () => {
  const { model, requests } = fakeModel();
  const m = guardedModel(model, { guards: [fakeGuard('pii', (t) => (t.includes('secret') ? { action: 'block', reason: 'nope' } : { action: 'allow' }))] });
  await assert.rejects(m.chat({ model: 'x', messages: [{ role: 'user', content: 'my secret' }] }, ctx()), (e: unknown) =>
    e instanceof GuardrailBlocked && e.message === 'guardrail:pii:input' && e.stage === 'input' && e.reason === 'nope');
  assert.equal(requests.length, 0);
});

test('redact rewrites only new user content, and the output', async () => {
  const { model, requests } = fakeModel(() => reply('call 555-0100'));
  const redact = fakeGuard('r', (t) => ({ action: 'redact', text: t.replace(/\d{3}-\d{4}/g, '[PHONE]').replace('bob@x.io', '[EMAIL]') }));
  const res = await guardedModel(model, { guards: [redact] }).chat({
    model: 'x',
    messages: [
      { role: 'user', content: 'old bob@x.io' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: 'new bob@x.io' }, { type: 'image_url', image_url: { url: 'u' } }] },
    ],
  }, ctx());
  assert.equal(requests[0]!.messages[0]!.content, 'old bob@x.io', 'history is not re-guarded');
  assert.deepEqual(requests[0]!.messages[2]!.content, [{ type: 'text', text: 'new [EMAIL]' }, { type: 'image_url', image_url: { url: 'u' } }]);
  assert.equal(res.choices[0]!.message.content, 'call [PHONE]');
});

test('output block throws with stage output; a throwing guard fails closed', async () => {
  const { model } = fakeModel(() => reply('bad words'));
  await assert.rejects(guardedModel(model, { guards: [fakeGuard('o', (t, s) => (s === 'output' ? { action: 'block' } : { action: 'allow' }))] })
    .chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }, ctx()), /guardrail:o:output/);
  const broken = { name: 'broken', check: async () => { throw new Error('down'); } };
  await assert.rejects(guardedModel(model, { guards: [broken] }).chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }, ctx()), /guardrail:broken:input/);
});

test('guards with stages run only there', async () => {
  const log: string[] = [];
  const { model } = fakeModel();
  await guardedModel(model, { guards: [fakeGuard('in-only', () => ({ action: 'allow' }), log, ['input'])] }).chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }, ctx());
  assert.deepEqual(log, ['in-only:input']);
});

test('stream passes through without output guards and buffers with them', async () => {
  const chunks: ChatChunk[] = [
    { model: 'f', choices: [{ index: 0, delta: { role: 'assistant', content: 'mail ' } }] },
    { model: 'f', choices: [{ index: 0, delta: { content: 'a@b.co' }, finish_reason: 'stop' }] },
  ];
  const streaming = { name: 's', chat: async () => reply('unused'), async *stream() { yield* chunks; } };
  const plain: ChatChunk[] = [];
  for await (const c of guardedModel(streaming).stream!({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }, ctx())) plain.push(c);
  assert.deepEqual(plain, chunks);
  const guarded: ChatChunk[] = [];
  const redact = fakeGuard('r', (t) => ({ action: 'redact', text: t.replace('a@b.co', '[EMAIL]') }));
  for await (const c of guardedModel(streaming, { guards: [redact] }).stream!({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }, ctx())) guarded.push(c);
  assert.equal(assembleChunks(guarded).choices[0]!.message.content, 'mail [EMAIL]');
});

test('every step is a span tagged with its layer; usage becomes metrics', async () => {
  const { records, telemetry } = recorder();
  const { model } = fakeModel();
  await guardedModel(model, {
    telemetry, guards: [fakeGuard('g', () => ({ action: 'allow' }))], router: { select: () => 'm' },
    cache: { get: async () => undefined, set: async () => {} },
  }).chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }, ctx());
  const spans = records.filter((r) => r.type === 'span').map((r) => `${r.name}@${r.layer}`);
  assert.deepEqual(spans, ['guard.check@guardrail', 'cache.lookup@cache', 'router.select@cache', 'chat@llm', 'guard.check@guardrail']);
  assert.ok(records.some((r) => r.type === 'metric' && r.name === 'gen_ai.client.token.usage' && r.value === 3));
});

test('a guard that throws blocks with the fixed reason "guard error", never the thrown message', async () => {
  const { model, requests } = fakeModel();
  const { records, telemetry } = recorder();
  const boom: GuardPort = { name: 'flaky', async check() { throw new Error('backend said: token sk-live-123 rejected for "my secret"'); } };
  const m = guardedModel(model, { guards: [boom], telemetry });
  await assert.rejects(m.chat({ model: 'x', messages: [{ role: 'user', content: 'my secret' }] }, ctx()), (e: unknown) =>
    e instanceof GuardrailBlocked && e.reason === 'guard error' && e.message === 'guardrail:flaky:input');
  assert.equal(requests.length, 0);
  assert.ok(!JSON.stringify(records).includes('sk-live-123'), 'the thrown message never reaches telemetry');
  const out = await runGuards([boom], 'tool_args', '{}', ctx(), telemetry, 'util__x');
  assert.deepEqual(out, { action: 'block', text: '{}', guard: 'flaky', reason: 'guard error' });
});
