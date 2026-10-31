import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defineAdapter, PORT_VERSIONS, recordingTelemetry, replyToDeltas, validate,
  type AuthorizationPort, type CachePort, type CredentialPort, type EvaluatorPort, type Feedback, type FeedbackPort, type GuardPort,
  type IdentityPort, type KnowledgePort, type ModelPort, type ModelReply, type ToolPort, type TraceCodec,
} from '@agent-layers/core';
import { checkAdapter, checkDescriptor, checkExt, conformance, conforms, roundTrip, sampleQuestion, schema } from '../src/index.ts';
import { rawSchema, schemaNames } from '../src/schemas.ts';

const goodCache = (): CachePort => {
  const m = new Map<string, { v: unknown; until: number }>();
  return {
    get: async (k) => { const e = m.get(k); return e && e.until > Date.now() ? structuredClone(e.v) : undefined; },
    set: async (k, v, o) => { m.set(k, { v: structuredClone(v), until: o?.ttlMs ? Date.now() + o.ttlMs : Infinity }); },
    delete: async (k) => { m.delete(k); },
  };
};

const reply = (parts: ModelReply['message']['parts'], finish = 'end'): ModelReply => ({ model: 'test', message: { role: 'assistant', parts }, finish });

/** A scripted model: text for plain requests, a get_time call when a tool is required. */
const goodModel = (over: Partial<ModelPort> = {}): ModelPort => {
  const chat: ModelPort['chat'] = async (req, ctx) => {
    if (ctx.signal?.aborted) throw new Error('aborted');
    return req.toolMode === 'required' && req.tools?.length
      ? reply([{ type: 'call', id: 'c1', tool: req.tools[0]!.name, args: {} }], 'tools')
      : reply([{ type: 'text', text: 'OK' }]);
  };
  return {
    chat,
    stream: async function* (req, ctx) { yield* replyToDeltas(await chat(req, ctx)); },
    ...over,
  };
};

test('a correct implementation passes', async () => {
  assert.deepEqual((await conformance('CachePort', goodCache())).failures, []);
  assert.deepEqual((await conformance('ModelPort', goodModel(), { toolCall: true })).failures, []);
});

test('broken implementations are caught with readable failures', async () => {
  const leaky: CachePort = { get: async () => 'always', set: async () => {} };
  const r = await conformance('CachePort', leaky);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('missing key must resolve to undefined')));

  const throwing: ToolPort = { listTools: async () => [{ name: 'bad name!', description: 'x', params: {} }], callTool: async () => { throw new Error('nope'); } };
  const t = await conformance('ToolPort', throwing);
  assert.ok(t.failures.some((f) => f.includes('tool[0]')));
  assert.ok(t.failures.some((f) => f.includes('callTool unknown: threw nope')));

  const bad: KnowledgePort = { search: async () => [{ id: 1, body: 'x' } as never, { id: '2', text: 'y', source: 's' }, { id: '3', text: 'z', source: 's' }] };
  const k = await conformance('KnowledgePort', bad);
  assert.ok(k.failures.some((f) => f.startsWith('passage[0]')));
  assert.ok(k.failures.some((f) => f.includes('must respect k')));

  const sloppy: GuardPort = { check: async () => ({ action: 'redact' }) };
  const g = await conformance('GuardPort', sloppy, { block: [{ stage: 'input', text: 'x' }] });
  assert.ok(g.failures.some((f) => f.includes('verdict')));
  assert.ok(g.failures.some((f) => f.includes('block: input sample got redact')));
});

