import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineTool, functionTools } from '../src/index.ts';
import { ctx } from './helpers.ts';

const echo = defineTool({
  name: 'echo',
  description: 'Echo the text',
  risk: 'read',
  layer: 'knowledge',
  audience: 'https://api.example.test',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  run: ({ text }) => `echo: ${text}`,
});

test('listTools gives specs with the optional fields only when set', async () => {
  const port = functionTools([echo, defineTool({ name: 'plain', description: 'd', inputSchema: { type: 'object' }, run: () => '' })]);
  assert.deepEqual(await port.listTools(ctx()), [
    { name: 'echo', description: 'Echo the text', inputSchema: echo.inputSchema, risk: 'read', layer: 'knowledge', audience: 'https://api.example.test' },
    { name: 'plain', description: 'd', inputSchema: { type: 'object' } },
  ]);
});

test('results: string, object with content, other values', async () => {
  const defs = [
    { name: 'str', value: 'hi' },
    { name: 'obj', value: { content: 'done', data: { n: 1 } } },
    { name: 'num', value: 42 },
    { name: 'list', value: [1, 2] },
    { name: 'none', value: undefined },
    { name: 'nul', value: null },
    { name: 'noContent', value: { content: 5 } },
  ].map(({ name, value }) => defineTool({ name, description: name, inputSchema: { type: 'object' }, run: async () => value }));
  const port = functionTools(defs);
  const call = (n: string) => port.callTool(n, {}, ctx());
  assert.deepEqual(await call('str'), { content: 'hi' });
  assert.deepEqual(await call('obj'), { content: 'done', data: { n: 1 } });
  assert.deepEqual(await call('num'), { content: '42', data: 42 });
  assert.deepEqual(await call('list'), { content: '[1,2]', data: [1, 2] });
  assert.deepEqual(await call('none'), { content: '' });
  assert.deepEqual(await call('nul'), { content: 'null', data: null });
  assert.deepEqual(await call('noContent'), { content: '{"content":5}', data: { content: 5 } });
});

test('unknown tool and invalid arguments are error outcomes, and run is not called', async () => {
  let ran = 0;
  const port = functionTools([defineTool({ ...echo, run: () => { ran++; return 'x'; } })]);
  assert.deepEqual(await port.callTool('missing', {}, ctx()), { isError: true, content: 'Unknown tool: missing' });
  const bad = await port.callTool('echo', { text: 5, extra: true }, ctx());
  assert.equal(bad.isError, true);
  assert.match(bad.content, /^Invalid arguments: /);
  assert.match(bad.content, /args\.text: expected string, got integer/);
  assert.match(bad.content, /args\.extra: unknown property/);
  assert.equal((await port.callTool('echo', {}, ctx())).content, 'Invalid arguments: args.text: required');
  assert.equal(ran, 0);
});

test('a throwing tool becomes an error outcome', async () => {
  const port = functionTools([
    defineTool({ name: 'boom', description: 'd', inputSchema: { type: 'object' }, run: () => { throw new Error('disk full'); } }),
    defineTool({ name: 'weird', description: 'd', inputSchema: { type: 'object' }, run: () => Promise.reject('plain string') }),
  ]);
  assert.deepEqual(await port.callTool('boom', {}, ctx()), { isError: true, content: 'Error: disk full' });
  assert.deepEqual(await port.callTool('weird', {}, ctx()), { isError: true, content: 'Error: plain string' });
});

test('abort errors are rethrown', async () => {
  const ac = new AbortController();
  const port = functionTools([
    defineTool({
      name: 'slow', description: 'd', inputSchema: { type: 'object' },
      run: (_a, c) => new Promise((_, reject) => c.signal!.addEventListener('abort', () => reject(c.signal!.reason))),
    }),
  ]);
  const pending = port.callTool('slow', {}, ctx({ signal: ac.signal }));
  ac.abort();
  await assert.rejects(pending);
  await assert.rejects(port.callTool('slow', {}, ctx({ signal: AbortSignal.abort() })));
  const named = functionTools([defineTool({ name: 'n', description: 'd', inputSchema: { type: 'object' }, run: () => { throw new DOMException('stop', 'AbortError'); } })]);
  await assert.rejects(named.callTool('n', {}, ctx()), { name: 'AbortError' });
});

test('the call context is passed through', async () => {
  const port = functionTools([
    defineTool({
      name: 'whoami', description: 'd', inputSchema: { type: 'object' },
      run: async (args, c) => ({ args, runId: c.runId, agent: c.agent, subject: c.identity?.subject, token: await c.credentials?.token('aud') }),
    }),
  ]);
  const out = await port.callTool('whoami', { k: 1 }, ctx({
    identity: { subject: 'u-1', type: 'user', claims: {} } as never,
    credentials: { token: async (aud) => `token-for-${aud}` },
  }));
  assert.deepEqual(out.data, { args: { k: 1 }, runId: 'run-1', agent: 'agent-1', subject: 'u-1', token: 'token-for-aud' });
});

test('bad definitions are rejected', () => {
  const ok = { description: 'd', inputSchema: { type: 'object' }, run: () => '' };
  assert.throws(() => functionTools([{ ...ok, name: 'a' }, { ...ok, name: 'a' }]), /duplicate tool "a"/);
  assert.throws(() => functionTools([{ ...ok, name: 'bad name' }]), /invalid tool name/);
  assert.throws(() => functionTools([{ name: 'x' } as never]), /every definition needs/);
});
