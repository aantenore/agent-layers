import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { reinloop } from '../../../lib/reinloop.mjs';
import { env, evalSkipReason, layerDir, llmSkipReason } from './helpers.mjs';

const LAYERS = ['infra', 'llm', 'harness', 'knowledge', 'tool', 'identity', 'guardrail', 'cache', 'telemetry', 'eval'];

/** Runs an agent whose only tool fails, stores the log under <dir>/.reinloop/runs and returns what the evaluators see. */
async function failingRun(dir) {
  const failing = reinloop.defineTool({
    name: 'lookup_order',
    description: 'Look up an order by id',
    risk: 'read',
    schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run() {
      throw new Error('orders service unavailable (HTTP 503)');
    },
  });
  const agent = {
    name: 'support',
    model: { provider: reinloop.mockProvider([{ toolCalls: [{ name: 'lookup_order', args: { id: '42' } }] }, { text: 'I could not look up your order.' }]), model: 'mock' },
    tools: [failing],
  };
  const events = [];
  const store = reinloop.fileStore(join(dir, '.reinloop/runs'));
  const res = await reinloop.run(agent, 'Where is order 42?', { store, sinks: [{ onEvent: (e) => void events.push(e) }] });
  return { runId: res.runId, output: res.output, status: res.status, events };
}

test('L9: a failing tool run is attributed to the tool layer', async (t) => {
  const why = evalSkipReason(reinloop);
  if (why) return t.skip(`SKIPPED: ${why}`);

  const dir = await mkdtemp(join(tmpdir(), 'l9-'));
  try {
    const run = await failingRun(dir);
    const scores = await reinloop.layerSignals().score({ id: 'order', input: 'Where is order 42?' }, run);
    const lowest = scores.reduce((a, b) => (b.value < a.value ? b : a));
    assert.equal(lowest.layer, 'tool');
    assert.equal(lowest.value, 0);
    assert.match(lowest.reason, /orders service unavailable/);
    assert.deepEqual(await reinloop.checkEvaluator(reinloop.layerSignals()), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('L9: the diagnose agent returns a schema-valid verdict for a failed run', { timeout: 300_000 }, async (t) => {
  const why = evalSkipReason(reinloop) ?? (await llmSkipReason());
  if (why) return t.skip(`SKIPPED: ${why}`);

  const dir = await mkdtemp(join(tmpdir(), 'l9-'));
  let runtime;
  try {
    const failed = await failingRun(dir);
    const scores = await reinloop.layerSignals().score({ id: 'order', input: 'Where is order 42?' }, failed);
    const logPath = `.reinloop/runs/${failed.runId}.jsonl`;
    assert.ok((await readFile(join(dir, logPath), 'utf8')).includes('orders service unavailable'), 'the log is on disk');

    runtime = await reinloop.loadProject({ cwd: dir, agentsDir: [join(layerDir, 'agents')], env });
    const res = await runtime.run('diagnose', JSON.stringify({ runId: failed.runId, logPath, scores: Object.fromEntries(scores.map((s) => [s.layer, s.value])) }));
    assert.equal(res.status, 'completed', `status ${res.status}: ${res.reason ?? ''}`);

    // The schema is the contract; the small model may pick the wrong layer.
    const v = res.data;
    assert.equal(typeof v, 'object');
    assert.deepEqual(Object.keys(v).sort(), ['evidence', 'fix', 'layer', 'runId']);
    assert.ok(LAYERS.includes(v.layer), `layer "${v.layer}" is not a platform layer`);
    for (const key of ['runId', 'evidence', 'fix']) assert.ok(typeof v[key] === 'string' && v[key].length > 0, `${key} is empty`);
    t.diagnostic(`diagnosed layer: ${v.layer} (expected tool)`);
  } finally {
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
