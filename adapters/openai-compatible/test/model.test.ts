import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleDeltas, replyText, textMessage, type ModelDelta, type ModelRequest } from '@agent-layers/core';
import { createOpenAICompatibleModel } from '../src/index.ts';
import { SseLimitError, sseData } from '../src/sse.ts';
import { json, startMock, writeSplit } from './mock.ts';

const ctx = { runId: 'r', agent: 'a' };
const req: ModelRequest = {
  model: 'm1', messages: [textMessage('user', 'hi')], settings: { temperature: 0.2, maxOutputTokens: 64, stop: ['END'] }, ext: { 'openai.seed': 5, 'openai.top_p': 0.9 },
};

test('plain answer: body, headers and response mapping', async () => {
  const mock = await startMock(({ body }, res) => json(res, {
    id: 'x1', object: 'chat.completion', created: 1, model: body.model, system_fingerprint: 'fp',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  }));
  try {
    const model = createOpenAICompatibleModel({ baseUrl: `${mock.url}/`, apiKey: 'k-123', headers: { 'x-team': 'a' } });
    const res = await model.chat(req, ctx);
    assert.deepEqual(res.message, { role: 'assistant', parts: [{ type: 'text', text: 'Hello' }] });
    assert.equal(res.finish, 'end');
    assert.deepEqual(res.usage, { inputTokens: 4, outputTokens: 2, ext: { 'openai.usage': { total_tokens: 6 } } });
    assert.equal(res.id, 'x1');
    assert.equal(res.model, 'm1');
    assert.deepEqual(res.ext, { 'openai.response': { object: 'chat.completion', created: 1, system_fingerprint: 'fp' } });
    const seen = mock.seen[0]!;
    assert.equal(seen.path, '/v1/chat/completions');
    assert.equal(seen.headers.authorization, 'Bearer k-123');
    assert.equal(seen.headers['x-team'], 'a');
    assert.deepEqual(seen.body, {
      model: 'm1', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, max_tokens: 64, stop: ['END'], seed: 5, top_p: 0.9, stream: false,
    });
  } finally {
    await mock.close();
  }
});

test('request translation: roles, media, calls, results, tools, toolMode and options', async () => {
  const mock = await startMock();
  try {
    const model = createOpenAICompatibleModel({ baseUrl: mock.url, maxTokensField: 'max_completion_tokens' });
    await model.chat({
      model: 'm1',
      messages: [
        { role: 'system', parts: [{ type: 'text', text: 'Be brief.' }], ext: { 'openai.role': 'developer' } },
        { role: 'user', parts: [{ type: 'text', text: 'What is this?' }, { type: 'media', mediaType: 'image/png', data: 'AAAA' }, { type: 'media', mediaType: 'audio/wav', data: 'BBBB' }] },
        { role: 'assistant', parts: [{ type: 'reasoning', text: 'thinking' }, { type: 'call', id: 'c1', tool: 'look', args: { q: 1 } }, { type: 'call', id: 'c2', tool: 'bad', args: {}, invalid: '{oops' }] },
        { role: 'tool', parts: [{ type: 'result', callId: 'c1', ok: true, text: 'seen' }, { type: 'result', callId: 'c2', ok: false, text: 'failed' }] },
      ],
      tools: [{ name: 'look', description: 'Look', params: { type: 'object' } }],
      toolMode: { tool: 'look' },
      settings: { maxOutputTokens: 10 },
      ext: { 'openai.n': 2, 'openai.unknown_field': true },
    }, ctx);
    assert.deepEqual(mock.seen[0]!.body, {
      model: 'm1',
      messages: [
        { role: 'developer', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'input_audio', input_audio: { data: 'BBBB', format: 'wav' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'look', arguments: '{"q":1}' } }, { id: 'c2', type: 'function', function: { name: 'bad', arguments: '{oops' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'seen' },
        { role: 'tool', tool_call_id: 'c2', content: 'failed' },
      ],
      tools: [{ type: 'function', function: { name: 'look', description: 'Look', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'look' } },
      max_completion_tokens: 10,
      n: 2,
      stream: false,
    });
    const reasoning = createOpenAICompatibleModel({ baseUrl: mock.url, sendReasoning: true });
    await reasoning.chat({ model: 'm1', messages: [{ role: 'assistant', parts: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'hi' }] }] }, ctx);
    assert.deepEqual(mock.seen[1]!.body.messages, [{ role: 'assistant', content: 'hi', reasoning_content: 'hmm' }]);
  } finally {
    await mock.close();
  }
});

