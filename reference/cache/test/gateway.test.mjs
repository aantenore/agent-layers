import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ATTR, compose, recordingTelemetry, resolveProfile, SPAN } from '@agent-layers/core';
import { adapter as basicRuntime } from '@agent-layers/adapter-basic-runtime';
import { adapter as functions, functionTools } from '@agent-layers/adapter-functions';
import { adapter as openaiCompatible } from '@agent-layers/adapter-openai-compatible';
import { adapter as ruleRouter } from '@agent-layers/adapter-rule-router';

try { process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env')); } catch { /* .env is optional */ }

const gatewayUrl = (process.env.GATEWAY_URL ?? 'http://localhost:4000/v1').replace(/\/$/, '');
const gatewayKey = process.env.GATEWAY_KEY ?? 'sk-local-change-me';
const llmUrl = (process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/$/, '');
const settings = { maxOutputTokens: 1024, temperature: 0 };
const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Returns undefined when the gateway and the model behind it answer, otherwise the reason to skip. */
async function skipReason() {
  try {
    const res = await fetch(`${gatewayUrl}/models`, { headers: { authorization: `Bearer ${gatewayKey}` }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return `gateway ${gatewayUrl} answered HTTP ${res.status} (check GATEWAY_KEY)`;
    const groups = ((await res.json()).data ?? []).map((m) => m.id);
    for (const g of ['default', 'fallback-test']) if (!groups.includes(g)) return `gateway has no model group "${g}"`;
  } catch {
    return `gateway not reachable at ${gatewayUrl}; start it with "make up LAYER=cache"`;
  }
  try {
    await fetch(`${llmUrl}/models`, { signal: AbortSignal.timeout(3000) });
  } catch {
    return `Ollama not reachable at ${llmUrl}; the gateway forwards to it`;
  }
}

/** Raw Chat Completions call returning the response headers, to observe the gateway's own behavior. */
async function complete(model, content) {
  const res = await fetch(`${gatewayUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gatewayKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: settings.maxOutputTokens, temperature: 0 }),
    signal: AbortSignal.timeout(200_000),
  });
  assert.equal(res.status, 200, `gateway answered HTTP ${res.status} for ${model}`);
  return { headers: res.headers, body: await res.json() };
}

/** A stack whose model is the gateway; `layers` adds slots (a router), `tools` adds a tool source named `noop`. */
async function gatewayStack({ layers = {}, agents, tools = [], telemetry = [] }) {
  const config = resolveProfile({
    layers: {
      model: { adapter: 'openai-compatible', options: { baseUrl: gatewayUrl, apiKey: gatewayKey } },
      runtime: { adapter: 'basic-runtime', options: { maxTurns: 1 } },
      ...(tools.length ? { tools: { noop: { adapter: 'functions' } } } : {}),
      ...layers,
    },
    agents: Object.fromEntries(Object.entries(agents).map(([name, a]) => [name, { instructions: 'Answer in one short sentence.', settings, ...a }])),
  });
  const noop = { ...functions, create: () => functionTools(tools, 'noop') };
  return compose(config, { adapters: [openaiCompatible, basicRuntime, ruleRouter, noop], telemetry });
}

const modelsReplied = (result) => result.events.filter((e) => e.type === 'model.reply').map((e) => e.model);

test('cache: an agent completes through the gateway', { timeout: 240_000 }, async (t) => {
  const reason = await skipReason();
  if (reason) return t.skip(`SKIPPED: ${reason}`);
  const stack = await gatewayStack({ agents: { plain: { model: 'default' } } });
  try {
    const result = await (await stack.agent('plain')).run(`Name one primary color. (${nonce}-agent)`);
    assert.equal(result.status, 'completed', `status ${result.status}: ${result.reason?.code ?? ''}`);
    assert.ok(result.output.trim().length > 0, 'empty output');
  } finally {
    await stack.close();
  }
});

test('cache: an identical second request is served from the Valkey cache', { timeout: 240_000 }, async (t) => {
  const reason = await skipReason();
  if (reason) return t.skip(`SKIPPED: ${reason}`);
  const prompt = `Name one fruit. (${nonce}-cache)`;
  const first = await complete('default', prompt);
  const second = await complete('default', prompt);
  // LiteLLM adds x-litellm-cache-key only to responses it served from the cache.
  assert.equal(first.headers.get('x-litellm-cache-key'), null, 'first request must be a cache miss');
  assert.match(second.headers.get('x-litellm-cache-key') ?? '', /^[0-9a-f]{64}$/, 'second request must be a cache hit');
  assert.equal(second.body.id, first.body.id, 'a cache hit replays the stored response');
});

test('cache: the fallback group is answered by its fallback', { timeout: 240_000 }, async (t) => {
  const reason = await skipReason();
  if (reason) return t.skip(`SKIPPED: ${reason}`);
  const { headers, body } = await complete('fallback-test', `Name one animal. (${nonce}-fallback)`);
  assert.equal(headers.get('x-litellm-attempted-fallbacks'), '1');
  assert.ok(body.choices?.length > 0, 'no choices in the fallback answer');
  const stack = await gatewayStack({ agents: { fallback: { model: 'fallback-test' } } });
  try {
    const result = await (await stack.agent('fallback')).run(`Name one color. (${nonce}-fallback-agent)`);
    assert.equal(result.status, 'completed', `status ${result.status}: ${result.reason?.code ?? ''}`);
  } finally {
    await stack.close();
  }
});

test('cache: the rule-router adapter picks the model per request, visible in telemetry and events', { timeout: 240_000 }, async (t) => {
  const reason = await skipReason();
  if (reason) return t.skip(`SKIPPED: ${reason}`);
  const records = [];
  const stack = await gatewayStack({
    layers: { router: { adapter: 'rule-router', options: { rules: [{ when: { hasTools: true }, model: 'fallback-test' }], default: 'default' } } },
    tools: [{ name: 'noop', description: 'Does nothing.', risk: 'read', params: { type: 'object', properties: {} }, run: () => 'ok' }],
    agents: { plain: { model: 'default' }, tooled: { model: 'default', tools: ['noop__*'] } },
    telemetry: [recordingTelemetry((r) => records.push(r))],
  });
  try {
    const routed = () => records.filter((r) => r.type === 'span' && r.name === SPAN.routerSelect).map((r) => r.attrs[ATTR.routerModel]);
    const plain = await (await stack.agent('plain')).run(`Say hi. (${nonce}-route-a)`);
    assert.deepEqual(routed(), ['default']);
    assert.deepEqual(modelsReplied(plain), ['default']);
    const tooled = await (await stack.agent('tooled')).run(`Say hi. (${nonce}-route-b)`);
    assert.deepEqual(routed(), ['default', 'fallback-test']);
    assert.deepEqual(modelsReplied(tooled), ['fallback-test']);
  } finally {
    await stack.close();
  }
});
