import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createPresidioGuard, type PresidioOptions } from '../src/index.ts';
import { mockPresidio, type MockPresidio } from './mock-presidio.ts';

let presidio: MockPresidio;
before(async () => { presidio = await mockPresidio(); });
after(() => presidio.close());

const input = (text: string) => ({ stage: 'input' as const, text, agent: 'a', runId: 'r' });
const guard = (o: Partial<PresidioOptions> = {}) =>
  createPresidioGuard({ analyzerUrl: `${presidio.analyzerUrl}/`, anonymizerUrl: presidio.anonymizerUrl, ...o });

test('allows text without findings and skips the anonymizer', async () => {
  presidio.calls.length = 0;
  assert.deepEqual(await guard().check(input('The weather is pleasant')), { action: 'allow' });
  assert.deepEqual(presidio.calls.map((c) => c.path), ['/analyze']);
});

test('redacts through the anonymizer and names entity types only', async () => {
  const v = await guard().check(input('write to jane@example.com now'));
  assert.deepEqual(v, { action: 'redact', text: 'write to <EMAIL_ADDRESS> now', reason: 'PII redacted: EMAIL_ADDRESS' });
});

test('block action refuses text with findings and never calls the anonymizer', async () => {
  presidio.calls.length = 0;
  const v = await guard({ action: 'block' }).check(input('jane@example.com'));
  assert.deepEqual(v, { action: 'block', reason: 'PII detected: EMAIL_ADDRESS' });
  assert.ok(!presidio.calls.some((c) => c.path === '/anonymize'));
});

test('sends language, entities, threshold, operators and headers', async () => {
  presidio.calls.length = 0;
  await guard({ language: 'it', entities: ['EMAIL_ADDRESS'], scoreThreshold: 0.4, operators: { DEFAULT: { type: 'replace', new_value: '[PII]' } }, headers: { 'x-api-key': 'k' } })
    .check(input('a@b.co'));
  const [analyze, anonymize] = presidio.calls;
  assert.deepEqual(analyze!.body, { text: 'a@b.co', language: 'it', entities: ['EMAIL_ADDRESS'], score_threshold: 0.4 });
  assert.deepEqual(anonymize!.body.anonymizers, { DEFAULT: { type: 'replace', new_value: '[PII]' } });
  assert.equal(anonymize!.headers['x-api-key'], 'k');
});

test('blank text is allowed without a request', async () => {
  presidio.calls.length = 0;
  assert.equal((await guard().check(input('   '))).action, 'allow');
  assert.equal(presidio.calls.length, 0);
});

test('fails closed on HTTP errors, without echoing the response body', async () => {
  presidio.failWith(500);
  try {
    const v = await guard().check(input('secret text a@b.co'));
    assert.deepEqual(v, { action: 'block', reason: 'presidio unavailable: HTTP 500' });
  } finally { presidio.failWith(undefined); }
});

test('onError allow fails open', async () => {
  presidio.failWith(503);
  try {
    assert.deepEqual(await guard({ onError: 'allow' }).check(input('a@b.co')), { action: 'allow' });
  } finally { presidio.failWith(undefined); }
});

test('an unreachable service blocks', async () => {
  const v = await createPresidioGuard({ analyzerUrl: 'http://127.0.0.1:1', anonymizerUrl: 'http://127.0.0.1:1', timeoutMs: 500 }).check(input('a@b.co'));
  assert.equal(v.action, 'block');
  assert.match(v.reason!, /^presidio unavailable/);
});

test('an unexpected analyzer body blocks', async () => {
  const fetch = async () => new Response(JSON.stringify({ not: 'a list' }), { status: 200 });
  const v = await createPresidioGuard({ analyzerUrl: 'http://x', anonymizerUrl: 'http://x' }, { fetch }).check(input('hello'));
  assert.equal(v.action, 'block');
});

test('cancellation is rethrown, not turned into a verdict', async () => {
  const ac = new AbortController();
  const fetch = async (_u: string, init: RequestInit) => { ac.abort(); init.signal!.throwIfAborted(); return new Response('[]'); };
  await assert.rejects(createPresidioGuard({ analyzerUrl: 'http://x', anonymizerUrl: 'http://x' }, { fetch }).check(input('hello'), { signal: ac.signal }));
});

test('redact needs an anonymizer URL; stages are exposed when configured', () => {
  assert.throws(() => createPresidioGuard({ analyzerUrl: 'http://x' }), /anonymizerUrl/);
  assert.deepEqual(createPresidioGuard({ analyzerUrl: 'http://x', action: 'block', stages: ['input', 'output'] }).stages, ['input', 'output']);
  assert.equal(createPresidioGuard({ analyzerUrl: 'http://x', action: 'block' }).stages, undefined);
});