test('reply translation: reasoning, refusal fields, other choices, unknown finish and usage details', async () => {
  const mock = await startMock((_s, res) => json(res, {
    id: 'x2', model: 'm1',
    choices: [
      { index: 0, message: { role: 'assistant', reasoning: 'because', content: 'A', refusal: null }, finish_reason: 'eos', logprobs: null },
      { index: 1, message: { role: 'assistant', content: 'B' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, completion_tokens_details: { reasoning_tokens: 1 } },
  }));
  try {
    const res = await createOpenAICompatibleModel({ baseUrl: mock.url }).chat(req, ctx);
    assert.deepEqual(res.message, {
      role: 'assistant',
      parts: [{ type: 'reasoning', text: 'because', ext: { 'openai.reasoning_field': 'reasoning' } }, { type: 'text', text: 'A' }],
      ext: { 'openai.fields': { refusal: null } },
    });
    assert.equal(replyText(res), 'A');
    assert.equal(res.finish, 'other');
    assert.equal(res.ext?.['openai.finish_reason'], 'eos');
    assert.deepEqual(res.ext?.['openai.choices'], [{ index: 1, message: { role: 'assistant', content: 'B' }, finish_reason: 'stop' }]);
    assert.deepEqual(res.usage, { inputTokens: 1, outputTokens: 2, ext: { 'openai.usage': { total_tokens: 3, completion_tokens_details: { reasoning_tokens: 1 } } } });
  } finally {
    await mock.close();
  }
});

test('finish keeps the invariant: tools exactly when there are calls', async () => {
  const replies = [
    { message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 't', arguments: '{}' } }] }, finish_reason: 'stop' },
    { message: { role: 'assistant', content: 'x' }, finish_reason: 'tool_calls' },
    { message: { role: 'assistant', content: 'x' }, finish_reason: 'length' },
    { message: { role: 'assistant', content: 'x' }, finish_reason: 'content_filter' },
  ];
  let i = 0;
  const mock = await startMock((_s, res) => json(res, { model: 'm1', choices: [{ index: 0, ...replies[i++] }] }));
  try {
    const model = createOpenAICompatibleModel({ baseUrl: mock.url });
    const out = [];
    for (const _ of replies) {
      const r = await model.chat(req, ctx);
      out.push([r.finish, r.ext?.['openai.finish_reason']]);
    }
    assert.deepEqual(out, [['tools', 'stop'], ['other', 'tool_calls'], ['limit', undefined], ['refused', undefined]]);
  } finally {
    await mock.close();
  }
});

test('no Authorization header without a key; default model fills in', async () => {
  const mock = await startMock();
  try {
    const model = createOpenAICompatibleModel({ baseUrl: mock.url, model: 'configured' });
    await model.chat({ ...req, model: 'default' }, ctx);
    await model.chat({ ...req, model: '' }, ctx);
    await model.chat({ ...req, model: 'explicit' }, ctx);
    assert.equal(mock.seen[0]!.headers.authorization, undefined);
    assert.deepEqual(mock.seen.map((s) => s.body.model), ['configured', 'configured', 'explicit']);
    assert.deepEqual(model.native?.(), { baseUrl: mock.url, model: 'configured' });
  } finally {
    await mock.close();
  }
});

test('tool call: object arguments are parsed into args', async () => {
  const mock = await startMock();
  try {
    const model = createOpenAICompatibleModel({ baseUrl: mock.url });
    const res = await model.chat({ ...req, tools: [{ name: 'get_time', params: { type: 'object' } }], toolMode: 'required' }, ctx);
    assert.deepEqual(res.message.parts, [{ type: 'call', id: 'call_1', tool: 'get_time', args: {} }]);
    assert.equal(res.finish, 'tools');
  } finally {
    await mock.close();
  }
});

test('stream: split writes assemble into the same answer as chat', async () => {
  const events = [
    { id: 's1', model: 'm1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Caffè ' } }] },
    { id: 's1', model: 'm1', choices: [{ index: 0, delta: { content: 'freddo' } }] },
    { id: 's1', model: 'm1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] } }] },
    { id: 's1', model: 'm1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"é"}' } }] } }] },
    { id: 's1', model: 'm1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { id: 's1', model: 'm1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } },
  ];
  const mock = await startMock(async ({ body }, res) => {
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // CRLF line ends, comments, an event name and a field without a space after the colon.
    const text = ': ping\r\n\r\n' + events.map((e) => `event: message\r\ndata:${JSON.stringify(e)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\ndata: {"ignored":true}\n\n';
    await writeSplit(res, text, 5);
    res.end();
  });
  try {
    const model = createOpenAICompatibleModel({ baseUrl: mock.url });
    const deltas: ModelDelta[] = [];
    for await (const d of model.stream!(req, ctx)) deltas.push(d);
    assert.deepEqual(deltas.slice(0, 4), [
      { type: 'text', text: 'Caffè ' },
      { type: 'text', text: 'freddo' },
      { type: 'call', index: 0, id: 'c1', tool: 'lookup', argsText: '{"q":' },
      { type: 'call', index: 0, argsText: '"é"}' },
    ]);
    assert.equal(deltas.filter((d) => d.type === 'end').length, 1);
    assert.deepEqual(assembleDeltas(deltas, 'm1'), {
      id: 's1',
      model: 'm1',
      message: { role: 'assistant', parts: [{ type: 'text', text: 'Caffè freddo' }, { type: 'call', id: 'c1', tool: 'lookup', args: { q: 'é' } }] },
      finish: 'tools',
      usage: { inputTokens: 5, outputTokens: 7, ext: { 'openai.usage': { total_tokens: 12 } } },
    });
  } finally {
    await mock.close();
  }
});

test('stream: reasoning deltas, and an end delta even when the backend names no finish', async () => {
  const mock = await startMock(async (_s, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'mm' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\n`);
  });
  try {
    const deltas: ModelDelta[] = [];
    for await (const d of createOpenAICompatibleModel({ baseUrl: mock.url }).stream!(req, ctx)) deltas.push(d);
    assert.deepEqual(deltas, [{ type: 'reasoning', text: 'mm' }, { type: 'text', text: 'ok' }, { type: 'end', finish: 'other', model: 'm1' }]);
  } finally {
    await mock.close();
  }
});

