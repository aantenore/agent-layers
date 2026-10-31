import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  AdapterRegistry, callsOf, compose, defineAdapter, messageText, packageLoader, PORT_VERSIONS, recordingTelemetry, resolveProfile, textMessage, toolInfos,
  type Message, type RuntimePort, type StackConfig, type TelemetryRecord,
} from '@agent-layers/core';
import { adapter as functionsAdapter, createFunctionTools, defineTool } from '@agent-layers/adapter-functions';
import { REPO } from './helpers.ts';

/** The smallest possible runtime: proves any loop can drive the composed ports. */
const tinyRuntime: RuntimePort = {
  bind: (stack, agent) => ({
    name: agent.name,
    async run(input, init = {}) {
      const ctx = stack.context({ ...init, agent: agent.name });
      const model = stack.modelFor(agent);
      const tools = stack.toolsFor(agent);
      const specs = await tools.listTools(ctx);
      const messages: Message[] = [textMessage('system', agent.instructions), textMessage('user', String(input))];
      for (let turn = 0; turn < 4; turn++) {
        const reply = await model.chat({ model: agent.model, messages, tools: toolInfos(specs) }, ctx);
        messages.push(reply.message);
        const calls = callsOf(reply.message);
        if (!calls.length) return { runId: ctx.runId, status: 'completed', output: messageText(reply.message) };
        for (const call of calls) {
          const out = await tools.callTool(call.tool, call.args, ctx);
          messages.push({ role: 'tool', parts: [{ type: 'result', callId: call.id, ok: out.ok, text: out.text }] });
        }
      }
      return { runId: ctx.runId, status: 'stopped', output: '', reason: { code: 'limit', layer: 'harness', detail: 'turns' } };
    },
  }),
};

/** The OpenAI wire the test server reads (not the SDK language). */
interface WireBody { model: string; messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }

const seen: { body: WireBody; headers: IncomingHttpHeaders }[] = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c: Buffer) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw) as WireBody;
    seen.push({ body, headers: req.headers });
    const last = body.messages.at(-1)!;
    const message = last.role === 'tool'
      ? { role: 'assistant', content: `The ledger says: ${String(last.content)}` }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'harbour__ledger', arguments: '{"vessel":"Gull"}' } }] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: `r${seen.length}`, model: body.model, choices: [{ index: 0, message, finish_reason: last.role === 'tool' ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
});

let dir: string;
let baseUrl: string;
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  dir = await mkdtemp(join(tmpdir(), 'agent-layers-e2e-'));
  await writeFile(join(dir, 'harbour.md'), '# Harbour\n\n## Tide gate\n\nThe tide gate closes at 19:40.\n');
});
after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('in-process run: every port composes around a runtime and an OpenAI-compatible server', async () => {
  const records: TelemetryRecord[] = [];
  const config: StackConfig = {
    layers: {
      runtime: { adapter: 'tiny-runtime' },
      model: { adapter: 'openai-compatible', options: { baseUrl, apiKey: 'sk-test-key-123' } },
      router: { adapter: 'static-router', options: { model: 'harbour-model' } },
      cache: { adapter: 'memory-cache' },
      knowledge: { wiki: { adapter: 'markdown-knowledge', options: { dir } } },
      tools: { harbour: { adapter: 'functions' } },
      identity: { adapter: 'static-identity', options: { tokens: { 'user-token-abc': { subject: 'ysolde', roles: ['harbourmaster'] } } } },
      credentials: { adapter: 'static-identity', options: { tokens: { ledger: 'ledger-token-xyz' } } },
      authorization: { adapter: 'rules-authorization', options: { rules: [{ effect: 'allow', when: { roles: ['harbourmaster'] } }] } },
      guardrails: [{ adapter: 'regex-guard' }],
      eval: [{ adapter: 'expected-eval' }],
    },
    policy: [{ effect: 'allow', risk: ['read'] }],
    agents: { clerk: { instructions: 'You keep the harbour ledger.', model: 'any', tools: ['harbour__*'] } },
  };
  const ledger = defineTool({
    name: 'ledger', description: 'Looks up a vessel in the harbour ledger', risk: 'read', audience: 'ledger',
    params: { type: 'object', properties: { vessel: { type: 'string' } }, required: ['vessel'] },
    run: async ({ vessel }, ctx) => `${String(vessel)} berthed at pier 3 (token ${(await ctx.credentials!.token('ledger')).length} chars)`,
  });
  const registry = new AdapterRegistry({ loader: packageLoader(REPO) });
  registry.register({ ...functionsAdapter, create: (_o: unknown, c: { name: string }) => createFunctionTools({ tools: [ledger] }, { name: c.name }) });
  const stack = await compose(resolveProfile(config, undefined, REPO), {
    registry, env: {}, telemetry: [recordingTelemetry((r) => records.push(r))],
    adapters: [defineAdapter({
      layer: 'harness', port: 'RuntimePort', name: 'tiny-runtime', direction: 'outbound', maps: { technology: 'test loop' },
      portVersion: PORT_VERSIONS.RuntimePort, tiers: ['prototype'], create: () => tinyRuntime,
    })],
  });

  const caller = await stack.verify('user-token-abc');
  const agent = await stack.agent('clerk');
  const result = await agent.run('Where is the Gull, and when does the tide gate close? Reply to ysolde@example.com', { caller });

  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'The ledger says: Gull berthed at pier 3 (token 16 chars)');

  const first = seen[0]!;
  assert.equal(first.headers.authorization, 'Bearer sk-test-key-123');
  assert.equal(first.body.model, 'harbour-model', 'router chose the model');
  assert.ok(first.body.messages.some((m) => m.role === 'user' && String(m.content).includes('[EMAIL]') && !String(m.content).includes('ysolde@example.com')), 'input guard redacted the email');
  assert.ok(first.body.messages.some((m) => m.role === 'system' && String(m.content).includes('trust="untrusted"')), 'knowledge block injected');
  assert.deepEqual(first.body.tools?.map((t) => t.function.name), ['harbour__ledger']);

  const spans = records.filter((r) => r.type === 'span');
  const layers = new Set(spans.map((s) => s.layer));
  for (const l of ['guardrail', 'cache', 'knowledge', 'llm', 'identity', 'tool', 'harness'] as const) assert.ok(layers.has(l), `span for ${l}`);
  const dump = JSON.stringify(records);
  for (const secret of ['user-token-abc', 'ledger-token-xyz', 'sk-test-key-123', 'ysolde@example.com']) assert.ok(!dump.includes(secret), `${secret} leaked into telemetry`);

  const scores = await stack.ports.eval[0]!.score({ id: 'gull', input: 'x', expected: 'pier 3' }, { runId: result.runId, output: result.output, status: result.status });
  assert.equal(scores[0]!.value, 1);

  const denied = await (await stack.agent('clerk')).run('Where is the Gull?');
  assert.match(denied.output, /^The ledger says: Denied: no rule matched \(default deny\)/, 'without a harbourmaster caller the tool call is denied');
  assert.equal(denied.status, 'completed');
  await stack.close();
});
