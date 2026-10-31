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
  params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  run: ({ text }) => `echo: ${text}`,
});

test('listTools gives specs with the optional fields only when set', async () => {
  const port = functionTools([echo, defineTool({ name: 'plain', description: 'd', params: { type: 'object' }, run: () => '' })]);
  assert.deepEqual(await port.listTools(ctx()), [
    { name: 'echo', description: 'Echo the text', params: echo.params, risk: 'read', layer: 'knowledge', audience: 'https://api.example.test' },
    { name: 'plain', description: 'd', params: { type: 'object' } },
  ]);
});

test('results: string, a { ok, text } result, other values', async () => {
  const defs = [
    { name: 'str', value: 'hi' },
    { name: 'obj', value: { ok: true, text: 'done', data: { n: 1 } } },
    { name: 'failed', value: { ok: false, text: 'nope' } },
    { name: 'num', value: 42 },
    { name: 'list', value: [1, 2] },
    { name: 'none', value: undefined },
    { name: 'nul', value: null },
    { name: 'noText', value: { ok: true, text: 5 } },
  ].map(({ name, value }) => defineTool({ name, description: name, params: { type: 'object' }, run: async () => value }));
  const port = functionTools(defs);
  const call = (n: string) => port.callTool(n, {}, ctx());
  assert.deepEqual(await call('str'), { ok: true, text: 'hi' });
  assert.deepEqual(await call('obj'), { ok: true, text: 'done', data: { n: 1 } });
  assert.deepEqual(await call('num'), { ok: true, text: '42', data: 42 });
  assert.deepEqual(await call('list'), { ok: true, text: '[1,2]', data: [1, 2] });
  assert.deepEqual(await call('none'), { ok: true, text: '' });
  assert.deepEqual(await call('nul'), { ok: true, text: 'null', data: null });
  assert.deepEqual(await call('failed'), { ok: false, text: 'nope' });
  assert.deepEqual(await call('noText'), { ok: true, text: '{"ok":true,"text":5}', data: { ok: true, text: 5 } });
});

test('unknown tool and invalid arguments are error outcomes, and run is not called', async () => {
  let ran = 0;
  const port = functionTools([defineTool({ ...echo, run: () => { ran++; return 'x'; } })]);
  assert.deepEqual(await port.callTool('missing', {}, ctx()), { ok: false, text: 'Unknown tool: missing' });
  const bad = await port.callTool('echo', { text: 5, extra: true }, ctx());
  assert.equal(bad.ok, false);
  assert.match(bad.text, /^Invalid arguments: /);
  assert.match(bad.text, /args\.text: expected string, got integer/);
  assert.match(bad.text, /args\.extra: unknown property/);
  assert.equal((await port.callTool('echo', {}, ctx())).text, 'Invalid arguments: args.text: required');
  assert.equal(ran, 0);
});

test('a throwing tool becomes an error outcome', async () => {
  const port = functionTools([
    defineTool({ name: 'boom', description: 'd', params: { type: 'object' }, run: () => { throw new Error('disk full'); } }),
    defineTool({ name: 'weird', description: 'd', params: { type: 'object' }, run: () => Promise.reject('plain string') }),
  ]);
  assert.deepEqual(await port.callTool('boom', {}, ctx()), { ok: false, text: 'Error: disk full' });
  assert.deepEqual(await port.callTool('weird', {}, ctx()), { ok: false, text: 'Error: plain string' });
});

test('abort errors are rethrown', async () => {
  const ac = new AbortController();
  const port = functionTools([
    defineTool({
      name: 'slow', description: 'd', params: { type: 'object' },
      run: (_a, c) => new Promise((_, reject) => c.signal!.addEventListener('abort', () => reject(c.signal!.reason))),
    }),
  ]);
  const pending = port.callTool('slow', {}, ctx({ signal: ac.signal }));
  ac.abort();
  await assert.rejects(pending);
  await assert.rejects(port.callTool('slow', {}, ctx({ signal: AbortSignal.abort() })));
  const named = functionTools([defineTool({ name: 'n', description: 'd', params: { type: 'object' }, run: () => { throw new DOMException('stop', 'AbortError'); } })]);
  await assert.rejects(named.callTool('n', {}, ctx()), { name: 'AbortError' });
});

test('the call context is passed through', async () => {
  const port = functionTools([
    defineTool({
      name: 'whoami', description: 'd', params: { type: 'object' },
      run: async (args, c) => ({ args, runId: c.runId, agent: c.agent, caller: c.caller?.id, token: await c.credentials?.token('aud') }),
    }),
  ]);
  const out = await port.callTool('whoami', { k: 1 }, ctx({
    caller: { id: 'u-1', kind: 'user', roles: [], scopes: [] },
    credentials: { token: async (aud) => `token-for-${aud}` },
  }));
  assert.deepEqual(out.data, { args: { k: 1 }, runId: 'run-1', agent: 'agent-1', caller: 'u-1', token: 'token-for-aud' });
});

test('bad definitions are rejected', () => {
  const ok = { description: 'd', params: { type: 'object' }, run: () => '' };
  assert.throws(() => functionTools([{ ...ok, name: 'a' }, { ...ok, name: 'a' }]), /duplicate tool "a"/);
  assert.throws(() => functionTools([{ ...ok, name: 'bad name' }]), /invalid tool name/);
  assert.throws(() => functionTools([{ name: 'x' } as never]), /every definition needs/);
});
