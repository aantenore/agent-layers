// The stack served as an OpenAI Chat Completions API through the gateway, called over HTTP.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { compose, resolveProfile, type Stack, type StackConfig } from '@agent-layers/core';
import { serveStack, type GatewayHandle } from '@agent-layers/gateway';
import { adapter as basicRuntime } from '@agent-layers/adapter-basic-runtime';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { adapter as regexGuard } from '@agent-layers/adapter-regex-guard';
import { identityAdapter } from '@agent-layers/adapter-static-identity';
import { channelAdapter } from '../src/index.ts';

let stack: Stack;
let gw: GatewayHandle;
const auth = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };

before(async () => {
  const config: StackConfig = {
    agents: { assistant: { instructions: 'Be brief.', model: 'mock' }, hidden: { instructions: '', model: 'mock' } },
    layers: {
      model: {
        adapter: 'mock-model',
        options: { rules: [{ match: 'weather in (\\w+)', tool: 'get_weather', args: { city: '{{1}}' } }, { match: 'ping', reply: 'pong' }] },
      },
      runtime: { adapter: 'basic-runtime' },
      identity: { adapter: 'static-identity', options: { tokens: { 'dev-token': { subject: 'dev-user' } } } },
      guardrails: [{ adapter: 'regex-guard', options: { custom: [{ name: 'secret_word', pattern: 'forbidden', action: 'block' }] } }],
      channels: [{ adapter: 'openai-compatible', options: { models: { fast: 'mock' }, agents: ['assistant'] } }],
    },
  };
  stack = await compose(resolveProfile(config), { adapters: [mockModel, basicRuntime, identityAdapter, regexGuard, channelAdapter] });
  gw = await serveStack(stack, { port: 0 });
});

after(async () => {
  await gw.close();
  await stack.close();
});

const post = (body: unknown, headers: Record<string, string> = auth) => fetch(`${gw.url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });

/** Parsed `data:` frames of an SSE body, `[DONE]` included as the string. */
async function frames(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => b.slice(6)).map((d) => (d === '[DONE]' ? d : JSON.parse(d)));
}

test('GET /v1/models lists the aliases and the exposed agents; callers must authenticate', async () => {
  assert.equal((await fetch(`${gw.url}/v1/models`)).status, 401);
  const list = await (await fetch(`${gw.url}/v1/models`, { headers: auth })).json() as { object: string; data: { id: string; object: string }[] };
  assert.equal(list.object, 'list');
  assert.deepEqual(list.data.map((m) => m.id), ['fast', 'agent:assistant']);
});

test('model passthrough: the governed model answers, with usage', async () => {
  const res = await post({ model: 'fast', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200);
  const body = await res.json() as { object: string; model: string; choices: { message: { content: string }; finish_reason: string }[]; usage: { total_tokens: number } };
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.model, 'fast');
  assert.equal(body.choices[0]!.message.content, 'pong');
  assert.equal(body.choices[0]!.finish_reason, 'stop');
  assert.ok(body.usage.total_tokens > 0);
});

test('model passthrough streams SSE chunks, a usage chunk and [DONE]', async () => {
  const res = await post({ model: 'fast', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'ping' }] });
  assert.match(res.headers.get('content-type')!, /text\/event-stream/);
  const all = await frames(res);
  assert.equal(all.at(-1), '[DONE]');
  const chunks = all.slice(0, -1) as { object: string; choices: { delta: { content?: string }; finish_reason: string | null }[]; usage?: { total_tokens: number } }[];
  assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk'));
  assert.equal(chunks.map((c) => c.choices[0]?.delta.content ?? '').join(''), 'pong');
  assert.ok(chunks.some((c) => c.choices[0]?.finish_reason === 'stop'));
  assert.ok(chunks.at(-1)!.usage!.total_tokens > 0);
});

test('tool calls pass through to the caller, plain and streamed', async () => {
  const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
  const plain = await (await post({ model: 'fast', tools, messages: [{ role: 'user', content: 'weather in Rome' }] })).json() as { choices: { message: { tool_calls: { function: { name: string; arguments: string } }[] }; finish_reason: string }[] };
  assert.equal(plain.choices[0]!.finish_reason, 'tool_calls');
  assert.deepEqual(plain.choices[0]!.message.tool_calls.map((t) => [t.function.name, JSON.parse(t.function.arguments)]), [['get_weather', { city: 'Rome' }]]);
  const streamed = (await frames(await post({ model: 'fast', tools, stream: true, messages: [{ role: 'user', content: 'weather in Rome' }] }))).slice(0, -1) as { choices: { delta: { tool_calls?: { function: { name?: string } }[] } }[] }[];
  assert.ok(streamed.some((c) => c.choices[0]?.delta.tool_calls?.[0]?.function.name === 'get_weather'));
});

test('input guards apply to passthrough calls: a block is a 400 content_filter', async () => {
  const res = await post({ model: 'fast', messages: [{ role: 'user', content: 'this is forbidden' }] });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: { code: string } };
  assert.equal(body.error.code, 'content_filter');
});

test('agent mode runs the agent through the runtime, plain and streamed', async () => {
  const res = await post({ model: 'agent:assistant', messages: [{ role: 'user', content: 'ping' }] });
  assert.ok(res.headers.get('x-agent-run-id'));
  const body = await res.json() as { model: string; choices: { message: { content: string }; finish_reason: string }[]; usage: { total_tokens: number } };
  assert.equal(body.model, 'agent:assistant');
  assert.equal(body.choices[0]!.message.content, 'pong');
  assert.ok(body.usage.total_tokens > 0);
  const all = await frames(await post({ model: 'agent:assistant', stream: true, messages: [{ role: 'user', content: 'ping' }] }));
  assert.equal(all.at(-1), '[DONE]');
  const chunks = all.slice(0, -1) as { choices: { delta: { content?: string }; finish_reason: string | null }[] }[];
  assert.equal(chunks.map((c) => c.choices[0]?.delta.content ?? '').join(''), 'pong');
  assert.equal(chunks.at(-1)!.choices[0]!.finish_reason, 'stop');
  const blocked = await (await post({ model: 'agent:assistant', messages: [{ role: 'user', content: 'forbidden' }] })).json() as { choices: { finish_reason: string }[] };
  assert.equal(blocked.choices[0]!.finish_reason, 'content_filter');
});

test('unknown models, agents not exposed and bad bodies are refused', async () => {
  assert.equal((await post({ model: 'gpt-x', messages: [{ role: 'user', content: 'ping' }] })).status, 404);
  assert.equal((await post({ model: 'agent:hidden', messages: [{ role: 'user', content: 'ping' }] })).status, 404);
  assert.equal((await post({ model: 'fast', messages: [] })).status, 400);
  assert.equal((await fetch(`${gw.url}/v1/chat/completions`, { method: 'POST', headers: auth, body: '{nope' })).status, 400);
});
