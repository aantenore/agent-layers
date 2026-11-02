// Sessions of agent runs (header or `user` field) and the outcome headers of a run that did not complete.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inboundFetch } from '@agent-layers/conformance';
import type { CallContext, ChannelHost } from '@agent-layers/core';
import { APPROVAL_HEADER, createOpenAICompatibleChannel, RUN_STATUS_HEADER } from '../../src/openai-compatible/index.ts';

const caller = { id: 'alice', kind: 'user' as const, roles: [], scopes: [] };
const seen: Partial<CallContext>[] = [];
const host: ChannelHost = {
  agents: () => ['assistant'],
  async run(_agent, input, ctx = {}) {
    seen.push(ctx);
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    if (text.includes('pay')) return { runId: 'r', status: 'waiting', output: '', reason: { code: 'needs_input', layer: 'identity', detail: 'ap-1' }, ext: { 'sdk.approval': { id: 'ap-1' } } };
    return { runId: 'r', status: 'completed', output: 'ok' };
  },
};

const send = (mount: Awaited<ReturnType<NonNullable<ReturnType<typeof createOpenAICompatibleChannel>['mount']>>>, body: object, headers: Record<string, string> = {}) =>
  inboundFetch(mount, new Request('http://gw.test/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model: 'agent:assistant', ...body }),
  }), { caller });

const messages = (content: string) => ({ messages: [{ role: 'user', content }] });

test('the Agent-Session header carries the session, scoped to the caller; malformed values are ignored', async () => {
  const mount = await createOpenAICompatibleChannel({}).mount!(host);
  await send(mount, messages('hi'), { 'agent-session': 'thread-1' });
  await send(mount, messages('hi'), { 'agent-session': 'thread-1' });
  await send(mount, messages('hi'), { 'agent-session': 'bad value' });
  await send(mount, messages('hi'));
  const [a, b, bad, none] = seen.splice(0).map((c) => c.sessionId);
  assert.match(a!, /^openai-compatible-[0-9a-f]{16}-thread-1$/);
  assert.equal(b, a);
  assert.equal(bad, undefined);
  assert.equal(none, undefined);
});

test('session from the user field, or from a configured header', async () => {
  const byUser = await createOpenAICompatibleChannel({ session: { from: 'user' } }).mount!(host);
  await send(byUser, { ...messages('hi'), user: 'thread-2' }, { 'agent-session': 'ignored' });
  assert.match(seen.pop()!.sessionId!, /-thread-2$/);
  const byHeader = await createOpenAICompatibleChannel({ session: { header: 'X-Conversation' } }).mount!(host);
  await send(byHeader, messages('hi'), { 'x-conversation': 'thread-3' });
  assert.match(seen.pop()!.sessionId!, /-thread-3$/);
});

test('a waiting run answers with its status and approval id in headers; a completed one has neither', async () => {
  const mount = await createOpenAICompatibleChannel({}).mount!(host);
  const waiting = await send(mount, messages('pay the bill'));
  assert.equal(waiting.status, 200);
  assert.equal(waiting.headers.get(RUN_STATUS_HEADER), 'waiting');
  assert.equal(waiting.headers.get(APPROVAL_HEADER), 'ap-1');
  const done = await send(mount, messages('hi'));
  assert.equal(done.headers.get(RUN_STATUS_HEADER), null);
  assert.equal(done.headers.get(APPROVAL_HEADER), null);
});

test('anonymous requests get no session: two clients sending the same Agent-Session do not share one', async () => {
  seen.length = 0;
  const mount = await createOpenAICompatibleChannel({}).mount!(host);
  const anonymous = () => inboundFetch(mount, new Request('http://gw.test/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', 'agent-session': 'shared' }, body: JSON.stringify({ model: 'agent:assistant', ...messages('hi') }),
  }), { caller: undefined });
  await anonymous();
  await anonymous();
  assert.deepEqual(seen.splice(0).map((c) => c.sessionId), [undefined, undefined]);
});

test('the session id uses the host owner digest (keyed with sessions.secret)', async () => {
  const mount = await createOpenAICompatibleChannel({}).mount!({ ...host, ownerDigest: () => 'keyed' });
  await send(mount, messages('hi'), { 'agent-session': 'thread-1' });
  assert.equal(seen.pop()!.sessionId, 'openai-compatible-keyed-thread-1');
});