test('model: reply shape, the end delta and the tool call are checked', async () => {
  const noEnd = goodModel({ stream: async function* () { yield { type: 'text', text: 'OK' }; } });
  assert.ok((await conformance('ModelPort', noEnd)).failures.some((f) => f.includes('exactly one end delta')));

  const twoEnds = goodModel({ stream: async function* () { yield { type: 'end', finish: 'end' }; yield { type: 'end', finish: 'end' }; } });
  assert.ok((await conformance('ModelPort', twoEnds)).failures.some((f) => f.includes('found 2')));

  const empty = goodModel({ chat: async () => reply([{ type: 'reasoning', text: 'hmm' }]) });
  assert.ok((await conformance('ModelPort', empty)).failures.some((f) => f.includes('neither text nor call parts')));

  const invalidArgs = goodModel({ chat: async () => reply([{ type: 'call', id: 'c1', tool: 'get_time', args: {}, invalid: '{oops' }], 'tools') });
  const bad = await conformance('ModelPort', invalidArgs, { toolCall: true, abort: false });
  assert.ok(bad.failures.some((f) => f.includes('invalid is set')));

  const wrongTool = goodModel({ chat: async () => reply([{ type: 'call', id: 'c1', tool: 'other', args: {} }], 'tools') });
  assert.ok((await conformance('ModelPort', wrongTool, { toolCall: true, abort: false })).failures.some((f) => f.includes('called "other"')));

  const noStream = goodModel({ stream: undefined });
  assert.deepEqual((await conformance('ModelPort', noStream)).skipped, ['stream: not implemented (optional)']);
});

test('tools: an unknown tool must return ok false and fixtures check text and ok', async () => {
  const tools = (over: Partial<ToolPort> = {}): ToolPort => ({
    listTools: async () => [{ name: 'echo', description: 'Echo', params: { type: 'object' } }],
    callTool: async (name, args) => (name === 'echo' ? { ok: true, text: String(args.text) } : { ok: false, text: `unknown tool ${name}` }),
    ...over,
  });
  const calls = [{ name: 'echo', args: { text: 'hi' }, expect: 'hi', ok: true }];
  assert.deepEqual((await conformance('ToolPort', tools(), { calls })).failures, []);
  const bad = await conformance('ToolPort', tools(), { calls: [{ name: 'echo', args: { text: 'hi' }, expect: 'bye', ok: false }] });
  assert.ok(bad.failures.some((f) => f.includes('text lacks "bye"')));
  assert.ok(bad.failures.some((f) => f.includes('ok should be false')));
  const lenient = await conformance('ToolPort', tools({ callTool: async () => ({ ok: true, text: 'fine' }) }));
  assert.ok(lenient.failures.some((f) => f.includes('must return ok: false')));
});

test('runtime: a stopped run needs a reason with a code', async () => {
  const runtime = (result: object) => ({ bind: () => ({ name: 'a', run: async () => result }) }) as never;
  const f = { stack: {}, agent: { name: 'a' } };
  assert.deepEqual((await conformance('RuntimePort', runtime({ runId: 'r', status: 'completed', output: 'ok' }), f)).failures, []);
  const r = await conformance('RuntimePort', runtime({ runId: 'r', status: 'stopped', output: '' }), f);
  assert.ok(r.failures.some((x) => x.includes('needs a reason with a code')));
  const ok = await conformance('RuntimePort', runtime({ runId: 'r', status: 'stopped', output: '', reason: { code: 'denied', layer: 'identity' } }), f);
  assert.deepEqual(ok.failures, []);
});

test('authorization: an anonymous caller must be denied', async () => {
  const rule = (allowAnonymous: boolean): AuthorizationPort => ({
    evaluate: async (q) => ({ allowed: q.caller.kind === 'anonymous' ? allowAnonymous : q.target.risk === 'read' }),
  });
  const fixtures = { allow: [sampleQuestion()], deny: [sampleQuestion({ risk: 'exec' })] };
  assert.deepEqual((await conformance('AuthorizationPort', rule(false), fixtures)).failures, []);
  const open = await conformance('AuthorizationPort', rule(true), fixtures);
  assert.ok(open.failures.some((f) => f.includes('anonymous')));
  const wrong = await conformance('AuthorizationPort', rule(false), { allow: [sampleQuestion({ risk: 'exec' })] });
  assert.ok(wrong.failures.some((f) => f.includes('allow #0')));
  assert.deepEqual(conforms('access-question', sampleQuestion()), []);
});

