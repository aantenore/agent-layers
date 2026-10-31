import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpKnowledge, parseMcpResult } from '../src/index.ts';
import { startMcpMock } from './mock.ts';

const res = (content: string) => ({ content, isError: false });

test('parse: JSON array of passages, wrapped lists and plain strings', () => {
  const array = parseMcpResult(res(JSON.stringify([{ id: 'a', text: 'one', score: 0.9, metadata: { k: 1 }, extra: 'dropped' }, 'two', { nothing: true }])), 'src');
  assert.deepEqual(array[0], { id: 'a', text: 'one', source: 'src', score: 0.9, metadata: { k: 1 } });
  assert.equal(array[1]!.text, 'two');
  assert.equal(array.length, 2);
  assert.deepEqual(parseMcpResult(res(JSON.stringify({ results: [{ content: 'x', id: 7 }] })), 's'), [{ id: '7', text: 'x', source: 's' }]);
});

test('parse: mcp-server-qdrant entries, as plain text and as a JSON array of strings', () => {
  const entry = '<entry><content>The gate closes.</content><metadata>{"id":"tide","file":"t.md"}</metadata></entry>';
  const plain = parseMcpResult(res(`Results for the query 'x'\n${entry}`), 'docs');
  assert.deepEqual(plain, [{ id: 'tide', text: 'The gate closes.', source: 'docs', metadata: { id: 'tide', file: 't.md' } }]);
  assert.deepEqual(parseMcpResult(res(JSON.stringify([`Results`, entry])), 'docs'), plain);
  const noMeta = parseMcpResult(res('<entry><content>bare</content><metadata>null</metadata></entry>'), 'd');
  assert.equal(noMeta[0]!.text, 'bare');
  assert.match(noMeta[0]!.id, /^[0-9a-f]{12}$/);
});

test('parse: empty, "no information found" and free text', () => {
  assert.deepEqual(parseMcpResult(res('  '), 's'), []);
  assert.deepEqual(parseMcpResult(res('No information found for the query'), 's'), []);
  assert.equal(parseMcpResult(res('just some text'), 's')[0]!.text, 'just some text');
});

test('search: query goes to the tool, k limits, filter applies to metadata, no match is empty', async () => {
  const mock = await startMcpMock();
  const source = createMcpKnowledge({ url: mock.url, tool: 'search' }, { name: 'docs' });
  try {
    const all = await source.search({ query: 'the vault tide quay', k: 5 });
    assert.deepEqual(all.map((p) => p.id), ['tide', 'vault', 'quay']);
    assert.ok(all.every((p) => p.source === 'docs'));
    assert.equal((await source.search({ query: 'the vault tide quay', k: 1 })).length, 1);
    assert.deepEqual((await source.search({ query: 'the vault tide quay', filter: { file: 'vault.md' } })).map((p) => p.id), ['vault']);
    assert.deepEqual(await source.search({ query: 'zzz' }), []);
  } finally {
    await source.close?.();
    await mock.close();
  }
});

test('search: a failing tool rejects, custom argument names and parser are used', async () => {
  const mock = await startMcpMock();
  try {
    const failing = createMcpKnowledge({ url: mock.url, tool: 'fail' });
    await assert.rejects(failing.search({ query: 'x' }), /MCP tool fail failed: it broke/);
    await failing.close?.();

    const custom = createMcpKnowledge({ url: mock.url, tool: 'echo', queryArg: 'text', toolArgs: { extra: 1 }, parse: (r) => [{ id: 'e', text: r.content }] });
    assert.deepEqual(await custom.search({ query: 'ping' }), [{ id: 'e', text: 'echo: ping' }]);
    await custom.close?.();
    const sent = mock.requests.filter((r) => r.rpc === 'tools/call').at(-1)!;
    assert.deepEqual(sent.params, { name: 'echo', arguments: { extra: 1, text: 'ping' } });
  } finally {
    await mock.close();
  }
});

test('search: errors that echo static header secrets are masked, also across the truncation cut', async () => {
  const mock = await startMcpMock({ echoErrors: 'long' });
  const source = createMcpKnowledge({ url: mock.url, tool: 'search', headers: { 'x-api-key': 'key-from-env-123' } });
  try {
    await assert.rejects(source.search({ query: 'x' }), (err: Error) => /MCP HTTP 500/.test(err.message) && !/key/.test(`${err.message}\n${err.stack}`));
  } finally {
    await source.close?.();
    await mock.close();
  }
});
