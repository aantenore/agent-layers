import { assembleChunks, type CachePort, type ChatChunk, type ChatRequest, type ModelPort, type RouterPort } from '@agent-layers/core';
import { Checks, testContext } from '../check.ts';
import { conforms } from '../schemas.ts';

export interface ModelFixtures {
  model?: string;
  prompt?: string;
  /** Offer one tool with tool_choice=required and expect a tool call (default false). */
  toolCall?: boolean;
  /** Check that an aborted signal rejects (default true). */
  abort?: boolean;
  timeoutMs?: number;
}

export async function checkModel(port: ModelPort, f: ModelFixtures = {}, c = new Checks()): Promise<Checks> {
  const model = f.model ?? 'test';
  const req: ChatRequest = { model, messages: [{ role: 'user', content: f.prompt ?? 'Reply with the single word OK.' }], max_tokens: 64 };
  const res = await c.attempt('chat', () => port.chat(req, testContext()), f.timeoutMs);
  if (res) {
    c.all(conforms('chat-response', res), 'chat response');
    const msg = res.choices[0]?.message;
    c.expect(typeof msg?.content === 'string' || msg?.tool_calls?.length, 'chat: first choice has neither content nor tool calls');
  }
  if (port.stream) {
    const chunks = await c.attempt('stream', async () => {
      const out: ChatChunk[] = [];
      for await (const ch of port.stream!(req, testContext())) out.push(ch);
      return out;
    }, f.timeoutMs);
    if (chunks) {
      c.expect(chunks.length > 0, 'stream: yielded no chunks');
      c.expect(chunks.every((ch) => Array.isArray(ch.choices)), 'stream: every chunk needs a choices array');
      c.all(conforms('chat-response', assembleChunks(chunks, model)), 'assembled stream');
    }
  } else c.skip('stream: not implemented (optional)');
  if (f.toolCall) {
    const tooled = await c.attempt('chat with tools', () => port.chat({
      ...req, messages: [{ role: 'user', content: 'What time is it? Use the tool.' }],
      tools: [{ type: 'function', function: { name: 'get_time', description: 'Current time', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'required',
    }, testContext()), f.timeoutMs);
    const call = tooled?.choices[0]?.message.tool_calls?.[0];
    if (tooled && c.expect(call, 'chat with tools: expected a tool call')) {
      c.expect(call!.function.name === 'get_time', `chat with tools: called "${call!.function.name}"`);
      c.expect(isJson(call!.function.arguments), 'chat with tools: arguments must be a JSON string');
    }
  }
  if (f.abort !== false) {
    const ac = new AbortController();
    ac.abort();
    await c.rejects('chat with an aborted signal', () => port.chat(req, testContext({ signal: ac.signal })));
  }
  return c;
}

const isJson = (s: string) => { try { JSON.parse(s); return true; } catch { return false; } };

export interface RouterFixtures { requests?: ChatRequest[]; expect?: string[] }

export async function checkRouter(port: RouterPort, f: RouterFixtures = {}, c = new Checks()): Promise<Checks> {
  const reqs = f.requests ?? [{ model: 'default', messages: [{ role: 'user', content: 'hello' }] }];
  for (const [i, r] of reqs.entries()) {
    const m = await c.attempt(`select #${i}`, () => port.select(r, testContext()));
    if (m === undefined) continue;
    c.expect(typeof m === 'string' && m.length > 0, `select #${i}: must return a non-empty model id`);
    if (f.expect?.[i] !== undefined) c.expect(m === f.expect[i], `select #${i}: expected "${f.expect[i]}", got "${m}"`);
  }
  return c;
}

export interface CacheFixtures { /** Check expiry with a short TTL (default true). */ ttl?: boolean }

export async function checkCache(port: CachePort, f: CacheFixtures = {}, c = new Checks()): Promise<Checks> {
  const key = `conformance:${Date.now()}:${Math.random()}`;
  const value = { a: 1, b: ['x'], c: { d: null } };
  c.expect(await c.attempt('get missing', () => port.get(`${key}:missing`)) === undefined, 'get: a missing key must resolve to undefined');
  await c.attempt('set', () => port.set(key, value));
  c.expect(JSON.stringify(await c.attempt('get', () => port.get(key))) === JSON.stringify(value), 'get: must return the stored value');
  if (port.delete) {
    await c.attempt('delete', () => port.delete!(key));
    c.expect(await c.attempt('get deleted', () => port.get(key)) === undefined, 'delete: key still present');
  }
  if (f.ttl !== false) {
    await c.attempt('set with ttl', () => port.set(`${key}:ttl`, 1, { ttlMs: 30 }));
    await new Promise((r) => setTimeout(r, 120));
    c.expect(await c.attempt('get expired', () => port.get(`${key}:ttl`)) === undefined, 'ttl: value must expire');
  }
  return c;
}