test('checkAdapter checks the descriptor and closes the instance', async () => {
  let closed = false;
  const d = defineAdapter({
    layer: 'cache', port: 'CachePort', name: 'test-cache', direction: 'outbound', maps: { technology: 'map' },
    portVersion: PORT_VERSIONS.CachePort, tiers: ['prototype'], create: () => ({ ...goodCache(), close: async () => { closed = true; } }),
  });
  const r = await checkAdapter(d);
  assert.deepEqual(r.failures, ['optionsSchema is missing']);
  assert.ok(closed);
  assert.deepEqual(checkDescriptor({ ...d, optionsSchema: {} }), []);
  assert.ok(checkDescriptor({ ...d, optionsSchema: {}, ext: { produces: ['other.key'] } }).some((p) => p.includes('must be in the namespace "test-cache"')));
  assert.ok(checkDescriptor({ ...d, optionsSchema: {}, mappingDefaults: { in: { shape: 'Nope' as never } } }).some((p) => p.includes('unknown shape')));
});

test('an on-behalf-of credential adapter needs a caller and never falls back to its own identity', async () => {
  const obo = (fallback: boolean): CredentialPort => ({
    requiresCaller: true,
    token: async (_aud, o) => { if (!o?.caller?.credential && !fallback) throw new Error('no caller'); return 'exchanged'; },
  });
  const skipped = await conformance('CredentialPort', obo(false));
  assert.deepEqual(skipped.failures, []);
  assert.ok(skipped.skipped.some((s) => s.includes('needs a caller token')));
  const caller = { id: 'alice', kind: 'user' as const, roles: [], scopes: [], credential: 'caller-token' };
  const probed = await conformance('CredentialPort', obo(false), { caller, audience: 'tools-api' });
  assert.deepEqual([probed.failures, probed.skipped], [[], []]);
  const leaky = await conformance('CredentialPort', obo(true), { caller });
  assert.ok(leaky.failures.some((f) => f.includes('token without a caller: expected a rejection')));
});

test('identity: the caller validates without its credential and carries the expected id', async () => {
  const idp = (over: object = {}): IdentityPort => ({
    verify: async (c) => { if (c !== 'good') throw new Error('invalid'); return { id: 'alice', kind: 'user', roles: [], scopes: [], credential: c, ...over }; },
  });
  assert.deepEqual((await conformance('IdentityPort', idp(), { valid: 'good', expectId: 'alice' })).failures, []);
  assert.ok((await conformance('IdentityPort', idp(), { valid: 'good', expectId: 'bob' })).failures.some((f) => f.includes('expected "bob"')));
  assert.ok((await conformance('IdentityPort', idp({ roles: undefined }), { valid: 'good' })).failures.some((f) => f.startsWith('caller')));
});

// --- schema bundling -------------------------------------------------------------------------------------------

/** Every `$ref` in a schema. */
const refsOf = (node: unknown, out: string[] = []): string[] => {
  if (Array.isArray(node)) node.forEach((n) => refsOf(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else refsOf(v, out);
    }
  }
  return out;
};

const resolves = (root: object, ref: string) => {
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) node = (node as Record<string, unknown> | undefined)?.[part];
  return node !== undefined;
};

test('bundling: every spec schema loads with local references only and its examples validate', () => {
  const names = schemaNames();
  assert.ok(names.length >= 20, `found ${names.length} schemas`);
  for (const name of names) {
    const s = schema(name);
    for (const ref of refsOf(s)) {
      assert.ok(ref.startsWith('#/'), `${name}: external reference ${ref} left in the bundle`);
      assert.ok(resolves(s, ref), `${name}: reference ${ref} does not resolve`);
    }
    const examples = rawSchema(name).examples;
    if (!['common', 'service-spec', 'stack-config'].includes(name)) assert.ok(Array.isArray(examples) && examples.length > 0, `${name}: no examples`);
    for (const [i, ex] of ((examples as unknown[] | undefined) ?? []).entries()) assert.deepEqual(conforms(name, ex), [], `${name} example ${i}`);
  }
});

