import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, defineAdapter, PORT_VERSIONS, resolveProfile, type ChannelPort } from '@agent-layers/core';
import { identityAdapter } from '@agent-layers/adapter-static-identity';
import { BoundsHeaderError, delegationOf, parseAgentBounds, parseAgentLineage, serveStack } from '../src/index.ts';

const MAX = 512;
const FULL = 'remaining-ms=45000, hops=2, max-hops=4, tokens=1000, cost-usd=0.5';

test('Agent-Bounds: required members, optional tokens and cost, whitespace, integer cost', () => {
  assert.deepEqual(parseAgentBounds(FULL, MAX), { remainingMs: 45000, hops: 2, maxHops: 4, tokens: 1000, costUsd: 0.5 });
  assert.deepEqual(parseAgentBounds('remaining-ms=1,hops=0,max-hops=3', MAX), { remainingMs: 1, hops: 0, maxHops: 3 });
  assert.deepEqual(parseAgentBounds('  remaining-ms=1 \t,  hops=0 ,max-hops=3  ', MAX), { remainingMs: 1, hops: 0, maxHops: 3 });
  assert.equal(parseAgentBounds('remaining-ms=1, hops=0, max-hops=3, cost-usd=2', MAX)?.costUsd, 2);
  assert.deepEqual(parseAgentBounds('remaining-ms=1, hops=0, max-hops=3, extra="x"', MAX), { remainingMs: 1, hops: 0, maxHops: 3 }, 'unknown members are ignored');
  assert.equal(parseAgentBounds(undefined, MAX), undefined);
});

test('Agent-Bounds: malformed or invalid values are refused', () => {
  const bad = [
    '', 'remaining-ms=1, hops=0', 'remaining-ms=1.5, hops=0, max-hops=3', 'remaining-ms=-1, hops=0, max-hops=3', 'remaining-ms="1", hops=0, max-hops=3',
    'remaining-ms=1, hops=0, max-hops=3, tokens=1.5', 'remaining-ms=1, hops=0, max-hops=3, cost-usd=-1', 'remaining-ms=1, hops=0, max-hops=3, cost-usd=0.1234',
    'remaining-ms=1, hops=0, max-hops=3;a=1', 'remaining-ms=1;a=1, hops=0, max-hops=3', 'remaining-ms=1, hops=0, max-hops=3,', 'remaining-ms=1 hops=0, max-hops=3',
    'Remaining-Ms=1, hops=0, max-hops=3', 'remaining-ms=1, remaining-ms=2, hops=0, max-hops=3', 'remaining-ms=1, hops, max-hops=3', 'remaining-ms=(1 2), hops=0, max-hops=3',
    'remaining-ms=1234567890123456, hops=0, max-hops=3', 'remaining-ms=abc, hops=0, max-hops=3',
  ];
  for (const v of bad) assert.throws(() => parseAgentBounds(v, MAX), BoundsHeaderError, v);
  assert.throws(() => parseAgentBounds([FULL, FULL], MAX), /repeated/);
  assert.throws(() => parseAgentBounds(FULL, 10), /longer than 10/);
});

test('Agent-Lineage: strings and tokens, either member optional, malformed refused', () => {
  assert.deepEqual(parseAgentLineage('root="run-a1", parent="run-b7"', MAX), { rootRunId: 'run-a1', parentRunId: 'run-b7' });
  assert.deepEqual(parseAgentLineage('root=run-a1,parent=run-b7', MAX), { rootRunId: 'run-a1', parentRunId: 'run-b7' });
  assert.deepEqual(parseAgentLineage('root="a\\"b\\\\c"', MAX), { rootRunId: 'a"b\\c' });
  assert.deepEqual(parseAgentLineage('', MAX), {});
  assert.equal(parseAgentLineage(undefined, MAX), undefined);
  for (const v of ['root=1', 'root="open', 'root="a\\n"', 'root="a";x=1', 'root', 'root="a" parent="b"']) assert.throws(() => parseAgentLineage(v, MAX), BoundsHeaderError, v);
  assert.throws(() => parseAgentLineage(['root="a"', 'root="b"'], MAX), /repeated/);
});

test('delegationOf combines both headers and validates the result', () => {
  assert.deepEqual(delegationOf({ 'agent-bounds': FULL, 'agent-lineage': 'root="r", parent="p"' }, MAX), {
    remainingMs: 45000, hops: 2, maxHops: 4, tokens: 1000, costUsd: 0.5, rootRunId: 'r', parentRunId: 'p',
  });
  assert.equal(delegationOf({}, MAX), undefined);
  assert.equal(delegationOf({ 'agent-lineage': 'root="r"' }, MAX), undefined, 'a lineage alone carries no bounds');
  assert.throws(() => delegationOf({ 'agent-bounds': FULL, 'agent-lineage': 'root=""' }, MAX), /Agent-Lineage/);
  assert.throws(() => delegationOf({ 'agent-lineage': 'root=1' }, MAX), BoundsHeaderError);
});

const echo = defineAdapter<'ChannelPort'>({
  layer: 'interface', port: 'ChannelPort', name: 'bounds-echo', direction: 'inbound', maps: { technology: 'test route' },
  portVersion: PORT_VERSIONS.ChannelPort, tiers: ['prototype'], optionsSchema: { type: 'object' },
  create: (): ChannelPort => ({ mount: () => ({ routes: [{ path: '/bounds', methods: ['GET'], handle: async (_req, ctx) => Response.json(ctx.delegation ?? null) }] }) }),
});

test('the gateway passes the parsed delegation to the route and refuses malformed headers with 400', async () => {
  const stack = await compose(resolveProfile({
    layers: { identity: { adapter: 'static-identity', options: { tokens: { t: { subject: 'u' } } } }, channels: [{ adapter: 'bounds-echo' }] },
  }), { adapters: [identityAdapter, echo] });
  const gw = await serveStack(stack, { port: 0 });
  try {
    const get = (h: Record<string, string>) => fetch(`${gw.url}/bounds`, { headers: { authorization: 'Bearer t', ...h } });
    assert.equal(await get({}).then((r) => r.json()), null);
    assert.deepEqual(await get({ 'agent-bounds': FULL, 'agent-lineage': 'root="run-a1", parent="run-b7"' }).then((r) => r.json()), {
      remainingMs: 45000, hops: 2, maxHops: 4, tokens: 1000, costUsd: 0.5, rootRunId: 'run-a1', parentRunId: 'run-b7',
    });
    const refused: Record<string, string>[] = [{ 'agent-bounds': 'nonsense' }, { 'agent-bounds': 'remaining-ms=1, hops=0' }, { 'agent-bounds': FULL, 'agent-lineage': 'root=1' }, { 'agent-bounds': 'x'.repeat(513) }];
    for (const h of refused) {
      const res = await get(h);
      assert.equal(res.status, 400, JSON.stringify(h).slice(0, 60));
      const body = await res.json() as { error: { message: string; type: string } };
      assert.equal(body.error.type, 'invalid_request_error');
      assert.ok(!body.error.message.includes('nonsense'), 'the value is not echoed');
    }
    const repeated = await get({ 'agent-bounds': `${FULL}, ${FULL}` });
    assert.equal(repeated.status, 400, 'a combined repeated header repeats the keys');
    const raw = await fetch(`${gw.url}/bounds`, { headers: new Headers([['authorization', 'Bearer t'], ['agent-bounds', FULL], ['agent-bounds', FULL]]) });
    assert.equal(raw.status, 400, 'repeated header lines are combined by the transport; repeated keys are refused');
  } finally {
    await gw.close();
    await stack.close();
  }
});
