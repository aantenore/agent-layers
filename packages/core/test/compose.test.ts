import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, GuardrailBlocked, messageText, MissingLayerError, resolveProfile, type RunEvent, type RuntimePort, type StackConfig } from '../src/index.ts';
import { fakeModel, recorder, reply, testAdapter, textAt } from './helpers.ts';

const echoRuntime: RuntimePort = {
  bind: (stack, agent) => ({
    name: agent.name,
    async run(input, c) {
      const res = await stack.modelFor(agent).chat({ model: agent.model, messages: [{ role: 'user', parts: [{ type: 'text', text: String(input) }] }] }, stack.context({ ...c, agent: agent.name }));
      return { runId: c?.runId ?? 'r', status: 'completed', output: messageText(res.message), events: [{ type: 'test.done' }] };
    },
  }),
};

test('missing optional layers are fine; a missing runtime or model is named', async () => {
  const s = await compose(resolveProfile({ agents: { a: { model: 'm' } } }));
  assert.deepEqual(s.agents(), ['a']);
  assert.deepEqual(await s.tools.listTools(s.context({ agent: 'a' })), []);
  await assert.rejects(s.agent('a'), (e: unknown) => e instanceof MissingLayerError && e.layer === 'harness');
  await assert.rejects(s.model.chat({ model: 'm', messages: [] }, s.context({ agent: 'a' })), /no model adapter configured \(layer llm\)/);
  await s.close();
});

test('errors name the layer and the adapter', async () => {
  await assert.rejects(compose(resolveProfile({ layers: { cache: { adapter: 'ghost-cache' } } }), { registry: new (await import('../src/index.ts')).AdapterRegistry() }),
    /\[cache\/ghost-cache\] not installed/);
});

test('composes ports into pipelines; guard blocks become stopped runs; events go to state', async () => {
  const { records, telemetry } = recorder();
  const { model, requests } = fakeModel((req) => reply(`echo ${messageText(req.messages.at(-1))}`));
  const appended: [string, RunEvent[]][] = [];
  const config: StackConfig = {
    layers: {
      secrets: { adapter: 'vault' },
      model: { adapter: 'fake-model', options: { key: '${secret:MODEL_KEY}' } },
      runtime: { adapter: 'echo' },
      state: { adapter: 'state' },
      knowledge: { wiki: { adapter: 'kb' } },
      guardrails: [{ adapter: 'block-word', stages: ['input'] }],
    },
    agents: { helper: { model: 'm', knowledge: [] }, reader: { model: 'm' } },
  };
  let modelOptions: unknown;
  const s = await compose(resolveProfile(config), {
    telemetry: [telemetry],
    adapters: [
      testAdapter('SecretPort', 'infra', 'vault', () => ({ get: async (ref: string) => (ref === 'MODEL_KEY' ? 'k-123' : undefined) })),
      testAdapter('ModelPort', 'llm', 'fake-model', (o) => { modelOptions = o; return model; }),
      testAdapter('RuntimePort', 'harness', 'echo', () => echoRuntime),
      testAdapter('StatePort', 'harness', 'state', () => ({ append: async (id: string, e: RunEvent[]) => { appended.push([id, e]); }, read: async () => [], list: async () => [], delete: async () => {} })),
      testAdapter('KnowledgePort', 'knowledge', 'kb', () => ({ search: async () => [{ id: '1', text: 'Fact from the wiki.' }] })),
      testAdapter('GuardPort', 'guardrail', 'block-word', () => ({ check: async (i: { text: string }) => (i.text.includes('forbidden') ? { action: 'block' } : { action: 'allow' }) })),
    ],
  });
  assert.deepEqual(modelOptions, { key: 'k-123' }, '${secret:...} resolved through the secrets slot');
  assert.equal(s.ports.guardrails[0]!.name, 'block-word');

  const helper = await s.agent('helper');
  const ok = await helper.run('hello', { sessionId: 'sess-1' });
  assert.equal(ok.output, 'echo hello');
  assert.equal(requests[0]!.messages.length, 1, 'agent with knowledge: [] gets no injection');
  assert.deepEqual(appended, [['sess-1', [{ type: 'test.done' }]]]);

  await (await s.agent('reader')).run('question');
  assert.match(textAt(requests[1]!, 0), /Fact from the wiki/, 'default: all sources injected');

  const stopped = await helper.run('this is forbidden');
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(stopped.reason, new GuardrailBlocked('block-word', 'input').stopReason);
  assert.deepEqual(stopped.reason, { code: 'guard_block', layer: 'guardrail', by: 'block-word', stage: 'input' });
  assert.ok(records.some((r) => r.type === 'span' && r.name === 'agent.run' && r.layer === 'harness' && r.attrs['agent.run.status'] === 'stopped' && r.attrs['agent.run.reason'] === 'guard_block'));
  await s.close();
});

