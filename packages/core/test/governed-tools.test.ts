import assert from 'node:assert/strict';
import { test } from 'node:test';
import { governedTools, type AccessRequest, type ApprovalPort, type CallContext } from '../src/index.ts';
import { ctx, fakeGuard, fakeTools, recorder } from './helpers.ts';

const user = { subject: 'alice', kind: 'user' as const, roles: ['analyst'], scopes: ['read'], token: 'eyJ.super-secret-token' };

test('aggregates sources with prefixed names and routes calls to the right one', async () => {
  const log: { name: string; args: unknown; ctx: CallContext }[] = [];
  const tools = governedTools({ http: fakeTools([{ name: 'get', risk: 'read' }], log), fs: fakeTools([{ name: 'write', risk: 'write' }], log) });
  assert.deepEqual((await tools.listTools(ctx())).map((t) => t.name), ['http__get', 'fs__write']);
  const out = await tools.callTool('fs__write', { path: 'a' }, ctx());
  assert.equal(out.content, 'write done with {"path":"a"}');
  assert.equal(log[0]!.name, 'write');
  assert.equal((await tools.callTool('nope__x', {}, ctx())).isError, true);
});

test('local policy denies; ask without approval denies; missing risk counts as exec', async () => {
  const tools = governedTools({ t: fakeTools([{ name: 'read', risk: 'read' }, { name: 'shell' }, { name: 'pay', risk: 'write' }]) }, {
    policy: [{ effect: 'allow', risk: ['read'] }, { effect: 'ask', tools: ['t__pay'] }, { effect: 'deny', risk: ['exec'] }],
  });
  assert.equal((await tools.callTool('t__read', {}, ctx())).isError, undefined);
  assert.deepEqual(await tools.callTool('t__shell', {}, ctx()), { content: 'Denied: denied by policy', isError: true });
  assert.deepEqual(await tools.callTool('t__pay', {}, ctx()), { content: 'Denied: approval required', isError: true });
});

test('ask goes through the approval port', async () => {
  let status: 'approved' | 'pending' = 'approved';
  const approval: ApprovalPort = {
    request: async (req) => ({ id: 'a1', status: 'pending', request: req }),
    get: async () => undefined,
    decide: async () => { throw new Error('unused'); },
    wait: async (id) => ({ id, status, request: { access: {} as AccessRequest, agent: 'x', runId: 'r' } }),
  };
  const tools = governedTools({ t: fakeTools([{ name: 'pay', risk: 'write' }]) }, { policy: [{ effect: 'ask' }], approval, approvalTimeoutMs: 10 });
  assert.equal((await tools.callTool('t__pay', {}, ctx())).isError, undefined);
  status = 'pending';
  assert.deepEqual(await tools.callTool('t__pay', {}, ctx()), { content: 'Denied: approval pending: a1', isError: true });
});

test('authorization gets an access request built from identity and spec; errors fail closed', async () => {
  const seen: AccessRequest[] = [];
  const tools = governedTools({ db: fakeTools([{ name: 'query', risk: 'read' }]) }, {
    authorization: { evaluate: async (r) => { seen.push(r); return r.subject.properties?.roles?.includes('analyst') ? { decision: true } : { decision: false, context: { reason: 'not an analyst' } }; } },
  });
  assert.equal((await tools.callTool('db__query', { q: 1 }, ctx({ identity: user }))).isError, undefined);
  assert.deepEqual(seen[0], {
    subject: { type: 'user', id: 'alice', properties: { roles: ['analyst'], scopes: ['read'], authenticated: true } },
    action: { name: 'call' },
    resource: { type: 'tool', id: 'db__query', properties: { risk: 'read', agent: 'tester', layer: 'tool' } },
    context: { args: { q: 1 } },
  });
  assert.deepEqual(await tools.callTool('db__query', {}, ctx()), { content: 'Denied: not an analyst', isError: true });
  const down = governedTools({ db: fakeTools([{ name: 'query' }]) }, { authorization: { evaluate: async () => { throw new Error('pdp down'); } } });
  assert.match((await down.callTool('db__query', {}, ctx())).content, /Denied: authorization unavailable: pdp down/);
});

test('tool_args and tool_result guards block and redact', async () => {
  const log: { name: string; args: unknown; ctx: CallContext }[] = [];
  const guard = fakeGuard('g', (text, stage) => {
    if (stage === 'tool_args' && text.includes('rm -rf')) return { action: 'block' };
    if (stage === 'tool_args') return { action: 'redact', text: text.replace('4111111111111111', '[CARD]') };
    if (stage === 'tool_result') return { action: 'redact', text: text.replace(/\[CARD\]/g, '****') };
    return { action: 'allow' };
  });
  const tools = governedTools({ t: fakeTools([{ name: 'run', risk: 'read' }], log) }, { guards: [guard] });
  assert.deepEqual(await tools.callTool('t__run', { cmd: 'rm -rf /' }, ctx()), { content: 'Blocked by guardrail g', isError: true });
  assert.equal(log.length, 0, 'blocked calls never reach the tool');
  const out = await tools.callTool('t__run', { card: '4111111111111111' }, ctx());
  assert.deepEqual(log[0]!.args, { card: '[CARD]' });
  assert.equal(out.content, 'run done with {"card":"****"}');
});

test('credentials are bound to the caller and tokens never reach telemetry', async () => {
  const { records, telemetry } = recorder();
  const issued: unknown[] = [];
  const tool = {
    listTools: async () => [{ name: 'call', description: 'calls an API', inputSchema: { type: 'object' }, risk: 'read' as const, audience: 'api' }],
    callTool: async (_n: string, _a: Record<string, unknown>, c: CallContext) => ({ content: `got ${(await c.credentials!.token('api')).length} chars` }),
  };
  const tools = governedTools({ api: tool }, {
    telemetry, policy: [{ effect: 'allow' }],
    credentials: { token: async (aud, o) => { issued.push({ aud, subject: o?.identity?.subject, subjectToken: o?.identity?.token }); return 'downstream-token-xyz'; } },
  });
  const out = await tools.callTool('api__call', {}, ctx({ identity: user }));
  assert.equal(out.content, 'got 20 chars');
  assert.deepEqual(issued, [{ aud: 'api', subject: 'alice', subjectToken: user.token }]);
  const dump = JSON.stringify(records);
  assert.ok(!dump.includes(user.token) && !dump.includes('downstream-token-xyz'), 'no token in telemetry');
  assert.deepEqual(records.filter((r) => r.type === 'span').map((r) => `${r.name}@${r.layer}`), ['authorize@identity', 'execute_tool@tool']);
});

test('a throwing tool becomes an error result', async () => {
  const tools = governedTools({ t: { listTools: async () => [{ name: 'x', description: 'x', inputSchema: {}, risk: 'read' as const }], callTool: async () => { throw new Error('kaboom'); } } });
  assert.deepEqual(await tools.callTool('t__x', {}, ctx()), { content: 'Tool failed: kaboom', isError: true });
});