test('stream: includeUsage false omits stream_options', async () => {
  const mock = await startMock();
  try {
    const model = createOpenAICompatibleModel({ baseUrl: mock.url, includeUsage: false });
    for await (const _ of model.stream!(req, ctx));
    assert.equal(mock.seen[0]!.body.stream_options, undefined);
  } finally {
    await mock.close();
  }
});

test('sseData: joins multi-line data, flushes a last event without blank line', async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const part of ['data: a\nda', 'ta: b\n\nid: 7\n\n:c\ndata: last']) c.enqueue(enc.encode(part));
      c.close();
    },
  });
  const out: string[] = [];
  for await (const d of sseData(body)) out.push(d);
  assert.deepEqual(out, ['a\nb', 'last']);
});

test('sseData: a line without an end, or an event, longer than the cap rejects', async () => {
  const enc = new TextEncoder();
  const stream = (parts: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } });
  const drain = async (body: ReadableStream<Uint8Array>, max: number) => { const out: string[] = []; for await (const d of sseData(body, max)) out.push(d); return out; };
  await assert.rejects(drain(stream(['data: ', 'x'.repeat(30)]), 16), SseLimitError);
  await assert.rejects(drain(stream([`data: ${'a'.repeat(10)}\ndata: ${'b'.repeat(10)}\n`]), 16), SseLimitError);
  assert.deepEqual(await drain(stream([`data: ${'a'.repeat(16)}\n\n`]), 16), ['a'.repeat(16)]);
});

test('error status: message carries status and body, not the key', async () => {
  const mock = await startMock((_s, res) => json(res, { error: { message: 'bad key sk-secret-value' } }, 401));
  try {
    const model = createOpenAICompatibleModel({ baseUrl: mock.url, apiKey: 'sk-secret-value' });
    await assert.rejects(model.chat(req, ctx), (err: Error) => {
      assert.match(err.message, /^HTTP 401 from http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions: /);
      assert.ok(!err.message.includes('sk-secret-value'));
      return true;
    });
    await assert.rejects(async () => { for await (const _ of model.stream!(req, ctx)); }, /HTTP 401/);
  } finally {
    await mock.close();
  }
});

test('error body is cut at 300 characters', async () => {
  const mock = await startMock((_s, res) => { res.writeHead(500); res.end('x'.repeat(1000)); });
  try {
    const model = createOpenAICompatibleModel({ baseUrl: mock.url });
    await assert.rejects(model.chat(req, ctx), (err: Error) => err.message.endsWith(': ' + 'x'.repeat(300)));
  } finally {
    await mock.close();
  }
});

test('abort: an aborted signal rejects, also mid-request', async () => {
  const mock = await startMock(() => new Promise(() => {}));
  try {
    const model = createOpenAICompatibleModel({ baseUrl: mock.url });
    const done = new AbortController();
    done.abort();
    await assert.rejects(model.chat(req, { ...ctx, signal: done.signal }));
    const ac = new AbortController();
    const pending = model.chat(req, { ...ctx, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(pending);
  } finally {
    await mock.close();
  }
});

test('timeout rejects a stalled request', async () => {
  const mock = await startMock(() => new Promise(() => {}));
  try {
    const model = createOpenAICompatibleModel({ baseUrl: mock.url, timeoutMs: 50 });
    await assert.rejects(model.chat(req, ctx));
  } finally {
    await mock.close();
  }
});

test('trace context: the active span of the run telemetry, else the run context, goes out as traceparent', async () => {
  const mock = await startMock();
  try {
    const model = createOpenAICompatibleModel({ baseUrl: mock.url });
    const active = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const inbound = '00-11111111111111111111111111111111-2222222222222222-01';
    const telemetry = { span: (_n: string, _a: unknown, fn: (s: never) => Promise<unknown>) => fn({} as never), event() {}, metric() {}, current: () => ({ parent: active, state: 'v=1' }) };
    await model.chat(req, { ...ctx, telemetry: telemetry as never, trace: { parent: inbound } });
    await model.chat(req, { ...ctx, trace: { parent: inbound } });
    await model.chat(req, ctx);
    assert.deepEqual(mock.seen.map((s) => [s.headers.traceparent, s.headers.tracestate]), [[active, 'v=1'], [inbound, undefined], [undefined, undefined]]);
  } finally {
    await mock.close();
  }
});
