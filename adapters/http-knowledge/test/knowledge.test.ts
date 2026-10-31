import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpKnowledge } from '../src/index.ts';
import { startKnowledgeService } from './mock.ts';

test('sends {query, k, filter} and returns passages with the contract fields only', async () => {
  const svc = await startKnowledgeService();
  try {
    const source = createHttpKnowledge({ url: svc.url }, { name: 'docs' });
    assert.equal(source.name, 'docs');
    const found = await source.search({ query: 'tide gate vault quay', k: 2 });
    assert.deepEqual(svc.requests[0]!.body, { query: 'tide gate vault quay', k: 2 });
    assert.deepEqual(found.map((p) => p.id), ['tide', 'vault']);
    assert.deepEqual(found[0], { id: 'tide', text: 'The Zorblax tide gate closes at 14:20.', source: 'tide.md', score: 0.9, metadata: { file: 'tide.md' } });
    const filtered = await source.search({ query: 'tide gate vault quay', filter: { file: 'quay.md' } });
    assert.deepEqual(svc.requests[1]!.body, { query: 'tide gate vault quay', k: 4, filter: { file: 'quay.md' } });
    assert.deepEqual(filtered.map((p) => p.id), ['quay']);
    assert.deepEqual(await source.search({ query: 'zzz' }), []);
  } finally {
    await svc.close();
  }
});

test('tolerates sloppy items: derives ids, drops empty text, fills the source, and never exceeds k', async () => {
  const svc = await startKnowledgeService(() => ({
    json: { passages: [{ text: 'no id' }, { id: 5, text: 'numeric id', extra: 'dropped' }, { id: 'x', text: '  ' }, 'plain string', { id: 'z', text: 'last' }] },
  }));
  try {
    const found = await createHttpKnowledge({ url: svc.url }, { name: 'svc' }).search({ query: 'q', k: 2 });
    assert.equal(found.length, 2);
    assert.match(found[0]!.id, /^[0-9a-f]{12}$/);
    assert.deepEqual(found[1], { id: '5', text: 'numeric id', source: 'svc' });
  } finally {
    await svc.close();
  }
});

test('headers resolve ${env:X}; the identity token is forwarded only when asked to', async () => {
  const svc = await startKnowledgeService();
  try {
    const plain = createHttpKnowledge({ url: svc.url, headers: { 'x-api-key': '${env:KB_KEY}' } }, { env: { KB_KEY: 'k-9' } });
    await plain.search({ query: 'tide', identity: { subject: 'u', kind: 'user', token: 'user-token' } });
    assert.equal(svc.requests[0]!.headers['x-api-key'], 'k-9');
    assert.equal(svc.requests[0]!.headers.authorization, undefined);
    const forwarding = createHttpKnowledge({ url: svc.url, forwardIdentityToken: true });
    await forwarding.search({ query: 'tide', identity: { subject: 'u', kind: 'user', token: 'user-token' } });
    assert.equal(svc.requests[1]!.headers.authorization, 'Bearer user-token');
    await forwarding.search({ query: 'tide' });
    assert.equal(svc.requests[2]!.headers.authorization, undefined);
  } finally {
    await svc.close();
  }
});

test('errors reject: HTTP status, a body without passages, an unreachable service, cancellation', async () => {
  const bad = await startKnowledgeService((body) => (body.query === 'status' ? { status: 503, text: 'overloaded' } : body.query === 'shape' ? { json: { results: [] } } : { text: 'not json' }));
  try {
    const source = createHttpKnowledge({ url: bad.url });
    await assert.rejects(source.search({ query: 'status' }), /knowledge HTTP 503: overloaded/);
    await assert.rejects(source.search({ query: 'shape' }), /no "passages" array/);
    await assert.rejects(source.search({ query: 'text' }), /no "passages" array/);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(source.search({ query: 'x', signal: ac.signal }), (err: Error) => err.name === 'AbortError');
  } finally {
    await bad.close();
  }
  await assert.rejects(createHttpKnowledge({ url: 'http://127.0.0.1:9/search', timeoutMs: 2000 }).search({ query: 'x' }));
  assert.throws(() => createHttpKnowledge({ url: '/relative' }), /absolute/);
  assert.throws(() => createHttpKnowledge({ url: '${env:NOPE}' }, { env: {} }), /NOPE is not set/);
});

test('an error body that echoes the credentials is masked, also across the truncation cut', async () => {
  const svc = await startKnowledgeService((_body, headers) => ({ status: 500, text: `${'y'.repeat(287)}${headers.authorization} ${headers['x-api-key']}` }));
  try {
    const source = createHttpKnowledge({ url: svc.url, headers: { 'x-api-key': 'key-from-env-123' }, forwardIdentityToken: true });
    await assert.rejects(
      source.search({ query: 'x', identity: { subject: 'u', kind: 'user', token: 'user-token-9' } }),
      (err: Error) => /\[redacted\]/.test(err.message) && !/user-t|key-/.test(err.message),
    );
  } finally {
    await svc.close();
  }
});
