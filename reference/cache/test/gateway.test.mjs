import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reinloop } from '../../../lib/reinloop.mjs';

try { process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env')); } catch { /* .env is optional */ }

const gatewayUrl = (process.env.GATEWAY_URL ?? 'http://localhost:4000/v1').replace(/\/$/, '');
const gatewayKey = process.env.GATEWAY_KEY ?? 'sk-local-change-me';
const llmUrl = (process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/$/, '');
const params = { maxTokens: 1024, temperature: 0 };
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
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: params.maxTokens, temperature: 0 }),
    signal: AbortSignal.timeout(200_000),
  });
  assert.equal(res.status, 200, `gateway answered HTTP ${res.status} for ${model}`);
  return { headers: res.headers, body: await res.json() };
}

const gateway = () => reinloop.openaiCompatible({ name: 'gateway', baseUrl: gatewayUrl, apiKey: gatewayKey });
const modelRef = (model) => ({ provider: gateway(), model, params });

test('cache: a reinloop agent completes through the gateway', { timeout: 240_000 }, async (t) => {
  const reason = await skipReason();
  if (reason) return t.skip(`SKIPPED: ${reason}`);
  const agent = reinloop.agent({ model: modelRef('default'), instructions: 'Answer in one short sentence.' });
  const result = await agent.run(`Name one primary color. (${nonce}-agent)`);
  assert.equal(result.status, 'completed', `status ${result.status}: ${result.reason ?? ''}`);
  assert.ok(result.output.trim().length > 0, 'empty output');
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
  const agent = reinloop.agent({ model: modelRef('fallback-test'), instructions: 'Answer in one short sentence.' });
  const result = await agent.run(`Name one color. (${nonce}-fallback-agent)`);
  assert.equal(result.status, 'completed', `status ${result.status}: ${result.reason ?? ''}`);
});

test('cache: ruleRouter picks the model per request, visible in the events', { timeout: 240_000 }, async (t) => {
  const reason = await skipReason();
  if (reason) return t.skip(`SKIPPED: ${reason}`);
  const router = reinloop.ruleRouter({ rules: [{ when: { hasTools: true }, model: 'fallback-test' }], default: 'default' });
  const resolve = (spec) => modelRef(spec);
  const noop = reinloop.defineTool({ name: 'noop', description: 'Does nothing.', risk: 'read', schema: { type: 'object', properties: {} }, run: () => 'ok' });

  const modelsOf = async (tools, prompt) => {
    const sink = reinloop.collectSink();
    const base = { name: 'routed', model: modelRef('default'), tools, budget: { maxTurns: 1 } };
    const routed = reinloop.withRouter(base, { router, resolve });
    await reinloop.run(routed, prompt, { sinks: [sink] });
    const pick = (type) => sink.events.filter((e) => e.type === type).map((e) => e.data.model);
    return { requested: pick('model_request'), answered: pick('model_response') };
  };

  const plain = await modelsOf([], `Say hi. (${nonce}-route-a)`);
  assert.deepEqual(plain.requested, ['default']);
  assert.deepEqual(plain.answered, ['default']);
  const withTools = await modelsOf([noop], `Say hi. (${nonce}-route-b)`);
  assert.deepEqual(withTools.requested, ['fallback-test']);
  assert.deepEqual(withTools.answered, ['fallback-test']);
});
