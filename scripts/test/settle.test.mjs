// node --test "scripts/test/*.test.mjs"
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settledCount } from '../lib/settle.mjs';

/** A virtual clock and a backend whose count is a step function of time. */
function backend(steps) {
  let t = 0;
  const reads = [];
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    read: async () => { const c = steps.filter(([at]) => at <= t).reduce((n, [, add]) => n + add, 0); reads.push([t, c]); return c; },
    reads,
  };
}

// The first slice cell: two spans exported mid-run, the other five 3 s after the run (2 s export interval, 1 s batch).
const FIRST_CELL = [[0, 2], [3000, 5]];

test('a pause shorter than the quiet window is not taken for the end', async () => {
  const b = backend(FIRST_CELL);
  assert.equal(await settledCount(b.read, { expected: 7, quietMs: 5000, deadlineMs: 30_000, sleep: b.sleep, now: b.now }), 7);
});

test('a quiet window shorter than the export gap stops at the first step (the old reading)', async () => {
  const b = backend(FIRST_CELL);
  assert.equal(await settledCount(b.read, { expected: 7, quietMs: 1500, deadlineMs: 30_000, pollMs: 1500, sleep: b.sleep, now: b.now }), 2);
});

test('a count that stops short of the expected one is returned once quiet', async () => {
  const b = backend([[0, 3]]);
  assert.equal(await settledCount(b.read, { expected: 7, quietMs: 5000, deadlineMs: 30_000, sleep: b.sleep, now: b.now }), 3);
  assert.ok(b.now() >= 5000 && b.now() < 6000);
});

test('nothing arrives: 0 at the deadline; read errors count as nothing yet', async () => {
  const b = backend([]);
  assert.equal(await settledCount(b.read, { expected: 7, quietMs: 5000, deadlineMs: 10_000, sleep: b.sleep, now: b.now }), 0);
  assert.ok(b.now() >= 10_000);
  let calls = 0;
  const flaky = async () => { calls += 1; if (calls < 3) throw new Error('down'); return 4; };
  assert.equal(await settledCount(flaky, { expected: 4, quietMs: 5000, deadlineMs: 10_000, sleep: b.sleep, now: b.now }), 4);
});
