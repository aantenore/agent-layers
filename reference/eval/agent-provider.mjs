// promptfoo custom provider: runs an agent of the agent-layers SDK in-process through a composed stack and reports
// output, token usage, cost and per-layer scores.
// Config (promptfooconfig.yaml):  providers: [{ id: file://agent-provider.mjs, config: { agent: smoke } }]
import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose, resolveProfile } from '@agent-layers/core';
import { adapter as basicRuntime } from '@agent-layers/adapter-basic-runtime';
import { adapter as functions, createFunctionTools, defineTool } from '@agent-layers/adapter-functions';
import { adapter as layerSignals } from '@agent-layers/adapter-layer-signals';
import { adapter as openaiCompatible } from '@agent-layers/adapter-openai-compatible';

const here = dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(resolve(here, '../../.env')); } catch { /* .env is optional */ }

const MAX_TURNS = 6;
const SETTINGS = { temperature: 0, maxOutputTokens: 2048 };
const MAX_FILE_CHARS = 16_000;

/** `read_file`: reads a text file below `root`; paths outside it are refused. */
export function readFileTool(root) {
  return defineTool({
    name: 'read_file',
    description: 'Read a text file by its path',
    risk: 'read',
    params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    async run({ path }) {
      const file = resolve(root, String(path));
      if (file !== root && !file.startsWith(root + sep)) throw new Error(`path outside ${root}`);
      return (await readFile(file, 'utf8')).slice(0, MAX_FILE_CHARS);
    },
  });
}

/** Instructions of an agent: the body of `<agentsDir>/<name>.md` (the part after the front matter). */
export async function loadInstructions(name, agentsDir = resolve(here, 'agents')) {
  const text = await readFile(resolve(agentsDir, `${name}.md`), 'utf8');
  return (/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(text)?.[1] ?? text).trim();
}

/**
 * A composed stack with one agent: openai-compatible model, basic runtime, a `read_file` tool and the layer-signals
 * evaluator. `baseUrl`, `model` and `apiKey` default to LLM_BASE_URL, LLM_MODEL and LLM_API_KEY.
 */
export async function createAgentStack(agent, { agentsDir, cwd = here, baseUrl, model, apiKey } = {}) {
  const url = (baseUrl ?? process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/$/, '');
  const modelId = model ?? process.env.LLM_MODEL ?? 'qwen3:4b';
  const key = apiKey ?? process.env.LLM_API_KEY;
  const files = { ...functions, create: () => createFunctionTools({ tools: [readFileTool(resolve(cwd))] }) };
  return compose(resolveProfile({
    layers: {
      model: { adapter: 'openai-compatible', options: { baseUrl: url, ...(key ? { apiKey: key } : {}) } },
      runtime: { adapter: 'basic-runtime', options: { maxTurns: MAX_TURNS } },
      tools: { files: { adapter: 'functions' } },
      eval: [{ adapter: 'layer-signals' }],
    },
    agents: { [agent]: { instructions: await loadInstructions(agent, agentsDir), model: modelId, tools: ['files__*'], settings: SETTINGS } },
  }), { adapters: [openaiCompatible, basicRuntime, files, layerSignals] });
}

/** `<layer>_health` scores of a run by layer (1 = healthy). */
export async function layerScores(stack, input, run) {
  const scores = (await Promise.all(stack.ports.eval.map((e) => e.score({ id: run.runId, input }, run)))).flat();
  return Object.fromEntries(scores.filter((s) => s.layer && s.metric.endsWith('_health')).map((s) => [s.layer, s.value]));
}

export default class AgentProvider {
  /** @param {{ id?: string, config?: { agent?: string, agentsDir?: string, cwd?: string, model?: string, baseUrl?: string } }} options */
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.providerId = options.id ?? `agent-layers:${this.config.agent ?? 'default'}`;
    this.stack = undefined;
  }

  id() {
    return this.providerId;
  }

  async #load() {
    this.stack ??= await createAgentStack(this.config.agent, {
      agentsDir: resolve(here, this.config.agentsDir ?? 'agents'),
      cwd: resolve(here, this.config.cwd ?? '.'),
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.baseUrl ? { baseUrl: this.config.baseUrl } : {}),
    });
    return this.stack;
  }

  async cleanup() {
    await this.stack?.close();
    this.stack = undefined;
  }

  async callApi(prompt) {
    try {
      const stack = await this.#load();
      const res = await (await stack.agent(this.config.agent)).run(prompt);
      const usage = res.usage ?? { inputTokens: 0, outputTokens: 0 };
      return {
        output: res.output,
        ...(res.status !== 'completed' && { error: `run ${res.status}${res.reason ? `: ${res.reason.code}${res.reason.detail ? ` ${res.reason.detail}` : ''}` : ''}` }),
        tokenUsage: { prompt: usage.inputTokens, completion: usage.outputTokens, total: usage.inputTokens + usage.outputTokens },
        cost: res.costUsd,
        metadata: { runId: res.runId, status: res.status, layers: await layerScores(stack, prompt, res) },
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}
