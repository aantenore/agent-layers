// The inbound Chat Completions API on a mount, without a gateway: wire requests in, language at the host, wire out.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inboundFetch } from '@agent-layers/conformance';
import {
  GuardrailBlocked, replyToDeltas, Vocabularies, type CallContext, type ChannelHost, type ModelPort, type ModelReply, type ModelRequest, type RunEvent, type RunInput,
  type RunResult,
} from '@agent-layers/core';
import { createOpenAICompatibleChannel } from '../src/index.ts';

const seen: { req?: ModelRequest; ctx?: CallContext; input?: RunInput; runCtx?: Partial<CallContext> } = {};
let nextReply: ModelReply = { model: 'mock', message: { role: 'assistant', parts: [{ type: 'text', text: 'pong' }] }, finish: 'end', usage: { inputTokens: 2, outputTokens: 1 } };
let nextRun: RunResult = { runId: 'r', status: 'completed', output: 'done', usage: { inputTokens: 5, outputTokens: 3 } };

const model: ModelPort = {
  async chat(req, ctx) {
    seen.req = req;
    seen.ctx = ctx;
    if (req.messages.some((m) => m.parts.some((p) => p.type === 'text' && (p as { text: string }).text === 'forbidden'))) throw new GuardrailBlocked('secret-word', 'input', 'matched');
    return nextReply;
  },
  async *stream(req, ctx) { yield* replyToDeltas(await this.chat(req, ctx)); },
};
const host: ChannelHost = {
  agents: () => ['assistant', 'hidden'],
  async run(_agent, input, ctx) { seen.input = input; seen.runCtx = ctx; return nextRun; },
  async *stream(_agent, input, ctx): AsyncIterable<RunEvent> {
    seen.input = input;
    seen.runCtx = ctx;
    if (nextRun.output) yield { type: 'text', text: nextRun.output };
    yield { type: 'run.end', status: nextRun.status, ...(nextRun.reason ? { reason: nextRun.reason } : {}), ...(nextRun.usage ? { usage: nextRun.usage } : {}) };
  },
  model: () => model,
};
const caller = { id: 'u-1', kind: 'user' as const, roles: [], scopes: [], credential: 'secret' };
const vocab = new Vocabularies([{ role: { aliases: { human: 'user' } }, finish: { add: { safety: { like: 'refused' } } } }]);
const mount = await createOpenAICompatibleChannel({ models: { fast: 'mock' }, agents: ['assistant'] }, 'openai-compatible', () => vocab).mount!(host);
const post = (body: unknown) => inboundFetch(mount, new Request('http://gw.test/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { caller, trace: { parent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' } });
const frames = async (res: Response) => (await res.text()).split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => b.slice(6)).map((d) => (d === '[DONE]' ? d : JSON.parse(d)));