test('bundling: whole-file and cross-file references are followed', () => {
  const run = schema('run-result');
  const defs = run.$defs as Record<string, object>;
  assert.ok('run-event' in defs, 'whole-file reference inlined');
  assert.ok('common.Ext' in defs, 'definition of another file inlined');
  // a reference inside an inlined definition is rewritten too
  assert.ok(refsOf(defs['run-event']).every((r) => r.startsWith('#/$defs/')));
  const base = { runId: 'r', status: 'completed', output: '' };
  assert.deepEqual(conforms('run-result', { ...base, events: [{ type: 'run.start', runId: 'r', agent: 'a' }] }), []);
  assert.ok(conforms('run-result', { ...base, events: [{ type: 'run.start' }] }).length > 0);
  assert.ok(conforms('run-result', { ...base, ext: { 'no-namespace': 1 } }).length > 0);
  assert.ok(conforms('run-result', { ...base, status: 'stopped' }).length > 0);
  assert.deepEqual(conforms('run-result', { ...base, status: 'stopped', reason: { code: 'denied' } }), []);
  assert.deepEqual(conforms('approval', { id: 'a', status: 'pending', request: { question: sampleQuestion(), agent: 'x', runId: 'r' } }), []);
  assert.ok(conforms('approval', { id: 'a', status: 'pending', request: { question: { action: 'call' }, agent: 'x', runId: 'r' } }).length > 0);
  assert.ok(validate(schema('caller'), { id: 'a', kind: 'user', roles: [], scopes: [], credential: 'secret' }).length > 0, 'a credential is never part of a caller');
});

// --- ext -------------------------------------------------------------------------------------------------------

test('checkExt: undeclared, foreign, sdk and un-namespaced keys fail; declared keys pass', () => {
  const d = { name: 'qdrant', ext: { produces: ['qdrant.collection'] } };
  const passage = (ext: object) => ({ id: '1', text: 't', source: 's', ext });
  assert.deepEqual(checkExt(d, passage({ 'qdrant.collection': 'docs' })), []);
  assert.deepEqual(checkExt(d, [passage({})]), []);
  assert.ok(checkExt(d, passage({ 'qdrant.shard': 3 })).some((p) => p.includes('not declared')));
  assert.ok(checkExt(d, passage({ 'pgvector.table': 'x' })).some((p) => p.includes('another namespace')));
  assert.ok(checkExt(d, passage({ 'sdk.rank': 1 })).some((p) => p.includes('"sdk"')));
  assert.ok(checkExt(d, passage({ collection: 'x' })).some((p) => p.includes('not namespaced')));
  // found anywhere inside a value
  assert.ok(checkExt(d, { message: { parts: [{ type: 'text', text: 'x', ext: { 'qdrant.shard': 1 } }] } }).length > 0);
  // no declaration at all: every key is undeclared
  assert.ok(checkExt({ name: 'qdrant' }, passage({ 'qdrant.collection': 'docs' })).length > 0);
  // an explicit namespace replaces the adapter name
  assert.deepEqual(checkExt({ name: 'qdrant-knowledge', ext: { namespace: 'qdrant', produces: ['qdrant.collection'] } }, passage({ 'qdrant.collection': 'x' })), []);
});

