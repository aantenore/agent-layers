// Round trips of the translation: wire → language → wire must come back unchanged for these samples.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roundTrip } from '@agent-layers/conformance';
import type { ModelDelta } from '@agent-layers/core';
import { chunksOut, DeltaReader, messageIn, messageOut, replyIn, replyOut, requestIn, requestOut } from '../src/wire.ts';

type Json = Record<string, any>;

test('messages: every role, media, calls, results, developer, extra fields and unknown parts', () => {
  const samples: Json[] = [
    { role: 'system', content: 'Be brief.' },
    { role: 'developer', content: 'Answer in French.' },
    { role: 'user', content: 'hello', name: 'ann' },
    { role: 'user', content: [{ type: 'text', text: 'What is it?' }, { type: 'image_url', image_url: { url: 'https://x.test/a.png', detail: 'high' } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }, { type: 'input_audio', input_audio: { data: 'BBBB', format: 'mp3' } }] },
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'file', file: { file_id: 'f1' } }] },
    { role: 'assistant', content: 'Sure.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'look', arguments: '{"q":"x"}' } }] },
    { role: 'assistant', content: 'Let me check.', reasoning_content: 'need data', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'bad', arguments: '{nope' } }] },
    { role: 'assistant', content: 'Hi', reasoning: 'short', refusal: null },
    { role: 'tool', tool_call_id: 'c1', content: 'found' },
  ];
  const failures = roundTrip(samples, (m) => messageIn(m), (l) => messageOut(l, { reasoning: true })[0]!, { shape: 'Message' });
  assert.deepEqual(failures, []);
});

test('requests: tools, toolMode, settings and passthrough fields', () => {
  const samples: Json[] = [
    { model: 'gpt', messages: [{ role: 'user', content: 'hi' }] },
    {
      model: 'gpt', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
      tools: [{ type: 'function', function: { name: 'look', description: 'Look up', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }],
      tool_choice: { type: 'function', function: { name: 'look' } }, temperature: 0.3, max_tokens: 100, stop: ['END'],
      response_format: { type: 'json_object' }, seed: 7, top_p: 0.5, parallel_tool_calls: false, n: 2, user: 'u-1',
    },
    { model: 'o', messages: [{ role: 'user', content: 'x' }], tool_choice: 'required', max_completion_tokens: 50, reasoning_effort: 'low' },
  ];
  const failures = roundTrip(samples, (b) => requestIn(b), (r) => requestOut(r), { shape: 'ModelRequest' });
  assert.deepEqual(failures, []);
});

test('replies: text, calls, reasoning, other choices, logprobs, unknown finish and usage details', () => {
  const samples: Json[] = [
    {
      id: 'r1', object: 'chat.completion', created: 1, model: 'gpt', system_fingerprint: 'fp',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop', logprobs: null }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } },
    },
    {
      id: 'r2', model: 'gpt',
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 't', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }],
    },
    {
      model: 'local', choices: [
        { index: 0, message: { role: 'assistant', content: 'A', reasoning_content: 'why' }, finish_reason: 'length' },
        { index: 1, message: { role: 'assistant', content: 'B' }, finish_reason: 'stop' },
      ],
    },
    { model: 'local', choices: [{ index: 0, message: { role: 'assistant', content: 'cut' }, finish_reason: 'eos' }] },
    { model: 'local', choices: [{ index: 0, message: { role: 'assistant', content: 'no' }, finish_reason: 'content_filter' }] },
  ];
  const failures = roundTrip(samples, (r) => replyIn(r), (l) => replyOut(l), { shape: 'ModelReply' });
  assert.deepEqual(failures, []);
});

test('streams: chunks → deltas → chunks, text, reasoning, split call arguments, finish and usage', () => {
  const env = { id: 's1', object: 'chat.completion.chunk', created: 5, model: 'gpt' };
  const choice = (delta: Json, finish_reason: string | null = null) => ({ ...env, choices: [{ index: 0, delta, finish_reason }] });
  const samples: Json[][] = [
    [choice({ role: 'assistant', content: 'Hel' }), choice({ content: 'lo' }), choice({}, 'stop'), { ...env, choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }],
    [
      choice({ role: 'assistant', reasoning_content: 'hm' }),
      choice({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'look', arguments: '{"q":' } }] }),
      choice({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }),
      choice({}, 'tool_calls'),
      { ...env, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ],
  ];
  const toLanguage = (chunks: Json[]): ModelDelta[] => {
    const reader = new DeltaReader();
    return [...chunks.flatMap((c) => reader.push(c)), reader.end()];
  };
  assert.deepEqual(roundTrip(samples, toLanguage, (d) => chunksOut(d, { includeUsage: true })), []);
});
