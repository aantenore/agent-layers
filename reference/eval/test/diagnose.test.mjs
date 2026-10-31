import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { compose, LAYERS, resolveProfile, validate } from '@agent-layers/core';
import { adapter as basicRuntime } from '@agent-layers/adapter-basic-runtime';
import { adapter as functions, createFunctionTools, defineTool } from '@agent-layers/adapter-functions';
import { adapter as layerSignals } from '@agent-layers/adapter-layer-signals';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { createAgentStack, layerScores } from '../agent-provider.mjs';
import { baseUrl, llmSkipReason, model } from './helpers.mjs';

const LAYER_IDS = LAYERS.map((l) => l.layer);
const QUESTION = 'Where is order 42?';

const VERDICT = {
  type: 'object',
  properties: { runId: { type: 'string' }, layer: { enum: LAYER_IDS }, evidence: { type: 'string' }, fix: { type: 'string' } },
  required: ['runId', 'layer', 'evidence', 'fix'],
  additionalProperties: false,
};

/** Runs an agent whose only tool fails, stores its events under <dir>/runs and returns the run with its health scores. */
async function failingRun(dir) {
  const failing = defineTool({
    name: 'lookup_order',
    description: 'Look up an order by id',
    risk: 'read',
    params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run() {
      throw new Error('orders service unavailable (HTTP 503)');
    },
  });
  const orders = { ...functions, create: () => createFunctionTools({ tools: [failing] }) };
  const stack = await compose(resolveProfile({
    layers: {
      model: { adapter: 'mock-model', options: { rules: [{ match: 'order (\\d+)', tool: 'lookup_order', args: { id: '{{1}}' } }] } },
      runtime: { adapter: 'basic-runtime' },
      tools: { orders: { adapter: 'functions' } },
      eval: [{ adapter: 'layer-signals' }],
    },
    agents: { support: { instructions: 'Look orders up.', model: 'mock', tools: ['orders__*'] } },
  }), { adapters: [mockModel, basicRuntime, orders, layerSignals] });
  try {
    const run = await (await stack.agent('support')).run(QUESTION);
    const logPath = `runs/${run.runId}.jsonl`;
    await mkdir(join(dir, 'runs'), { recursive: true });
    await writeFile(join(dir, logPath), `${(run.events ?? []).map((e) => JSON.stringify(e)).join('\n')}\n`);
    return { run, logPath, layers: await layerScores(stack, QUESTION, run), scores: (await Promise.all(stack.ports.eval.map((e) => e.score({ id: 'order', input: QUESTION }, run)))).flat() };
  } finally {
    await stack.close();
  }
}

/** The JSON object in a model answer, with or without a code fence or leading text. */
function parseVerdict(text) {
  const body = text.replace(/```(?:json)?/g, '');
  return JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
}

test('eval: a failing tool run is attributed to the tool layer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eval-'));
  try {
    const { scores } = await failingRun(dir);
    const health = scores.filter((s) => s.metric.endsWith('_health'));
    const lowest = health.reduce((a, b) => (b.value < a.value ? b : a));
    assert.equal(lowest.layer, 'tool');
    assert.equal(lowest.value, 0);
    assert.match(lowest.reason, /lookup_order/);
    const attributed = scores.find((s) => s.metric === 'attributed');
    assert.equal(attributed.layer, 'tool');
    assert.deepEqual((await checkAdapter(layerSignals)).failures, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('eval: the diagnose agent returns a schema-valid verdict for a failed run', { timeout: 300_000 }, async (t) => {
  const why = await llmSkipReason();
  if (why) return t.skip(`SKIPPED: ${why}`);

  const dir = await mkdtemp(join(tmpdir(), 'eval-'));
  let stack;
  try {
    const failed = await failingRun(dir);
    assert.ok((await readFile(join(dir, failed.logPath), 'utf8')).includes('"ok":false'), 'the log is on disk');

    stack = await createAgentStack('diagnose', { cwd: dir, baseUrl, model });
    const res = await (await stack.agent('diagnose')).run(JSON.stringify({ runId: failed.run.runId, logPath: failed.logPath, scores: failed.layers }));
    assert.equal(res.status, 'completed', `status ${res.status}: ${res.reason?.code ?? ''}`);

    // The schema is the contract; the small model may pick the wrong layer.
    const v = parseVerdict(res.output);
    assert.deepEqual(validate(VERDICT, v, 'verdict'), []);
    for (const key of ['runId', 'evidence', 'fix']) assert.ok(v[key].length > 0, `${key} is empty`);
    t.diagnostic(`diagnosed layer: ${v.layer} (expected tool)`);
  } finally {
    await stack?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