test('suites record what the adapter returned and check its ext keys', async () => {
  const tools = (ext: Record<string, unknown>): ToolPort => ({
    listTools: async () => [{ name: 'echo', description: 'Echo', params: {}, ext }],
    callTool: async () => ({ ok: false, text: 'unknown' }),
  });
  // plain conformance: namespacing and the sdk namespace only
  assert.deepEqual((await conformance('ToolPort', tools({ 'acme.flag': true }))).failures, []);
  const plain = (await conformance('ToolPort', tools({ flag: true, 'sdk.rank': 1 }))).failures;
  assert.ok(plain.some((f) => f.includes('"flag" is not namespaced')));
  assert.ok(plain.some((f) => f.includes('"sdk.rank"')));

  const descriptor = (ext?: object) => defineAdapter({
    layer: 'tool', port: 'ToolPort', name: 'acme', direction: 'outbound', maps: { technology: 'acme' }, portVersion: PORT_VERSIONS.ToolPort,
    tiers: ['prototype'], optionsSchema: {}, ...(ext ? { ext } : {}), create: () => tools({ 'acme.flag': true }),
  });
  assert.deepEqual((await checkAdapter(descriptor({ produces: ['acme.flag'] }))).failures, []);
  const undeclared = await checkAdapter(descriptor());
  assert.ok(undeclared.failures.some((f) => f.includes('listTools') && f.includes('"acme.flag" is not declared in ext.produces')));
  const foreign = defineAdapter({ ...descriptor({ produces: ['acme.flag'] }), create: () => tools({ 'other.flag': true }) });
  assert.ok((await checkAdapter(foreign)).failures.some((f) => f.includes('another namespace than "acme"')));
});

// --- round trip ------------------------------------------------------------------------------------------------

test('roundTrip: a lossless translation passes, a lossy one reports where', () => {
  type Wire = { who: string; scope: string; extra?: string };
  type Lang = { id: string; kind: 'user'; roles: string[]; scopes: string[] };
  const toLanguage = (w: Wire): Lang => ({ id: w.who, kind: 'user', roles: [], scopes: w.scope ? w.scope.split(' ') : [] });
  const toStandard = (l: Lang): Wire => ({ who: l.id, scope: l.scopes.join(' ') });
  assert.deepEqual(roundTrip<Wire, Lang>([{ who: 'a', scope: 'x y' }, { who: 'b', scope: '' }], toLanguage, toStandard, { shape: 'Caller' }), []);

  const lossy = roundTrip<Wire, Lang>([{ who: 'a', scope: 'x', extra: 'kept?' }], toLanguage, toStandard);
  assert.equal(lossy.length, 1);
  assert.match(lossy[0]!, /sample\[0\].*changed \$\.extra/);
  // key order does not matter
  assert.deepEqual(roundTrip<Wire, Lang>([{ scope: 'x', who: 'a' }], toLanguage, toStandard), []);
  // a custom equality can accept what the default rejects
  assert.deepEqual(roundTrip<Wire, Lang>([{ who: 'a', scope: 'x', extra: 'ignored' }], toLanguage, toStandard, { equal: (a, b) => a.who === b.who && a.scope === b.scope }), []);
  // an invalid language shape is reported, and so is a throwing translation
  const badShape = roundTrip<Wire, Lang>([{ who: 'a', scope: '' }], (w) => ({ ...toLanguage(w), kind: 'robot' as never }), toStandard, { shape: 'Caller' });
  assert.ok(badShape.some((p) => p.includes('Caller') && p.includes('callerKind')));
  assert.ok(roundTrip<Wire, Lang>([{ who: 'a', scope: '' }], () => { throw new Error('boom'); }, toStandard)[0]!.includes('toLanguage threw boom'));
});

// --- telemetry -------------------------------------------------------------------------------------------------

test('telemetry: a recorder without current() passes and skips the context checks', async () => {
  const records: unknown[] = [];
  const port = recordingTelemetry((r) => records.push(r), 'plain');
  assert.equal(port.current, undefined);
  const r = await conformance('TelemetryPort', port);
  assert.deepEqual(r.failures, []);
  assert.ok(records.length > 0);
});

