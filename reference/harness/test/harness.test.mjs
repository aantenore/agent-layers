import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reinloop } from '../../../lib/reinloop.mjs';

try { process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env')); } catch { /* .env is optional */ }

const baseUrl = (process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/$/, '');
const model = process.env.LLM_MODEL ?? 'qwen3:4b';
const agentsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../agents');

/** Returns undefined when the model is served, otherwise the reason to skip. */
async function skipReason() {
  let ids;
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return `LLM endpoint ${baseUrl} answered HTTP ${res.status}`;
    ids = ((await res.json()).data ?? []).map((m) => m.id);
  } catch {
    return `Ollama not reachable at ${baseUrl}; start it with "ollama serve"`;
  }
  if (!ids.includes(model)) return `model "${model}" is not available at ${baseUrl}; run "ollama pull ${model}"`;
}

test('harness: reinloop answers a trivial prompt through the llm model', { timeout: 180_000 }, async (t) => {
  const reason = await skipReason();
  if (reason) return t.skip(`SKIPPED: ${reason}`);

  const runtime = await reinloop.loadProject({
    cwd: agentsDir,
    agentsDir: [agentsDir],
    env: { ...process.env, REINLOOP_MODEL: `ollama/${model}`, OLLAMA_BASE_URL: baseUrl },
  });
  try {
    const result = await runtime.run('assistant', 'Reply with the single word: pong');
    assert.equal(result.status, 'completed', `status ${result.status}: ${result.reason ?? ''}`);
    assert.ok(result.output.trim().length > 0, 'empty output');
  } finally {
    await runtime.close();
  }
});
