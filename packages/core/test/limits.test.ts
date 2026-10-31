import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AdapterRegistry, ConfigError, defineAdapter, defineLimits, knowledgeTools, limitFindings, limitProperties, limitValue, noopTelemetry, parseConfig,
  PORT_VERSIONS, readiness, resolveProfile, STACK_LIMITS, type StackConfig,
} from '../src/index.ts';

const LIMITS = defineLimits({
  timeoutMs: { path: 'options.timeoutMs', default: 1000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 5000 } },
  k: { path: 'options.k', default: 4, unit: 'count', min: 1 },
  itemMs: { path: 'options.items.*.timeoutMs', default: null, fallback: 'options.timeoutMs', unit: 'ms', min: 1, unbounded: 'warn' },
});

let seen: Record<string, unknown> = {};
const limited = defineAdapter({
  port: 'ToolPort', layer: 'tool', name: 'limited', direction: 'outbound', maps: { technology: 'test double' },
  portVersion: PORT_VERSIONS.ToolPort, tiers: ['prototype', 'production'],
  optionsSchema: { type: 'object', properties: { ...limitProperties(LIMITS), items: { type: 'object' } }, additionalProperties: false },
  limits: LIMITS,
  create: (o: Record<string, unknown>) => { seen = o; return { listTools: async () => [], callTool: async () => ({ ok: true, text: '' }) }; },
});
const ctx = { name: 'limited', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };

test('defineLimits rejects a default outside the range or an unbounded default that is not allowed', () => {
  assert.throws(() => defineLimits({ x: { path: 'options.x', default: 0, unit: 'ms', min: 1 } }), /outside/);
  assert.throws(() => defineLimits({ x: { path: 'options.x', default: 'unbounded', unit: 'ms', min: 1 } }), /not allowed/);
});

test('limitValue: configured over default, unbounded as Infinity, numeric strings as numbers', () => {
  assert.equal(limitValue(LIMITS.timeoutMs, undefined), 1000);
  assert.equal(limitValue(LIMITS.timeoutMs, 250), 250);
  assert.equal(limitValue(LIMITS.timeoutMs, '250'), 250);
  assert.equal(limitValue(LIMITS.timeoutMs, 'unbounded'), Infinity);
});

test('the registry coerces ${env} strings at limit paths and validates ranges before create', async () => {
  const r = new AdapterRegistry().register(limited);
  await r.create('ToolPort', 'limited', { timeoutMs: '300', items: { a: { timeoutMs: '50' } } }, ctx);
  assert.deepEqual(seen, { timeoutMs: 300, items: { a: { timeoutMs: 50 } } });
  await assert.rejects(r.create('ToolPort', 'limited', { timeoutMs: 0 }, ctx), /options\.timeoutMs: must be >= 1/);
  await assert.rejects(r.create('ToolPort', 'limited', { k: 'unbounded' }, ctx), /options\.k/);
  await assert.rejects(r.create('ToolPort', 'limited', { items: { a: { timeoutMs: -5 } } }, ctx), /options\.items\.a\.timeoutMs/);
  await r.create('ToolPort', 'limited', { timeoutMs: 'unbounded' }, ctx);
});

test('limitFindings: only on the production tier; unbounded by severity, outside the safe range as a warning', () => {
  const root = { options: { timeoutMs: 'unbounded', items: { a: { timeoutMs: 'unbounded' } } } };
  assert.deepEqual(limitFindings(Object.values(LIMITS), root, 'prototype'), []);
  const found = limitFindings(Object.values(LIMITS), root, 'production', 'layers.tools.x.');
  assert.deepEqual(found.map((f) => `${f.severity} ${f.path}`), ['fail layers.tools.x.options.timeoutMs', 'warn layers.tools.x.options.items.a.timeoutMs']);
  const high = limitFindings(Object.values(LIMITS), { options: { timeoutMs: 9000 } }, 'production');
  assert.deepEqual(high.map((f) => f.severity), ['warn']);
  assert.match(high[0]!.message, /above the safe range 1–5000 ms/);
  assert.deepEqual(limitFindings(Object.values(LIMITS), { options: {} }, 'production'), [], 'defaults are inside the safe range');
});

