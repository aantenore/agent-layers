import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, resolveProfile } from '@agent-layers/core';
import { adapter as functions, defineTool } from '@agent-layers/adapter-functions';
import { adapter as openai } from '@agent-layers/adapter-openai-compatible';
import { adapter } from '../src/index.ts';

const base = (process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/+$/, '');
const model = process.env.LLM_MODEL ?? 'qwen3:4b';

const lookup = defineTool({
  name: 'ferry_time', description: 'Departure time of the ferry to a harbour', risk: 'read',
  inputSchema: { type: 'object', properties: { harbour: { type: 'string' } }, required: ['harbour'] },
  run: async () => 'The ferry leaves at 07:40.',
});

test('live: a reinloop run on a real model through the governed stack', { timeout: 300_000 }, async (t) => {
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return t.skip(`${base}/models answered HTTP ${res.status}`);
    const ids = ((await res.json() as { data?: { id: string }[] }).data ?? []).map((m) => m.id);
    if (!ids.includes(model)) return t.skip(`model ${model} is not available at ${base}`);
  } catch {
    return t.skip(`${base} is not reachable`);
  }
  const tools = { ...functions, create: () => functions.create({ tools: [lookup] }, { name: 'port', env: {}, cwd: process.cwd(), telemetry: undefined as never }) };
  const s = await compose(resolveProfile({
    layers: {
      model: { adapter: 'openai-compatible', options: { baseUrl: base, ...(process.env.LLM_API_KEY ? { apiKey: process.env.LLM_API_KEY } : {}) } },
      runtime: { adapter: 'reinloop', options: { budget: { maxTurns: 6 } } },
      tools: { port: { adapter: 'functions' } },
    },
    agents: { clerk: { instructions: 'Answer briefly. Use the ferry_time tool for ferry questions.', model, tools: ['port__*'], params: { temperature: 0 } } },
  }), { adapters: [openai, adapter, tools] });
  try {
    const r = await (await s.agent('clerk')).run('When does the ferry to Quillmere leave? /no_think');
    assert.equal(r.status, 'completed', r.reason);
    assert.ok(r.output.trim().length > 0);
    assert.ok((r.usage?.total_tokens ?? 0) > 0);
    t.diagnostic(`tool calls: ${r.events?.filter((e) => e.type === 'tool_call').length}; output: ${r.output.slice(0, 120)}`);
  } finally {
    await s.close();
  }
});
