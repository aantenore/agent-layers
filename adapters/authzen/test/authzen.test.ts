import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMappings, governedTools, MappingError, type ToolPort } from '@agent-layers/core';
import { checkAdapter, sampleQuestion } from '@agent-layers/conformance';
import { adapter, createAuthzen, LIMITS } from '../src/index.ts';
import { pdp, question, referencePolicy, send } from './helpers.ts';

const authzenPdp = () => pdp((body, _h, res) => {
  const d = referencePolicy(body);
  send(res, 200, { decision: d.allow, context: { reason_admin: { en: 'internal: rule 7' }, reason_user: { en: d.reason } } });
});

const alice = { id: 'alice', kind: 'user', roles: ['analyst'], scopes: ['notes'] };
const anonWire = { type: 'anonymous', id: 'anonymous', properties: { roles: [], scopes: [], authenticated: false } };

test('posts the question in AuthZEN names to the evaluation endpoint, without arguments unless asked', async () => {
  const s = await authzenPdp();
  try {
    const d = await createAuthzen({ url: `${s.url}/pdp/`, headers: { 'x-api-key': 'k', 'content-type': 'text/plain' } }).evaluate(question(alice, 'write'));
    assert.deepEqual(d, { allowed: true, reason: 'allowed' });
    assert.equal(s.seen[0]!.path, '/pdp/access/v1/evaluation');
    assert.equal(s.seen[0]!.headers['x-api-key'], 'k');
    assert.equal(s.seen[0]!.headers['content-type'], 'application/json');
    assert.deepEqual(s.seen[0]!.body, {
      subject: { type: 'user', id: 'alice', properties: { roles: ['analyst'], scopes: ['notes'], authenticated: true } },
      action: { name: 'call' },
      resource: { type: 'tool', id: 'notes__save', properties: { risk: 'write', layer: 'tool', agent: 'notes' } },
    });
    await createAuthzen({ url: s.url, includeArgs: true }).evaluate(question(alice));
    assert.deepEqual(s.seen[1]!.body.context, { args: { path: '/etc/secret' } });
  } finally {
    await s.close();
  }
});

test('target attributes go to resource properties but never override risk, layer or agent', async () => {
  const s = await authzenPdp();
  try {
    const q = question({ id: 'bob', kind: 'user', roles: ['viewer'], scopes: [] }, 'write');
    q.target.attrs = { title: 'Save', risk: 'read', layer: 'knowledge', agent: 'other' };
    assert.equal((await createAuthzen({ url: s.url }).evaluate(q)).allowed, false);
    assert.deepEqual(s.seen[0]!.body.resource.properties, { title: 'Save', risk: 'write', layer: 'tool', agent: 'notes' });
  } finally {
    await s.close();
  }
});

test('the reason comes from reason or reason_user; other context keys go to ext; reason_admin stays with the PDP', async () => {
  const s = await authzenPdp();
  try {
    const bob = { id: 'bob', kind: 'user', roles: ['viewer'], scopes: [] };
    assert.deepEqual(await createAuthzen({ url: s.url }).evaluate(question(bob, 'write')), { allowed: false, reason: 'user bob may not call write tools' });
    s.state.reply = (_b, _h, res) => send(res, 200, { decision: false, context: { reason: 'x'.repeat(500), policy: 'p7', reason_admin: 'secret detail' } });
    const d = await createAuthzen({ url: s.url }).evaluate(question(bob));
    assert.equal(d.reason?.length, 200);
    assert.deepEqual(d.ext, { 'authzen.context': { policy: 'p7' } });
    s.state.reply = (_b, _h, res) => send(res, 200, { decision: false });
    assert.deepEqual(await createAuthzen({ url: s.url }).evaluate(question(bob)), { allowed: false });
  } finally {
    await s.close();
  }
});

test('anonymous and malformed callers reach the PDP as anonymous; a credential never leaves the stack', async () => {
  const s = await authzenPdp();
  try {
    const authz = createAuthzen({ url: s.url });
    for (const caller of [
      { kind: 'anonymous', id: 'anonymous', roles: [], scopes: [] },
      { kind: 'Agent', id: 'notes', roles: [], scopes: [] },
      { kind: 'agent', id: '', roles: [], scopes: [] },
      { kind: 'service', id: 'notes', roles: ['analyst'], scopes: [] },
      undefined,
    ]) {
      assert.equal((await authz.evaluate(question(caller))).allowed, false, JSON.stringify(caller));
      assert.deepEqual(s.seen.at(-1)!.body.subject, anonWire);
    }
    assert.equal((await authz.evaluate(question({ id: 'notes', kind: 'agent', roles: 'admin', scopes: [], credential: 'raw-token' }))).allowed, true, 'authenticated agent reads');
    assert.deepEqual(s.seen.at(-1)!.body.subject, { type: 'agent', id: 'notes', properties: { roles: [], scopes: [], authenticated: true } });
    assert.ok(!s.seen.some((r) => JSON.stringify(r.body).includes('raw-token')));

    // Through the stack: a call without a caller is denied, the agent's own identity is allowed.
    const tools: ToolPort = { listTools: async () => [{ name: 'list', description: 'l', params: {}, risk: 'read' }], callTool: async () => ({ ok: true, text: 'listed' }) };
    const governed = governedTools({ notes: tools }, { authorization: authz });
    const run = (caller?: { id: string; kind: 'agent'; roles: string[]; scopes: string[] }) => governed.callTool('notes__list', {}, { runId: 'r', agent: 'notes', ...(caller ? { caller } : {}) });
    const denied = await run();
    assert.deepEqual([denied.ok, denied.text], [false, 'Denied: anonymous anonymous may not call read tools']);
    const allowed = await run({ id: 'svc', kind: 'agent', roles: [], scopes: [] });
    assert.deepEqual([allowed.ok, allowed.text], [true, 'listed']);
  } finally {
    await s.close();
  }
});

