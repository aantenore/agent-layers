import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createMappings, Vocabularies, type MappingFn } from '@agent-layers/core';
import { createPresidioGuard, type PresidioOptions } from '../src/index.ts';
import { mockPresidio, redirecting, type MockPresidio } from './mock-presidio.ts';

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

test('redacts through the anonymizer; labels from entity types, native types under ext', async () => {
  const v = await guard().check(input('write to jane@example.com now'));
  assert.deepEqual(v, { action: 'redact', text: 'write to <EMAIL_ADDRESS> now', reason: 'PII redacted: EMAIL_ADDRESS', labels: ['pii'], ext: { 'presidio.entities': ['EMAIL_ADDRESS'] } });
});

test('label mappings are replaceable; unknown labels become other; a failing mapping blocks', async () => {
  const mappings = createMappings('guardrails.pii', { in: [{ from: '/entities', to: '/labels', map: { EMAIL_ADDRESS: 'pii.contact' } }] });
  const custom = guard({ action: 'block' });
  assert.deepEqual((await custom.check(input('a@b.co'))).labels, ['pii']);
  const added = createPresidioGuard({ analyzerUrl: presidio.analyzerUrl, action: 'block' }, { mappings, vocabularies: () => new Vocabularies([{ guardLabel: { add: { 'pii.contact': { like: 'pii' } } } }]) });
  assert.deepEqual((await added.check(input('a@b.co'))).labels, ['pii.contact']);
  const unknown = createPresidioGuard({ analyzerUrl: presidio.analyzerUrl, action: 'block' }, { mappings });
  assert.deepEqual((await unknown.check(input('a@b.co'))).labels, ['other'], 'not in the vocabulary: other');
  const boom: MappingFn = () => { throw new Error('a@b.co'); };
  const failing = createPresidioGuard({ analyzerUrl: presidio.analyzerUrl, action: 'block' }, { mappings: createMappings('guardrails.pii', { in: [{ fn: './m.ts#boom' }] }, { fns: new Map([['./m.ts#boom', boom]]) }) });
  assert.deepEqual(await failing.check(input('a@b.co')), { action: 'block', reason: 'PII detected: EMAIL_ADDRESS', labels: ['other'], ext: { 'presidio.entities': ['EMAIL_ADDRESS'], 'presidio.mappingError': 'label mapping failed' } });
});

test('a failing label mapping never turns a detection into allow, even with onError allow', async () => {
  const boom: MappingFn = () => { throw new Error('a@b.co'); };
  const mappings = createMappings('guardrails.pii', { in: [{ fn: './m.ts#boom' }] }, { fns: new Map([['./m.ts#boom', boom]]) });
  const blocking = createPresidioGuard({ analyzerUrl: presidio.analyzerUrl, action: 'block', onError: 'allow' }, { mappings });
  assert.deepEqual(await blocking.check(input('a@b.co')), { action: 'block', reason: 'PII detected: EMAIL_ADDRESS', labels: ['other'], ext: { 'presidio.entities': ['EMAIL_ADDRESS'], 'presidio.mappingError': 'label mapping failed' } });
  const redacting = createPresidioGuard({ analyzerUrl: presidio.analyzerUrl, anonymizerUrl: presidio.anonymizerUrl, onError: 'allow' }, { mappings });
  assert.deepEqual(await redacting.check(input('write to a@b.co')), { action: 'redact', text: 'write to <EMAIL_ADDRESS>', reason: 'PII redacted: EMAIL_ADDRESS', labels: ['other'], ext: { 'presidio.entities': ['EMAIL_ADDRESS'], 'presidio.mappingError': 'label mapping failed' } });
});

for (const status of [307, 308]) {
  test(`a ${status} redirect is refused: the text never reaches the other host`, async () => {
    const r = await redirecting(status);
    try {
      const v = await createPresidioGuard({ analyzerUrl: r.url, action: 'block', headers: { 'x-api-key': 'k' } }).check(input('jane@example.com'));
      assert.deepEqual(v, { action: 'block', reason: `presidio unavailable: redirects are not followed (HTTP ${status})` });
      assert.deepEqual(await createPresidioGuard({ analyzerUrl: r.url, action: 'block', onError: 'allow' }).check(input('jane@example.com')), { action: 'allow' });
      assert.deepEqual(r.hits, []);
    } finally {
      await r.close();
    }
  });
}