test('a secret reference without a secrets adapter is an error', async () => {
  await assert.rejects(compose(resolveProfile({ layers: { model: { adapter: 'fake-model', options: { key: '${secret:K}' } } } }), {
    adapters: [testAdapter('ModelPort', 'llm', 'fake-model', () => ({}))],
  }), /\[llm\/fake-model\] options reference \$\{secret:\.\.\.\} but no secrets adapter/);
});

test('ctx.stack() gives adapters the composed stack at use time and throws while composing', async () => {
  const { model, requests } = fakeModel(() => reply('judged'));
  let early: unknown;
  let later: (() => import('../src/index.ts').Stack) | undefined;
  const probe = testAdapter('EvaluatorPort', 'eval', 'probe', () => ({ async score() { return []; } }));
  const config: StackConfig = { layers: { model: { adapter: 'fake-model' }, eval: [{ adapter: 'probe' }], guardrails: [{ adapter: 'g' }] } };
  const s = await compose(resolveProfile(config), {
    adapters: [
      testAdapter('ModelPort', 'llm', 'fake-model', () => model),
      testAdapter('GuardPort', 'guardrail', 'g', () => ({ name: 'g', async check(i: { text: string }) { return i.text.includes('pii') ? { action: 'redact', text: '[x]' } : { action: 'allow' }; } })),
      { ...probe, create: (_o: unknown, ctx: { stack?: () => import('../src/index.ts').Stack }) => { later = ctx.stack; try { ctx.stack!(); } catch (err) { early = err; } return { async score() { return []; } }; } } as never,
    ],
  });
  assert.match(String(early), /not composed yet/);
  assert.equal(later!(), s);
  const governed = later!().modelFor({ name: 'probe', instructions: '', model: 'm', tools: [], knowledge: [] });
  await governed.chat({ model: 'm', messages: [{ role: 'user', parts: [{ type: 'text', text: 'has pii' }] }] }, s.context({ agent: 'probe' }));
  assert.equal(textAt(requests[0]!, 0), '[x]', 'the stack model applies the stack guards');
  await s.close();
});

test('start({ caller }): channel and trigger runs carry it unless the call brings its own', async () => {
  const seen: (string | undefined)[] = [];
  const runtime: RuntimePort = { bind: (_s, agent) => ({ name: agent.name, async run(_i, c) { seen.push(c?.caller?.id); return { runId: c?.runId ?? 'r', status: 'completed', output: '' }; } }) };
  let fire: ((t: { id: string; kind: string; source: string }) => Promise<void>) | undefined;
  const s = await compose(resolveProfile({
    agents: { a: { model: 'm' } },
    layers: { runtime: { adapter: 'rt' }, channels: [{ adapter: 'ch' }], triggers: [{ adapter: 'tr' }] },
  }), {
    adapters: [
      testAdapter('RuntimePort', 'harness', 'rt', () => runtime),
      testAdapter('ChannelPort', 'interface', 'ch', () => ({
        async serve(host: import('../src/index.ts').ChannelHost) {
          await host.run('a', 'x');
          await host.run('a', 'y', { caller: { id: 'caller', kind: 'user', roles: [], scopes: [] } });
          return { close: async () => {} };
        },
      })),
      testAdapter('TriggerPort', 'interface', 'tr', () => ({ async start(h: typeof fire) { fire = h; return { close: async () => {} }; } })),
    ],
  });
  const handle = await s.start({ caller: { id: 'svc', kind: 'agent', roles: [], scopes: [] } });
  await fire!({ id: 't1', kind: 'tick', source: 'test' });
  assert.deepEqual(seen, ['svc', 'caller', 'svc']);
  await handle.close();
  seen.length = 0;
  await s.host().run('a', 'z');
  assert.deepEqual(seen, [undefined], 'without start options no caller is invented');
  await s.close();
});

