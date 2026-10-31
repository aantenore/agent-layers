import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { Vocabularies } from '@agent-layers/core';
import { createHttpGuard, parseVerdict, type HttpGuardOptions } from '../src/index.ts';
import { shim, type Shim } from './shim.ts';

let service: Shim;
before(async () => { service = await shim(); });
beforeEach(() => service.reset());
after(() => service.close());

const input = { stage: 'input' as const, text: 'hello', agent: 'support', runId: 'run-1' };
const guard = (o: Partial<HttpGuardOptions> = {}) => createHttpGuard({ url: service.url, ...o });

test('posts exactly the GuardCheck and returns the verdict', async () => {
  const v = await guard().check({ ...input, stage: 'tool_args', tool: 'crm__get', text: 'forbidden' });
  assert.deepEqual(v, { action: 'block', reason: 'forbidden word' });
  assert.deepEqual(service.requests[0]!.body, { stage: 'tool_args', text: 'forbidden', agent: 'support', runId: 'run-1', tool: 'crm__get' });
});

test('a caller is sent without a credential even if one slips in', async () => {
  const caller = { id: 'u1', kind: 'user' as const, roles: ['admin'], scopes: [], credential: 'raw-credential' };
  await guard().check({ ...input, caller });
  assert.deepEqual(service.requests[0]!.body.caller, { id: 'u1', kind: 'user', roles: ['admin'], scopes: [] });
  assert.ok(!JSON.stringify(service.requests[0]!.body).includes('raw-credential'));
});

test('labels: known values kept, unknown ones become other with the native value under ext; bad lists fail closed', async () => {
  service.answer(200, { action: 'block', labels: ['pii', 'pii', 'credit-card', 'x'.repeat(100)], reason: 'card', ext: { 'other.key': 1 } });
  assert.deepEqual(await guard().check(input), { action: 'block', labels: ['pii', 'other'], reason: 'card', ext: { 'http-guard.labels': ['credit-card'] } });
  const vocab = new Vocabularies([{ guardLabel: { add: { 'pii.card': { like: 'pii' } } } }]);
  assert.deepEqual(parseVerdict({ action: 'block', labels: ['pii.card'] }, vocab), { action: 'block', labels: ['pii.card'] });
  for (const labels of ['pii', [1], Array.from({ length: 65 }, () => 'pii')]) {
    service.answer(200, { action: 'block', labels });
    assert.deepEqual(await guard().check(input), { action: 'block', reason: 'guard service unavailable: invalid response' }, JSON.stringify(labels).slice(0, 30));
  }
});

test('maxResponseBytes bounds the answer; a larger one blocks with a fixed reason', async () => {
  service.answer(200, { action: 'allow', pad: 'x'.repeat(4096) });
  assert.deepEqual(await guard({ maxResponseBytes: 1024 }).check(input), { action: 'block', reason: 'guard service unavailable: response too large' });
  assert.deepEqual(await guard().check(input), { action: 'allow' });
});

test('redact verdicts carry their text', async () => {
  assert.deepEqual(await guard().check({ ...input, text: 'x secret-123 y' }), { action: 'redact', text: 'x [SECRET] y', reason: 'secret' });
});

test('token becomes a bearer header; custom headers are sent', async () => {
  await guard({ token: 't0k', headers: { 'x-team': 'a' } }).check(input);
  assert.equal(service.requests[0]!.headers.authorization, 'Bearer t0k');
  assert.equal(service.requests[0]!.headers['x-team'], 'a');
});

test('unknown fields of the verdict are dropped', async () => {
  service.answer(200, { action: 'allow', score: 0.1, extra: true });
  assert.deepEqual(await guard().check(input), { action: 'allow' });
});

test('fails closed on bad verdicts, errors and unreachable services', async () => {
  for (const [status, body] of [[200, { action: 'maybe' }], [200, { action: 'redact' }], [200, 'nope'], [500, { error: 'boom' }]] as const) {
    service.answer(status, body);
    const v = await guard().check(input);
    assert.equal(v.action, 'block', JSON.stringify(body));
    assert.match(v.reason!, /^guard service unavailable/);
  }
  assert.equal((await createHttpGuard({ url: 'http://127.0.0.1:1', timeoutMs: 500 }).check(input)).action, 'block');
});

test('failure reasons do not echo the response body', async () => {
  service.answer(422, { detail: 'bad input: hello' });
  const v = await guard().check(input);
  assert.ok(!v.reason!.includes('hello'));
});

test('onError allow fails open', async () => {
  service.answer(503, {});
  assert.deepEqual(await guard({ onError: 'allow' }).check(input), { action: 'allow' });
});

test('cancellation is rethrown', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(guard().check(input, { signal: ac.signal }));
});

test('parseVerdict validates', () => {
  assert.deepEqual(parseVerdict({ action: 'block', reason: 'r' }), { action: 'block', reason: 'r' });
  assert.throws(() => parseVerdict(null));
  assert.throws(() => parseVerdict({ action: 'redact' }));
});

test('stages are exposed when configured', () => {
  assert.deepEqual(guard({ stages: ['output'] }).stages, ['output']);
  assert.equal(guard().stages, undefined);
});

test('failure reasons come from a fixed set and never from error text', async () => {
  const reasonOf = async (fetch: (u: string, i: RequestInit) => Promise<Response>) => (await createHttpGuard({ url: 'http://x', timeoutMs: 20 }, { fetch }).check(input)).reason;
  assert.equal(await reasonOf(async () => { throw new Error('connect ECONNREFUSED https://admin:hunter2@internal.example/analyze authorization: Bearer abc123 text: jane.doe@example.com'); }), 'guard service unavailable: network error');
  assert.equal(await reasonOf(async () => new Response('<html>hello</html>')), 'guard service unavailable: invalid response');
  assert.equal(await reasonOf(async () => new Response(JSON.stringify({ action: 'maybe', reason: 'hello' }))), 'guard service unavailable: invalid response');
  assert.equal(await reasonOf(async () => new Response('echo hello', { status: 429 })), 'guard service unavailable: HTTP 429');
  assert.equal(await reasonOf((_u, init) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))), 'guard service unavailable: timeout');
});

test('URLs with credentials are rejected at creation', () => {
  assert.throws(() => createHttpGuard({ url: 'https://user:pw@guard.example/check' }), /must not carry credentials/);
  assert.throws(() => createHttpGuard({ url: 'guard.example/check' }), /not a valid http\(s\) URL/);
});
