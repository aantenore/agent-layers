import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { main } from '@agent-layers/cli';
import { LAYERS } from '@agent-layers/core';
import { adapter as expectedEval } from '@agent-layers/adapter-expected-eval';
import { layerDir } from './helpers.mjs';

const LAYER_IDS = LAYERS.map((l) => l.layer);
const dataset = join(layerDir, 'datasets/smoke.jsonl');

async function loadCases() {
  const lines = (await readFile(dataset, 'utf8')).split('\n').filter((l) => l.trim());
  return lines.map((l) => JSON.parse(l));
}

test('eval: the smoke dataset follows the EvalCase contract', async () => {
  const cases = await loadCases();
  assert.equal(cases.length, 4);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, 'ids are unique');
  for (const c of cases) {
    assert.deepEqual(Object.keys(c).filter((k) => !['id', 'input', 'expected', 'tags', 'layer'].includes(k)), [], `${c.id}: unknown field`);
    assert.equal(typeof c.input, 'string');
    if (c.layer) assert.ok(LAYER_IDS.includes(c.layer), `${c.id}: bad layer`);
  }
  assert.ok(cases.some((c) => c.tags?.includes('tools')), 'a case that needs a tool');
  assert.ok(cases.some((c) => c.tags?.includes('designed-to-fail')), 'a case designed to fail');
});

test('eval: the expected-eval adapter passes the EvaluatorPort conformance suite', async () => {
  const report = await checkAdapter(expectedEval, {
    fixtures: {
      cases: [
        { case: { id: 'hit', input: 'q', expected: 'pong' }, run: { runId: 'r1', output: 'pong', status: 'completed' }, expect: { metric: 'expected', value: 1 } },
        { case: { id: 'miss', input: 'q', expected: 'purple' }, run: { runId: 'r2', output: 'blue', status: 'completed' }, expect: { metric: 'expected', value: 0 } },
      ],
    },
  });
  assert.deepEqual(report.failures, []);
});

test('eval: "agent-layers eval" writes contract-shaped rows for the dataset (mock model)', async () => {
  // Inside the layer directory, so the adapter packages resolve like they do for the reference tests.
  const dir = await mkdtemp(join(layerDir, '.run-'));
  try {
    await writeFile(join(dir, 'agent-layers.json'), JSON.stringify({
      layers: {
        model: { adapter: 'mock-model' },
        runtime: { adapter: 'basic-runtime' },
        eval: [{ adapter: 'expected-eval' }, { adapter: 'layer-signals' }],
      },
      agents: { echo: { instructions: 'Echo the question.', model: 'mock' } },
    }));
    const lines = [];
    const io = { cwd: dir, env: {}, stdin: process.stdin, out: (t) => lines.push(t), err: (t) => lines.push(t) };
    const code = await main(['eval', dataset, '--agent', 'echo', '--out', 'results.jsonl'], io);
    assert.equal(code, 0, lines.join('\n'));

    const cases = await loadCases();
    const rows = (await readFile(join(dir, 'results.jsonl'), 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => r.id), cases.map((c) => c.id));
    for (const row of rows) {
      for (const key of ['id', 'runId', 'output', 'status', 'scores']) assert.ok(key in row, `${row.id}: missing ${key}`);
      for (const s of row.scores) {
        assert.ok(s.value >= 0 && s.value <= 1, `${row.id}/${s.metric}: value out of range`);
        assert.ok(s.layer === undefined || LAYER_IDS.includes(s.layer));
      }
    }
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId.ping.scores.find((s) => s.metric === 'expected').value, 1, 'echo contains "pong"');
    assert.equal(byId.impossible.scores.find((s) => s.metric === 'expected').value, 0, 'the designed-to-fail case fails');
    assert.ok(rows.every((r) => r.scores.some((s) => s.metric === 'harness_health')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