test('host for mounted channels: stream fallback, governed model without injection, tools with knowledge; start skips mount-only', async () => {
  const { model, requests } = fakeModel(() => reply('hi there'));
  let mounted = 0;
  const s = await compose(resolveProfile({
    agents: { a: { model: 'm' } },
    layers: {
      model: { adapter: 'fake-model' }, runtime: { adapter: 'echo' }, knowledge: { wiki: { adapter: 'kb' } },
      channels: [{ adapter: 'http-only' }],
    },
    policy: [{ effect: 'allow', risk: ['read'] }],
  }), {
    adapters: [
      testAdapter('ModelPort', 'llm', 'fake-model', () => model),
      testAdapter('RuntimePort', 'harness', 'echo', () => echoRuntime),
      testAdapter('KnowledgePort', 'knowledge', 'kb', () => ({ async search() { return [{ id: 'p1', text: 'the ferry leaves at noon' }]; } })),
      testAdapter('ChannelPort', 'interface', 'http-only', () => ({ mount() { mounted++; return { routes: [] }; } })),
    ],
  });
  const host = s.host();
  const events: RunEvent[] = [];
  for await (const e of host.stream!('a', 'hello', { runId: 'run-9' })) events.push(e);
  assert.deepEqual(events.map((e) => e.type), ['text', 'run.end']);
  assert.deepEqual(events[1], { type: 'run.end', status: 'completed' });
  await host.model!().chat({ model: 'm', messages: [{ role: 'user', parts: [{ type: 'text', text: 'q' }] }] }, s.context({ agent: 'gateway' }));
  assert.ok(!JSON.stringify(requests.at(-1)).includes('ferry'), 'the hosted model does not inject knowledge');
  const tools = await host.tools!().listTools(s.context({ agent: 'gateway' }));
  assert.deepEqual(tools.map((t) => t.name), ['knowledge__wiki']);
  const out = await host.tools!().callTool('knowledge__wiki', { query: 'ferry' }, s.context({ agent: 'gateway' }));
  assert.match(out.text, /noon/);
  assert.equal(out.ok, true);
  const handle = await s.start();
  assert.equal(mounted, 0, 'start() leaves mount-only channels to a host server');
  await handle.close();
  await s.close();
});

test('findRoute: exact before prefix, longest prefix first, 405 methods', async () => {
  const { findRoute } = await import('../src/index.ts');
  const routes = [{ path: '/v1/*', methods: ['POST'] }, { path: '/v1/models', methods: ['GET'] }, { path: '/mcp' }];
  assert.equal(findRoute(routes, 'GET', '/v1/models').route, routes[1]);
  assert.equal(findRoute(routes, 'POST', '/v1/chat/completions').route, routes[0]);
  assert.deepEqual(findRoute(routes, 'DELETE', '/v1/models'), { allowed: ['GET', 'POST'] });
  assert.equal(findRoute(routes, 'DELETE', '/mcp').route, routes[2]);
  assert.deepEqual(findRoute(routes, 'GET', '/v10'), { allowed: [] });
});

test('core spans name the configured adapter that served them', async () => {
  const { records, telemetry } = recorder();
  const { model } = fakeModel(() => reply('ok'));
  const s = await compose(resolveProfile({
    layers: {
      model: { adapter: 'fake-model' },
      runtime: { adapter: 'echo' },
      knowledge: { wiki: { adapter: 'kb' } },
      guardrails: [{ adapter: 'allow-all' }],
    },
    agents: { a: { model: 'm' } },
  }), {
    telemetry: [telemetry],
    adapters: [
      testAdapter('ModelPort', 'llm', 'fake-model', () => model),
      testAdapter('RuntimePort', 'harness', 'echo', () => echoRuntime),
      testAdapter('KnowledgePort', 'knowledge', 'kb', () => ({ search: async () => [{ id: '1', text: 'Fact.' }] })),
      testAdapter('GuardPort', 'guardrail', 'allow-all', () => ({ check: async () => ({ action: 'allow' }) })),
    ],
  });
  await (await s.agent('a')).run('hi');
  const adapterOf = (name: string) => [...new Set(records.flatMap((r) => (r.type === 'span' && r.name === name ? [r.attrs['agent.adapter']] : [])))];
  assert.deepEqual(adapterOf('agent.run'), ['echo']);
  assert.deepEqual(adapterOf('agent.model.call'), ['fake-model']);
  assert.deepEqual(adapterOf('agent.knowledge.search'), ['kb']);
  assert.deepEqual(adapterOf('agent.guard.check'), ['allow-all']);
  await s.close();
});
