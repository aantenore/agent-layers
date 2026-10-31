import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const layerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const rootDir = resolve(layerDir, '../..');

try { process.loadEnvFile(resolve(rootDir, '.env')); } catch { /* .env is optional */ }

export const baseUrl = (process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/$/, '');
export const model = process.env.LLM_MODEL ?? 'qwen3:4b';
export const env = { ...process.env, REINLOOP_MODEL: `ollama/${model}`, OLLAMA_BASE_URL: baseUrl };

/** Returns undefined when the model is served, otherwise the reason to skip. */
export async function llmSkipReason() {
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

/** Returns a reason when this reinloop has no L9 support (older install or REINLOOP_SRC unset). */
export function evalSkipReason(reinloop) {
  if (typeof reinloop.layerSignals !== 'function' || typeof reinloop.evaluate !== 'function') {
    return 'this reinloop has no L9 evaluation API; set REINLOOP_SRC to a newer checkout';
  }
}
