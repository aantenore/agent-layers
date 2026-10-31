import assert from 'node:assert/strict';
import { test } from 'node:test';
import { governedTools, type AccessQuestion, type ApprovalPort, type CallContext } from '../src/index.ts';
import { ctx, fakeGuard, fakeTools, recorder } from './helpers.ts';

const user = { id: 'alice', kind: 'user' as const, roles: ['analyst'], scopes: ['read'], credential: 'eyJ.super-secret-token' };
const outcome = (kind: string) => ({ 'sdk.outcome': kind });

test('aggregates sources with prefixed names and routes calls to the right one', async () => {
  const log: { name: string; args: unknown; ctx: CallContext }[] = [];
  const tools = governedTools({ http: fakeTools([{ name: 'get', risk: 'read' }], log), fs: fakeTools([{ name: 'write', risk: 'write' }], log) });
  assert.deepEqual((await tools.listTools(ctx())).map((t) => t.name), ['http__get', 'fs__write']);
  const out = await tools.callTool('fs__write', { path: 'a' }, ctx());
  assert.equal(out.text, 'write done with {"path":"a"}');
  assert.deepEqual(out.ext, outcome('ok'));
  assert.equal(log[0]!.name, 'write');
  assert.deepEqual(await tools.callTool('nope__x', {}, ctx()), { ok: false, text: 'Unknown tool "nope__x"', ext: outcome('error') });
});

test('local policy denies; ask without approval denies; missing risk counts as exec', async () => {
  const tools = governedTools({ t: fakeTools([{ name: 'read', risk: 'read' }, { name: 'shell' }, { name: 'pay', risk: 'write' }]) }, {
    policy: [{ effect: 'allow', risk: ['read'] }, { effect: 'ask', tools: ['t__pay'] }, { effect: 'deny', risk: ['exec'] }],
  });
  assert.equal((await tools.callTool('t__read', {}, ctx())).ok, true);
  assert.deepEqual(await tools.callTool('t__shell', {}, ctx()), { ok: false, text: 'Denied: denied by policy', ext: outcome('denied') });
  assert.deepEqual(await tools.callTool('t__pay', {}, ctx()), { ok: false, text: 'Denied: approval required', ext: outcome('denied') });
});

test('ask goes through the approval port', async () => {
  let status: 'approved' | 'pending' = 'approved';
  const approval: ApprovalPort = {
    request: async (req) => ({ id: 'a1', status: 'pending', request: req }),
    get: async () => undefined,
    decide: async () => { throw new Error('unused'); },
    wait: async (id) => ({ id, status, request: { question: {} as AccessQuestion, agent: 'x', runId: 'r' } }),
  };
  const tools = governedTools({ t: fakeTools([{ name: 'pay', risk: 'write' }]) }, { policy: [{ effect: 'ask' }], approval, approvalTimeoutMs: 10 });
  assert.equal((await tools.callTool('t__pay', {}, ctx())).ok, true);
  status = 'pending';
  assert.deepEqual(await tools.callTool('t__pay', {}, ctx()), { ok: false, text: 'Waiting for approval a1', ext: { 'sdk.outcome': 'pending', 'sdk.approval': 'a1' } });
});

test('authorization gets an access question built from the caller and the spec; errors fail closed', async () => {
  const seen: AccessQuestion[] = [];
  const tools = governedTools({ db: fakeTools([{ name: 'query', risk: 'read' }]) }, {
    authorization: { evaluate: async (q) => { seen.push(q); return (q.caller.roles as string[]).includes('analyst') ? { allowed: true } : { allowed: false, reason: 'not an analyst' }; } },
  });
  assert.equal((await tools.callTool('db__query', { q: 1 }, ctx({ caller: user }))).ok, true);
  assert.deepEqual(seen[0], {
    caller: { id: 'alice', kind: 'user', roles: ['analyst'], scopes: ['read'] },
    action: 'call',
    target: { kind: 'tool', id: 'db__query', layer: 'tool', risk: 'read', agent: 'tester' },
    args: { q: 1 },
  });
  assert.ok(!JSON.stringify(seen).includes(user.credential), 'the credential never reaches the policy');
  assert.deepEqual(await tools.callTool('db__query', {}, ctx()), { ok: false, text: 'Denied: not an analyst', ext: outcome('denied') });
  assert.deepEqual(seen[1]!.caller, { kind: 'anonymous', id: 'anonymous', roles: [], scopes: [] });
  const down = governedTools({ db: fakeTools([{ name: 'query' }]) }, { authorization: { evaluate: async () => { throw new Error('pdp down'); } } });
  assert.match((await down.callTool('db__query', {}, ctx())).text, /Denied: authorization unavailable: pdp down/);
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
  assert.deepEqual(await tools.callTool('t__run', { cmd: 'rm -rf /' }, ctx()), { ok: false, text: 'Blocked by guardrail g', ext: outcome('blocked') });
  assert.equal(log.length, 0, 'blocked calls never reach the tool');
  const out = await tools.callTool('t__run', { card: '4111111111111111' }, ctx());
  assert.deepEqual(log[0]!.args, { card: '[CARD]' });
  assert.equal(out.text, 'run done with {"card":"****"}');
  assert.deepEqual(out.ext, outcome('redacted'));
});

test('credentials are bound to the caller and tokens never reach telemetry', async () => {
  const { records, telemetry } = recorder();
  const issued: unknown[] = [];
  const tool = {
    listTools: async () => [{ name: 'call', description: 'calls an API', params: { type: 'object' }, risk: 'read' as const, audience: 'api' }],
    callTool: async (_n: string, _a: Record<string, unknown>, c: CallContext) => ({ ok: true, text: `got ${(await c.credentials!.token('api')).length} chars` }),
  };
  const tools = governedTools({ api: tool }, {
    telemetry, policy: [{ effect: 'allow' }],
    credentials: { token: async (aud, o) => { issued.push({ aud, caller: o?.caller?.id, credential: o?.caller?.credential }); return 'downstream-token-xyz'; } },
  });
  const out = await tools.callTool('api__call', {}, ctx({ caller: user }));
  assert.equal(out.text, 'got 20 chars');
  assert.deepEqual(issued, [{ aud: 'api', caller: 'alice', credential: user.credential }]);
  const dump = JSON.stringify(records);
  assert.ok(!dump.includes(user.credential) && !dump.includes('downstream-token-xyz'), 'no token in telemetry');
  assert.deepEqual(records.filter((r) => r.type === 'span').map((r) => `${r.name}@${r.layer}`), ['agent.access.check@identity', 'agent.tool.call@tool']);
});

test('a throwing tool becomes an error result', async () => {
  const tools = governedTools({ t: { listTools: async () => [{ name: 'x', description: 'x', params: {}, risk: 'read' as const }], callTool: async () => { throw new Error('kaboom'); } } });
  assert.deepEqual(await tools.callTool('t__x', {}, ctx()), { ok: false, text: 'Tool failed: kaboom', ext: outcome('error') });
});
