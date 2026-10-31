import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { reinloop } from '../../../lib/reinloop.mjs';
import { evalSkipReason, layerDir } from './helpers.mjs';

const LAYERS = ['infra', 'llm', 'harness', 'knowledge', 'tool', 'identity', 'guardrail', 'cache', 'telemetry', 'eval'];

async function loadCases() {
  const lines = (await readFile(join(layerDir, 'datasets/smoke.jsonl'), 'utf8')).split('\n').filter((l) => l.trim());
  return lines.map((l) => JSON.parse(l));
}

test('eval: the smoke dataset follows the EvalCase contract', async () => {
  const cases = await loadCases();
  assert.equal(cases.length, 4);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, 'ids are unique');
  for (const c of cases) {
    assert.deepEqual(Object.keys(c).filter((k) => !['id', 'input', 'expected', 'tags', 'layer'].includes(k)), [], `${c.id}: unknown field`);
    assert.equal(typeof c.input, 'string');
    if (c.layer) assert.ok(LAYERS.includes(c.layer), `${c.id}: bad layer`);
  }
  assert.ok(cases.some((c) => c.tags?.includes('tools')), 'a case that needs a tool');
  assert.ok(cases.some((c) => c.tags?.includes('designed-to-fail')), 'a case designed to fail');
});

test('eval: reinloop evaluate writes contract-shaped rows for the dataset', async (t) => {
  const why = evalSkipReason(reinloop);
  if (why) return t.skip(`SKIPPED: ${why}`);

  const cases = await loadCases();
  const echo = reinloop.agent({ name: 'echo', model: { provider: reinloop.mockProvider([]), model: 'mock' } });
  const rows = await reinloop.evaluate({
    agent: echo,
    cases,
    evaluators: [reinloop.expectedEvaluator(), reinloop.layerSignals()],
  });

  assert.deepEqual(rows.map((r) => r.id), cases.map((c) => c.id));
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'output', 'runId', 'scores', 'status']);
    for (const s of row.scores) {
      assert.ok(s.value >= 0 && s.value <= 1, `${row.id}/${s.metric}: value out of range`);
      assert.ok(s.layer === undefined || LAYERS.includes(s.layer));
    }
  }
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.ping.scores.find((s) => s.metric === 'expected').value, 1, 'echo contains "pong"');
  assert.equal(byId.impossible.scores.find((s) => s.metric === 'expected').value, 0, 'the designed-to-fail case fails');
  assert.ok(rows.every((r) => r.scores.some((s) => s.metric === 'harness_health')));
});
