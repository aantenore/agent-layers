// promptfoo custom provider: runs a reinloop agent in-process and reports output, token usage, cost and per-layer scores.
// Config (promptfooconfig.yaml):  providers: [{ id: file://reinloop-provider.mjs, config: { agent: smoke } }]
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reinloop } from '../../lib/reinloop.mjs';

const here = dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(resolve(here, '../../.env')); } catch { /* .env is optional */ }

export default class ReinloopProvider {
  /** @param {{ id?: string, config?: { agent?: string, agentsDir?: string, cwd?: string, model?: string } }} options */
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.providerId = options.id ?? `reinloop:${this.config.agent ?? 'default'}`;
    this.runtime = undefined;
  }

  id() {
    return this.providerId;
  }

  async #load() {
    if (!this.runtime) {
      const baseUrl = (process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/$/, '');
      const model = this.config.model ?? `ollama/${process.env.LLM_MODEL ?? 'qwen3:4b'}`;
      this.runtime = await reinloop.loadProject({
        cwd: resolve(here, this.config.cwd ?? '.'),
        agentsDir: [resolve(here, this.config.agentsDir ?? 'agents')],
        env: { ...process.env, REINLOOP_MODEL: model, OLLAMA_BASE_URL: baseUrl },
      });
    }
    return this.runtime;
  }

  async callApi(prompt) {
    try {
      const runtime = await this.#load();
      const events = [];
      const handle = await runtime.stream(this.config.agent, prompt);
      for await (const ev of handle) events.push(ev);
      const res = await handle.result;

      const metadata = { runId: res.runId, status: res.status, turns: res.turns };
      if (typeof reinloop.layerSignals === 'function') {
        const scores = await reinloop.layerSignals().score({ id: res.runId, input: prompt }, { runId: res.runId, output: res.output, status: res.status, events });
        metadata.layers = Object.fromEntries(scores.map((s) => [s.layer, s.value]));
      }
      return {
        output: res.output,
        ...(res.status !== 'completed' && { error: `run ${res.status}${res.reason ? `: ${res.reason}` : ''}` }),
        tokenUsage: { prompt: res.usage.inputTokens, completion: res.usage.outputTokens, total: res.usage.inputTokens + res.usage.outputTokens },
        cost: res.costUsd,
        metadata,
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}