test('out mappings shape the request; they read the public question and a failing mapping denies', async () => {
  const s = await authzenPdp();
  try {
    const mappings = createMappings('authorization', { out: [{ from: '/caller/name', to: '/subject/properties/name' }, { from: '/args', to: '/context/args' }] });
    await createAuthzen({ url: s.url }, { mappings }).evaluate(question({ ...alice, name: 'Alice' }));
    assert.equal(s.seen[0]!.body.subject.properties.name, 'Alice');
    assert.equal(s.seen[0]!.body.context, undefined, 'arguments stay inside the stack without includeArgs');
    const broken = createMappings('authorization', { out: [{ from: '/caller/id', to: '/subject/properties/__proto__/x' }] });
    await assert.rejects(createAuthzen({ url: s.url }, { mappings: broken }).evaluate(question(alice)), MappingError);
    assert.equal(s.seen.length, 1, 'nothing is sent when the mapping fails');
  } finally {
    await s.close();
  }
});

test('fails closed: missing or non-boolean decisions, errors, redirects, large or slow answers reject', async () => {
  const s = await authzenPdp();
  try {
    const authz = createAuthzen({ url: s.url, timeoutMs: 300 });
    const q = sampleQuestion();
    const replies: [Parameters<typeof send>[1], unknown, RegExp][] = [
      [200, { decision: 'true' }, /no boolean "decision"/],
      [200, {}, /no boolean "decision"/],
      [200, [true], /not a JSON object/],
      [200, 'allow', /not JSON/],
      [500, { decision: true }, /HTTP 500/],
      [403, { decision: true }, /HTTP 403/],
      [302, '', /redirect|request failed/],
      [200, { decision: true, pad: 'x'.repeat(LIMITS.maxResponseBytes.default as number) }, /too large/],
    ];
    for (const [status, body, pattern] of replies) {
      s.state.reply = (_b, _h, res) => (status === 302 ? res.writeHead(302, { location: '/elsewhere' }).end() : send(res, status, body));
      await assert.rejects(authz.evaluate(q), pattern, `${status} ${JSON.stringify(body).slice(0, 40)}`);
    }
    s.state.reply = () => new Promise(() => {});
    await assert.rejects(authz.evaluate(q), /timed out after 300ms/);
    const ac = new AbortController();
    const pending = authz.evaluate(q, { signal: ac.signal });
    ac.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(createAuthzen({ url: 'http://127.0.0.1:1' }).evaluate(q), /request failed/);
  } finally {
    await s.close();
  }
});

test('https is required outside loopback; bad paths are refused', () => {
  assert.throws(() => createAuthzen({ url: 'http://pdp.example.com' }), /https/);
  assert.throws(() => createAuthzen({ url: 'https://u:p@pdp.example.com' }), /credentials/);
  assert.throws(() => createAuthzen({ url: 'https://pdp.example.com', path: '../x' }), /path/);
  createAuthzen({ url: 'https://pdp.example.com' });
  createAuthzen({ url: 'http://pdp.internal', allowHttp: true });
});

test('authzen passes AuthorizationPort conformance', async () => {
  const s = await authzenPdp();
  try {
    s.state.reply = (body, _h, res) => {
      const d = referencePolicy(body);
      send(res, 200, { decision: d.allow, context: { reason: d.reason, policy: 'reference' } });
    };
    const report = await checkAdapter(adapter, {
      options: { url: s.url },
      fixtures: {
        allow: [sampleQuestion({ roles: ['viewer'] }), sampleQuestion({ roles: ['analyst'], risk: 'write' }), sampleQuestion({ kind: 'agent' })],
        deny: [sampleQuestion(), sampleQuestion({ roles: ['viewer'], risk: 'write' }), sampleQuestion({ roles: ['analyst'], risk: 'exec' }), sampleQuestion({ kind: 'agent', risk: 'write' })],
      },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await s.close();
  }
});