test('entity types that are not identifier-like stay out of reasons and ext', async () => {
  const fetch = async () => Response.json([{ entity_type: 'jane@example.com leaked', start: 0, end: 4, score: 1 }, { entity_type: 'CUSTOM_ID', start: 0, end: 4, score: 1 }]);
  const v = await createPresidioGuard({ analyzerUrl: 'http://x', action: 'block' }, { fetch }).check(input('hello'));
  assert.deepEqual(v, { action: 'block', reason: 'PII detected: CUSTOM_ID', labels: ['other'], ext: { 'presidio.entities': ['CUSTOM_ID'] } });
});

test('block action refuses text with findings and never calls the anonymizer', async () => {
  presidio.calls.length = 0;
  const v = await guard({ action: 'block' }).check(input('jane@example.com'));
  assert.deepEqual(v, { action: 'block', reason: 'PII detected: EMAIL_ADDRESS', labels: ['pii'], ext: { 'presidio.entities': ['EMAIL_ADDRESS'] } });
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

test('a detection is never downgraded: an anonymizer failure after a finding blocks, even with onError allow', async () => {
  for (const anonymizerUrl of ['http://127.0.0.1:1', `${presidio.anonymizerUrl}/missing`]) {
    const v = await createPresidioGuard({ analyzerUrl: presidio.analyzerUrl, anonymizerUrl, onError: 'allow', timeoutMs: 500 }).check(input('mail jane@example.com'));
    assert.equal(v.action, 'block');
    assert.match(v.reason!, /^PII detected: EMAIL_ADDRESS; presidio anonymizer unavailable: /);
    assert.deepEqual(v.labels, ['pii']);
    assert.doesNotMatch(JSON.stringify(v), /jane@example\.com/);
  }
  assert.deepEqual(await guard({ onError: 'allow', anonymizerUrl: 'http://127.0.0.1:1' }).check(input('nothing here')), { action: 'allow' }, 'no finding: the anonymizer is not called');
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

test('failure reasons come from a fixed set and never from error text', async () => {
  const leaky = async () => { throw new Error('connect ECONNREFUSED https://admin:hunter2@internal.example/analyze authorization: Bearer abc123 text: jane.doe@example.com'); };
  const v = await createPresidioGuard({ analyzerUrl: 'http://x', anonymizerUrl: 'http://x' }, { fetch: leaky }).check(input('hello'));
  assert.deepEqual(v, { action: 'block', reason: 'presidio unavailable: network error' });
  const notJson = async () => new Response('<html>jane.doe@example.com</html>', { status: 200 });
  const w = await createPresidioGuard({ analyzerUrl: 'http://x', anonymizerUrl: 'http://x' }, { fetch: notJson }).check(input('hello'));
  assert.deepEqual(w, { action: 'block', reason: 'presidio unavailable: invalid response' });
  const slow = async (_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
  const t = await createPresidioGuard({ analyzerUrl: 'http://x', anonymizerUrl: 'http://x', timeoutMs: 20 }, { fetch: slow }).check(input('hello'));
  assert.deepEqual(t, { action: 'block', reason: 'presidio unavailable: timeout' });
});

test('URLs with credentials are rejected at creation', () => {
  assert.throws(() => createPresidioGuard({ analyzerUrl: 'http://u:p@host', anonymizerUrl: 'http://x' }), /must not carry credentials/);
  assert.throws(() => createPresidioGuard({ analyzerUrl: 'http://x', anonymizerUrl: 'http://u:p@host' }), /must not carry credentials/);
  assert.throws(() => createPresidioGuard({ analyzerUrl: 'not a url', action: 'block' }), /not a valid http\(s\) URL/);
});