test('stack config limits: defaults, ${env} values, unbounded only where allowed, ranges checked after interpolation', () => {
  const c = parseConfig(JSON.stringify({ gateway: { maxBodyBytes: '${env:BODY}', requestTimeoutMs: 'unbounded' }, pipeline: { knowledge: { k: '${env:K:-6}' } }, limits: { check: { timeoutMs: 100 } } }), { env: { BODY: '2048' } });
  assert.equal(c.gateway.maxBodyBytes, 2048);
  assert.equal(c.gateway.requestTimeoutMs, 'unbounded');
  assert.equal(c.pipeline.knowledge?.k, 6);
  assert.equal(c.limits.check?.timeoutMs, 100);
  assert.throws(() => parseConfig(JSON.stringify({ gateway: { maxBodyBytes: '${env:BODY}' } }), { env: { BODY: '0' } }), (e: unknown) => e instanceof ConfigError && /gateway\.maxBodyBytes: must be >= 1/.test(e.message));
  assert.throws(() => parseConfig(JSON.stringify({ gateway: { maxBodyBytes: '${env:BODY}' } }), { env: { BODY: 'lots' } }), /gateway\.maxBodyBytes/);
  assert.throws(() => parseConfig(JSON.stringify({ gateway: { closeGraceMs: 'unbounded' } })), /gateway\.closeGraceMs/);
  assert.throws(() => parseConfig(JSON.stringify({ pipeline: { knowledge: { maxChars: 10 } } })), /maxChars/);
  assert.throws(() => parseConfig(JSON.stringify({ limits: { nope: 1 } })), /limits\.nope: unknown property/);
});

test('profiles deep-merge limits; null restores the default', () => {
  const config: StackConfig = {
    gateway: { maxBodyBytes: 4096, requestTimeoutMs: 1000 }, limits: { check: { timeoutMs: 10 } },
    profiles: { p: { gateway: { maxBodyBytes: null as never }, limits: { check: { deployTimeoutMs: 20 } } } },
  };
  const r = resolveProfile(config, 'p');
  assert.deepEqual(r.gateway, { requestTimeoutMs: 1000 });
  assert.deepEqual(r.limits, { check: { timeoutMs: 10, deployTimeoutMs: 20 } });
});

test('readiness: unbounded gateway and adapter limits fail a production profile; out-of-range values only warn', async () => {
  const registry = new AdapterRegistry().register(limited);
  const config: StackConfig = {
    layers: { tools: { t: { adapter: 'limited', options: { timeoutMs: 9000 } } } },
    profiles: {
      prod: { tier: 'production', requires: [] },
      open: { extends: 'prod', gateway: { maxBodyBytes: 'unbounded' } },
      proto: { gateway: { maxBodyBytes: 'unbounded' } },
    },
  };
  const prod = await readiness(resolveProfile(config, 'prod'), registry);
  assert.equal(prod.ok, true);
  assert.deepEqual(prod.limits.map((l) => `${l.severity} ${l.path}`), ['warn layers.tools.t.options.timeoutMs']);
  const open = await readiness(resolveProfile(config, 'open'), registry);
  assert.equal(open.ok, false);
  assert.ok(open.limits.some((l) => l.severity === 'fail' && l.path === 'gateway.maxBodyBytes'));
  assert.deepEqual((await readiness(resolveProfile(config, 'proto'), registry)).limits, []);
});

test('every stack limit default sits inside its accepted and safe range', () => {
  for (const s of STACK_LIMITS) {
    if (typeof s.default !== 'number') continue;
    assert.ok(s.default >= (s.safe?.min ?? s.min) && s.default <= (s.safe?.max ?? s.max ?? Infinity), s.path);
  }
});

test('knowledge tools: k and maxK from the pipeline; a larger k from the model is capped', async () => {
  const asked: number[] = [];
  const tools = knowledgeTools({ docs: { search: async (q) => { asked.push(q.k!); return []; } } }, { k: 3, maxK: 5 });
  const [spec] = await tools.listTools({ runId: 'r', agent: 'a' });
  assert.equal((spec!.params.properties as Record<string, { maximum: number }>).k!.maximum, 5);
  await tools.callTool('docs', { query: 'q' }, { runId: 'r', agent: 'a' });
  await tools.callTool('docs', { query: 'q', k: 50 }, { runId: 'r', agent: 'a' });
  assert.deepEqual(asked, [3, 5]);
});