test('telemetry: with current(), the remote parent is opaque and the trace can be proven', async () => {
  const codec: TraceCodec = {
    parse: (t) => { const [traceId, spanId] = t.parent.split(':'); return traceId && spanId ? { traceId, spanId } : undefined; },
    format: (ids) => ({ parent: `${ids.traceId}:${ids.spanId}` }),
  };
  const traced = () => recordingTelemetry(() => {}, 'traced', { trace: codec });
  assert.deepEqual((await conformance('TelemetryPort', traced())).failures, []);

  const trace = { parent: { parent: 'aaaa:bbbb' }, sameTrace: (p: { parent: string }, inside: { parent: string }) => p.parent.split(':')[0] === inside.parent.split(':')[0] };
  assert.deepEqual((await conformance('TelemetryPort', traced(), { trace })).failures, []);

  // an adapter that starts a new trace instead of continuing the parent's fails the proof
  const fresh = recordingTelemetry(() => {}, 'fresh', { trace: { ...codec, parse: () => undefined } });
  assert.ok((await conformance('TelemetryPort', fresh, { trace })).failures.some((f) => f.includes("the trace must be the parent's")));

  // a context that is not an object with a string parent, and a context that leaks outside a span
  const broken = { ...traced(), current: () => ({ parent: 1 }) as never };
  assert.ok((await conformance('TelemetryPort', broken)).failures.some((f) => f.includes('string parent')));
  const leaking = { ...traced(), current: () => ({ parent: 'x' }) };
  assert.ok((await conformance('TelemetryPort', leaking)).failures.some((f) => f.includes('outside any span')));
});

test('state, memory, trigger, feedback and evaluator suites run on the new shapes', async () => {
  const log = new Map<string, unknown[]>();
  const state = {
    append: async (id: string, e: unknown[]) => { log.set(id, [...(log.get(id) ?? []), ...e]); },
    read: async (id: string) => log.get(id) ?? [],
    list: async () => [...log.keys()],
    delete: async (id: string) => { log.delete(id); },
  };
  assert.deepEqual((await conformance('StatePort', state as never)).failures, []);

  const items = new Map<string, { id: string; text: string }[]>();
  const memory = {
    remember: async (its: { text: string }[], scope: { caller?: string }) => {
      const ids = its.map((_, i) => `m${i}`);
      items.set(scope.caller ?? '', its.map((it, i) => ({ id: ids[i]!, text: it.text })));
      return ids;
    },
    recall: async (q: { scope: { caller?: string } }) => (items.get(q.scope.caller ?? '') ?? []).map((i) => ({ ...i, source: 'memory' })),
    forget: async (_ids: string[], scope: { caller?: string }) => { items.delete(scope.caller ?? ''); },
  };
  assert.deepEqual((await conformance('MemoryPort', memory as never)).failures, []);

  const feedback: FeedbackPort = (() => {
    const all: Feedback[] = [];
    return { submit: async (f) => { all.push(f); return `f${all.length}`; }, list: async (q) => all.filter((x) => !q?.runId || x.runId === q.runId) };
  })();
  assert.deepEqual((await conformance('FeedbackPort', feedback)).failures, []);

  const evaluator: EvaluatorPort = { score: async (c, run) => [{ metric: 'exact', value: run.output?.includes(String(c.expected)) ? 1 : 0 }] };
  const cases = [{ case: { id: 'c', input: 'q', expected: '4' }, run: { runId: 'r', output: '4', status: 'completed' as const }, expect: { metric: 'exact', value: 1 } }];
  assert.deepEqual((await conformance('EvaluatorPort', evaluator, { cases })).failures, []);
  const outOfRange: EvaluatorPort = { score: async () => [{ metric: 'exact', value: 3 }] };
  assert.ok((await conformance('EvaluatorPort', outOfRange)).failures.some((f) => f.includes('score #0')));

  const trigger = (event: object) => ({
    start: async (handler: (t: unknown) => Promise<void>) => { setTimeout(() => void handler(event), 5); return { close: async () => {} }; },
  });
  const good = await conformance('TriggerPort', trigger({ id: 't1', kind: 'schedule', source: '/cron', at: '2026-10-31T09:30:00Z' }) as never, { fire: async () => {} });
  assert.deepEqual(good.failures, []);
  const wrong = await conformance('TriggerPort', trigger({ id: 't1', type: 'schedule' }) as never, { fire: async () => {} });
  assert.ok(wrong.failures.some((f) => f.startsWith('trigger[0]')));
});
