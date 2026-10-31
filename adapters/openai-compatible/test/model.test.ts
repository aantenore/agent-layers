import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleChunks, type ChatChunk, type ChatRequest } from '@agent-layers/core';
import { createOpenAICompatibleModel } from '../src/index.ts';
import { sseData } from '../src/sse.ts';
import { json, startMock, writeSplit } from './mock.ts';

const ctx = { runId: 'r', agent: 'a' };
const req: ChatRequest = { model: 'm1', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, extra: { top_k: 5 } };

test('plain answer: body, headers and response mapping', async () => {
  const mock = await startMock(({ body }, res) => json(res, {
    id: 'x1', object: 'chat.completion', created: 1, model: body.model, system_fingerprint: 'fp',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  }));
  try {
    const model = createOpenAICompatibleModel({ baseUrl: `${mock.url}/`, apiKey: 'k-123', headers: { 'x-team': 'a' } });
    const res = await model.chat(req, ctx);
    assert.equal(res.choices[0]!.message.content, 'Hello');
    assert.equal(res.choices[0]!.finish_reason, 'stop');
    assert.deepEqual(res.usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
    assert.equal(res.id, 'x1');
    assert.deepEqual(res.extra, { object: 'chat.completion', created: 1, system_fingerprint: 'fp' });
    const seen = mock.seen[0]!;
    assert.equal(seen.path, '/v1/chat/completions');
    assert.equal(seen.headers.authorization, 'Bearer k-123');
    assert.equal(seen.headers['x-team'], 'a');
    assert.deepEqual(seen.body, { model: 'm1', messages: req.messages, temperature: 0.2, top_k: 5, stream: false });
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

test('tool call: object arguments become a JSON string', async () => {
  const mock = await startMock();
  try {
    const model = createOpenAICompatibleModel({ baseUrl: mock.url });
    const res = await model.chat({
      ...req,
      tools: [{ type: 'function', function: { name: 'get_time', parameters: { type: 'object' } } }],
      tool_choice: 'required',
    }, ctx);
    const call = res.choices[0]!.message.tool_calls![0]!;
    assert.deepEqual(call, { id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{}' } });
    assert.equal(res.choices[0]!.message.content, null);
    assert.equal(res.choices[0]!.finish_reason, 'tool_calls');
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
    const chunks: ChatChunk[] = [];
    for await (const c of model.stream!(req, ctx)) chunks.push(c);
    assert.equal(chunks.length, events.length);
    assert.deepEqual(assembleChunks(chunks, 'm1'), {
      id: 's1',
      model: 'm1',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Caffè freddo',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"é"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    });
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
