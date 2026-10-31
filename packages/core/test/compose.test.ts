import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, GuardrailBlocked, MissingLayerError, resolveProfile, type RunEvent, type RuntimePort, type StackConfig } from '../src/index.ts';
import { fakeModel, recorder, reply, testAdapter } from './helpers.ts';

const echoRuntime: RuntimePort = {
  bind: (stack, agent) => ({
    name: agent.name,
    async run(input, c) {
      const res = await stack.modelFor(agent).chat({ model: agent.model, messages: [{ role: 'user', content: String(input) }] }, stack.context({ ...c, agent: agent.name }));
      return { runId: c?.runId ?? 'r', status: 'completed', output: res.choices[0]!.message.content ?? '', events: [{ type: 'done' }] };
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
  const { model, requests } = fakeModel((req) => reply(`echo ${String(req.messages.at(-1)!.content)}`));
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
  assert.deepEqual(appended, [['sess-1', [{ type: 'done' }]]]);

  await (await s.agent('reader')).run('question');
  assert.match(String(requests[1]!.messages[0]!.content), /Fact from the wiki/, 'default: all sources injected');

  const stopped = await helper.run('this is forbidden');
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.reason, new GuardrailBlocked('block-word', 'input').message);
  assert.ok(records.some((r) => r.type === 'span' && r.name === 'invoke_agent' && r.layer === 'harness' && r.attrs['run.status'] === 'stopped'));
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
  await governed.chat({ model: 'm', messages: [{ role: 'user', content: 'has pii' }] }, s.context({ agent: 'probe' }));
  assert.equal(requests[0]!.messages[0]!.content, '[x]', 'the stack model applies the stack guards');
  await s.close();
});