test('model route: the wire request becomes a language request; the reply goes back as a chat.completion', async () => {
  const res = await post({
    model: 'fast', messages: [{ role: 'developer', content: 'Be brief.' }, { role: 'human', content: 'ping' }], max_completion_tokens: 20, seed: 3, top_k: 9,
    tools: [{ type: 'function', function: { name: 'look', parameters: { type: 'object' } } }], tool_choice: 'auto',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(seen.req, {
    model: 'mock',
    messages: [
      { role: 'system', parts: [{ type: 'text', text: 'Be brief.' }], ext: { 'openai.role': 'developer' } },
      { role: 'user', parts: [{ type: 'text', text: 'ping' }], ext: { 'openai.role': 'human' } },
    ],
    tools: [{ name: 'look', params: { type: 'object' } }],
    toolMode: 'auto',
    settings: { maxOutputTokens: 20 },
    ext: { 'openai.seed': 3, 'openai.max_tokens_field': 'max_completion_tokens' },
  });
  assert.equal(seen.ctx?.caller?.id, 'u-1');
  assert.deepEqual(seen.ctx?.trace, { parent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });
  const body = await res.json() as Record<string, any>;
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.model, 'fast');
  assert.deepEqual(body.choices, [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop', logprobs: null }]);
  assert.deepEqual(body.usage, { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
});

test('model route: calls and a configured finish value; a guard block is a 400 without the guard name', async () => {
  nextReply = { model: 'mock', message: { role: 'assistant', parts: [{ type: 'call', id: 'c1', tool: 'look', args: { q: 'x' } }] }, finish: 'tools' };
  const calls = await (await post({ model: 'fast', messages: [{ role: 'user', content: 'go' }] })).json() as Record<string, any>;
  assert.deepEqual(calls.choices[0], { index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'look', arguments: '{"q":"x"}' } }] }, finish_reason: 'tool_calls', logprobs: null });
  nextReply = { model: 'mock', message: { role: 'assistant', parts: [{ type: 'text', text: '' }] }, finish: 'safety' };
  assert.equal((await (await post({ model: 'fast', messages: [{ role: 'user', content: 'go' }] })).json() as any).choices[0].finish_reason, 'content_filter');
  const blocked = await post({ model: 'fast', messages: [{ role: 'user', content: 'forbidden' }] });
  assert.equal(blocked.status, 400);
  const error = (await blocked.json() as any).error;
  assert.equal(error.code, 'content_filter');
  assert.doesNotMatch(error.message, /secret-word|input/);
});

test('model route streams chunks with role first, finish, usage and [DONE]', async () => {
  nextReply = { model: 'mock', message: { role: 'assistant', parts: [{ type: 'text', text: 'pong' }] }, finish: 'end', usage: { inputTokens: 2, outputTokens: 1 } };
  const all = await frames(await post({ model: 'fast', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'ping' }] }));
  assert.equal(all.at(-1), '[DONE]');
  const chunks = all.slice(0, -1) as Record<string, any>[];
  assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk' && c.model === 'fast'));
  assert.deepEqual(chunks[0]!.choices[0].delta, { role: 'assistant', content: 'pong' });
  assert.equal(chunks.at(-2)!.choices[0].finish_reason, 'stop');
  assert.deepEqual(chunks.at(-1)!.usage, { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
});

test('agent route: completed, waiting and stopped answer 200; failed answers 500; the caller reaches the run', async () => {
  nextRun = { runId: 'r', status: 'completed', output: 'done', usage: { inputTokens: 5, outputTokens: 3 } };
  const ok = await post({ model: 'agent:assistant', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(ok.headers.get('x-agent-run-id'));
  const body = await ok.json() as Record<string, any>;
  assert.deepEqual([body.choices[0].message.content, body.choices[0].finish_reason, body.usage.total_tokens], ['done', 'stop', 8]);
  assert.deepEqual(seen.input, { messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] });
  assert.equal(seen.runCtx?.caller?.id, 'u-1');
  nextRun = { runId: 'r', status: 'waiting', output: 'so far', reason: { code: 'needs_input', layer: 'identity', by: 'approval', detail: 'a-1' } };
  assert.deepEqual((await (await post({ model: 'agent:assistant', messages: [{ role: 'user', content: 'hi' }] })).json() as any).choices[0].message, { role: 'assistant', content: 'so far' });
  nextRun = { runId: 'r', status: 'stopped', output: 'partial', reason: { code: 'guard_block', layer: 'guardrail', by: 'g', stage: 'output' } };
  const stopped = await (await post({ model: 'agent:assistant', messages: [{ role: 'user', content: 'hi' }] })).json() as any;
  assert.deepEqual([stopped.choices[0].message.content, stopped.choices[0].finish_reason], ['', 'content_filter']);
  nextRun = { runId: 'r', status: 'failed', output: '', reason: { code: 'error' } };
  assert.equal((await post({ model: 'agent:assistant', messages: [{ role: 'user', content: 'hi' }] })).status, 500);
  assert.equal((await post({ model: 'agent:hidden', messages: [{ role: 'user', content: 'hi' }] })).status, 404);
});

test('agent route streams text events, then the finish from run.end and its usage', async () => {
  nextRun = { runId: 'r', status: 'completed', output: 'streamed', usage: { inputTokens: 1, outputTokens: 1 } };
  const chunks = (await frames(await post({ model: 'agent:assistant', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] }))).slice(0, -1) as Record<string, any>[];
  assert.equal(chunks.map((c) => c.choices[0]?.delta.content ?? '').join(''), 'streamed');
  assert.equal(chunks.at(-2)!.choices[0].finish_reason, 'stop');
  assert.equal(chunks.at(-1)!.usage.total_tokens, 2);
});

test('bad bodies are 400: unknown roles, empty messages, missing content', async () => {
  assert.equal((await post({ model: 'fast', messages: [{ role: 'wizard', content: 'x' }] })).status, 400);
  assert.equal((await post({ model: 'fast', messages: [] })).status, 400);
  assert.equal((await post({ model: 'fast', messages: [{ role: 'user' }] })).status, 400);
  assert.equal((await post({ model: 'nope', messages: [{ role: 'user', content: 'x' }] })).status, 404);
});

test('model route returns one guarded choice: n > 1 is refused, logprobs and ext-carried content are never echoed', async () => {
  assert.equal((await post({ model: 'fast', n: 2, messages: [{ role: 'user', content: 'x' }] })).status, 400);
  nextReply = {
    model: 'mock', finish: 'end',
    message: { role: 'assistant', parts: [{ type: 'reasoning', text: 'think a@b.co' }, { type: 'text', text: 'pong' }], ext: { 'openai.fields': { refusal: 'unguarded', audio: { data: 'x' } }, 'openai.role': 'system' } },
    ext: { 'openai.choices': [{ index: 1, message: { role: 'assistant', content: 'other choice' } }], 'openai.choice_logprobs': { content: [{ token: 'p' }] }, 'openai.response': { system_fingerprint: 'fp', extra: 'unguarded' } },
  };
  const res = await post({ model: 'fast', n: 1, logprobs: true, top_logprobs: 3, messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200);
  assert.deepEqual(seen.req?.ext, undefined, 'n, logprobs and top_logprobs never reach the model');
  const body = await res.json() as Record<string, any>;
  assert.deepEqual(body.choices, [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop', logprobs: null }]);
  assert.doesNotMatch(JSON.stringify(body), /other choice|unguarded|a@b\.co|fp/);
  const chunks = (await frames(await post({ model: 'fast', stream: true, messages: [{ role: 'user', content: 'ping' }] }))).slice(0, -1) as Record<string, any>[];
  assert.ok(chunks.every((c) => c.choices.length <= 1 && !('reasoning_content' in (c.choices[0]?.delta ?? {}))), 'no reasoning streamed by default');
  assert.doesNotMatch(JSON.stringify(chunks), /a@b\.co|other choice/);
});

test('model route: raw backend parts and media never reach the caller, only the guarded text', async () => {
  nextReply = {
    model: 'mock', finish: 'end',
    message: { role: 'assistant', parts: [
      { type: 'text', text: 'see ' }, { type: 'openai.part', part: { type: 'output_text_extra', text: 'jane@example.com' } } as never,
      { type: 'media', mediaType: 'image/png', url: 'https://x.test/jane@example.com.png' }, { type: 'text', text: 'above' },
    ] },
  };
  const body = await (await post({ model: 'fast', messages: [{ role: 'user', content: 'ping' }] })).json() as Record<string, any>;
  assert.deepEqual(body.choices[0].message, { role: 'assistant', content: 'see above' });
  const chunks = await frames(await post({ model: 'fast', stream: true, messages: [{ role: 'user', content: 'ping' }] }));
  assert.doesNotMatch(JSON.stringify([body, chunks]), /jane@example\.com/);
});

test('reasoning: true returns the (guarded) reasoning on model routes', async () => {
  const withReasoning = await createOpenAICompatibleChannel({ models: { fast: 'mock' }, reasoning: true }).mount!(host);
  nextReply = { model: 'mock', finish: 'end', message: { role: 'assistant', parts: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'pong' }] } };
  const send = (body: unknown) => inboundFetch(withReasoning, new Request('http://gw.test/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const body = await (await send({ model: 'fast', messages: [{ role: 'user', content: 'ping' }] })).json() as Record<string, any>;
  assert.deepEqual(body.choices[0].message, { role: 'assistant', content: 'pong', reasoning_content: 'think' });
  const chunks = (await frames(await send({ model: 'fast', stream: true, messages: [{ role: 'user', content: 'ping' }] }))).slice(0, -1) as Record<string, any>[];
  assert.ok(chunks.some((c) => c.choices[0]?.delta.reasoning_content === 'think'));
});
