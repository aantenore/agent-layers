import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { reinloop } from '../../../lib/reinloop.mjs';
import { env, evalSkipReason, layerDir, llmSkipReason, rootDir } from './helpers.mjs';

// Pinned: the provider API and the output format are checked against this exact version.
const PROMPTFOO = 'promptfoo@0.125.1';

function run(cmd, args, { cwd, env: e, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => (clearTimeout(timer), resolve({ code, out })));
  });
}

/** Returns undefined when promptfoo can be run through npx, otherwise the reason to skip. */
async function promptfooSkipReason(e) {
  if (spawnSync('npx', ['--version'], { encoding: 'utf8' }).status !== 0) return 'npx is not available';
  const probe = await run('npx', ['--yes', PROMPTFOO, '--version'], { cwd: rootDir, env: e, timeoutMs: 240_000 });
  return probe.code === 0 ? undefined : `${PROMPTFOO} is not available through npx (network?): ${probe.out.trim().split('\n').pop()}`;
}

test('L9: promptfoo runs the smoke dataset through the reinloop provider', { timeout: 900_000 }, async (t) => {
  const why = evalSkipReason(reinloop) ?? (await llmSkipReason());
  if (why) return t.skip(`SKIPPED: ${why}`);

  const dir = await mkdtemp(join(tmpdir(), 'l9-pf-'));
  const e = {
    ...env,
    PROMPTFOO_CONFIG_DIR: join(dir, 'config'),
    PROMPTFOO_DISABLE_TELEMETRY: '1',
    PROMPTFOO_DISABLE_UPDATE: '1',
    PROMPTFOO_DISABLE_SHARING: '1',
  };
  try {
    const missing = await promptfooSkipReason(e);
    if (missing) return t.skip(`SKIPPED: ${missing}`);

    const out = join(dir, 'results.json');
    const res = await run('npx', ['--yes', PROMPTFOO, 'eval', '-c', join(layerDir, 'promptfooconfig.yaml'), '-o', out, '--no-cache', '--no-progress-bar', '--max-concurrency', '1'], {
      cwd: rootDir, env: e, timeoutMs: 600_000,
    });
    // Exit code 100 = some assertions failed, which is expected here (one case is designed to fail).
    assert.ok([0, 100].includes(res.code), `promptfoo exited ${res.code}:\n${res.out.slice(-1500)}`);

    const rows = JSON.parse(await readFile(out, 'utf8')).results.results;
    assert.equal(rows.length, 4);
    const byId = Object.fromEntries(rows.map((r) => [r.testCase.description, r]));
    assert.deepEqual(Object.keys(byId).sort(), ['impossible', 'ping', 'sum', 'vault']);
    assert.equal(byId.impossible.success, false, 'the designed-to-fail case fails');
    for (const r of rows) {
      assert.ok(r.response?.metadata?.runId, `${r.testCase.description}: the provider reports the run id`);
      assert.ok(r.response?.metadata?.layers, `${r.testCase.description}: the provider reports per-layer scores`);
    }
    const passed = rows.filter((r) => r.success).map((r) => r.testCase.description);
    t.diagnostic(`passed: ${passed.join(', ') || 'none'}`);
    assert.ok(passed.length >= 1, 'at least one of the real cases passes');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
