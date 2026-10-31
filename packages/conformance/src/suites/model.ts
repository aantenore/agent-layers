import { assembleDeltas, callsOf, type CachePort, type ModelDelta, type ModelPort, type ModelReply, type ModelRequest, type RouterPort } from '@agent-layers/core';
import { Checks, testContext } from '../check.ts';
import { conforms } from '../schemas.ts';

export interface ModelFixtures {
  model?: string;
  prompt?: string;
  /** Offer one tool with toolMode=required and expect a call part (default false). */
  toolCall?: boolean;
  /** Check that an aborted signal rejects (default true). */
  abort?: boolean;
  timeoutMs?: number;
}

const userMessage = (text: string): ModelRequest['messages'][number] => ({ role: 'user', parts: [{ type: 'text', text }] });

export async function checkModel(port: ModelPort, f: ModelFixtures = {}, c = new Checks()): Promise<Checks> {
  const model = f.model ?? 'test';
  const req: ModelRequest = { model, messages: [userMessage(f.prompt ?? 'Reply with the single word OK.')], settings: { maxOutputTokens: 64 } };
  const res = await c.attempt('chat', () => port.chat(req, testContext()), f.timeoutMs);
  if (res) {
    c.all(conforms('model-reply', res), 'model reply');
    c.produced('chat', res);
    const parts = res.message?.parts ?? [];
    c.expect(parts.some((p) => p.type === 'text' || p.type === 'call'), 'chat: the reply has neither text nor call parts');
    c.expect((res.finish === 'tools') === parts.some((p) => p.type === 'call'), 'chat: finish must be "tools" exactly when the reply has call parts');
  }
  if (port.stream) {
    const deltas = await c.attempt('stream', async () => {
      const out: ModelDelta[] = [];
      for await (const d of port.stream!(req, testContext())) out.push(d);
      return out;
    }, f.timeoutMs);
    if (deltas) {
      c.expect(deltas.length > 0, 'stream: yielded no deltas');
      deltas.forEach((d, i) => c.all(conforms('model-delta', d), `stream delta[${i}]`));
      const ends = deltas.filter((d) => d.type === 'end');
      c.expect(ends.length === 1 && deltas[deltas.length - 1]?.type === 'end', `stream: must end with exactly one end delta (found ${ends.length})`);
      c.produced('stream', deltas);
      c.all(conforms('model-reply', assembleDeltas(deltas, model)), 'assembled stream');
    }
  } else c.skip('stream: not implemented (optional)');
  if (f.toolCall) {
    const tooled: ModelReply | undefined = await c.attempt('chat with tools', () => port.chat({
      ...req, messages: [userMessage('What time is it? Use the tool.')],
      tools: [{ name: 'get_time', description: 'Current time', params: { type: 'object', properties: {} } }],
      toolMode: 'required',
    }, testContext()), f.timeoutMs);
    if (tooled) {
      c.produced('chat with tools', tooled);
      const call = callsOf(tooled.message)[0];
      if (c.expect(call, 'chat with tools: expected a call part')) {
        c.expect(call!.tool === 'get_time', `chat with tools: called "${call!.tool}"`);
        c.expect(!!call!.args && typeof call!.args === 'object' && !Array.isArray(call!.args), 'chat with tools: args must be an object');
        c.expect(call!.invalid === undefined, 'chat with tools: the arguments did not parse (invalid is set)');
      }
    }
  }
  if (f.abort !== false) {
    const ac = new AbortController();
    ac.abort();
    await c.rejects('chat with an aborted signal', () => port.chat(req, testContext({ signal: ac.signal })));
  }
  return c;
}

export interface RouterFixtures { requests?: ModelRequest[]; expect?: string[] }

export async function checkRouter(port: RouterPort, f: RouterFixtures = {}, c = new Checks()): Promise<Checks> {
  const reqs = f.requests ?? [{ model: 'default', messages: [userMessage('hello')] }];
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
  const stored = await c.attempt('get', () => port.get(key));
  c.expect(JSON.stringify(stored) === JSON.stringify(value), 'get: must return the stored value');
  c.produced('get', stored);
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
