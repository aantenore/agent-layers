import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ServiceSpec } from '@agent-layers/core';
import { composeFor } from '../src/generate.ts';
import { createComposeDeploy, GENERATED_FILE } from '../src/index.ts';
import { spawnRun } from '../src/run.ts';
import { fakeRun, listing, tempProject } from './helpers.ts';

const image: ServiceSpec = {
  name: 'api',
  image: 'example/api:1',
  env: { MODE: 'dev', PRICE: 'a$b' },
  secretRefs: ['API_TOKEN'],
  ports: [8080, 9090],
  health: { command: ['curl', '-f', 'http://localhost:8080/health'] },
};

test('plan: layer files, generated file and missing layers, with no side effects', async () => {
  const { root, cleanup } = await tempProject();
  try {
    const { run, calls } = fakeRun();
    const deploy = createComposeDeploy({}, { cwd: root, run });
    const before = await listing(root);
    const plan = await deploy.plan([
      { name: 'llm', layer: 'llm', ports: [11434] },
      { name: 'qdrant', layer: 'knowledge' },
      { name: 'bridge', layer: 'tool' },
      { name: 'nope', layer: 'eval' },
      image,
    ]);
    assert.deepEqual(plan.steps, [
      '# no compose file for layer eval',
      'docker compose -p agent-layers -f reference/llm/compose.yml up -d --wait',
      'docker compose -p agent-layers -f reference/knowledge/compose.yml up -d --wait',
      'docker compose -p agent-layers -f reference/tool/compose.yml up -d --wait',
      `docker compose -p agent-layers -f ${GENERATED_FILE} up -d --wait`,
    ]);
    assert.deepEqual(plan.artifacts.map((a) => a.path), [GENERATED_FILE]);
    assert.equal(plan.artifacts[0]!.content, composeFor([image]));
    assert.deepEqual(await listing(root), before);
    assert.equal(calls.length, 0);
  } finally {
    await cleanup();
  }
});

test('plan: no artifact without image services; env file, project, command and wait options', async () => {
  const { root, cleanup } = await tempProject({ '.env': 'A=1\n', 'custom/k.yml': 'services: {}\n' });
  try {
    const deploy = createComposeDeploy(
      { projectName: 'demo', command: ['podman', 'compose'], wait: false, files: { knowledge: 'custom/k.yml' }, searchDirs: ['layers'] },
      { cwd: root, run: fakeRun().run },
    );
    const plan = await deploy.plan([{ name: 'k', layer: 'knowledge' }, { name: 'l', layer: 'llm' }]);
    assert.deepEqual(plan.artifacts, []);
    assert.deepEqual(plan.steps, [
      '# no compose file for layer llm',
      'podman compose -p demo -f custom/k.yml --env-file .env up -d',
    ]);
  } finally {
    await cleanup();
  }
});

test('layer lookup: only reference/<layer id>; numbered layers/l<n>-* folders are not read', async () => {
  const { root, cleanup } = await tempProject({
    'layers/l6-guardrails/compose.yml': 'services: {}\n',
    'layers/l7-cache-router/compose.yml': 'services: {}\n',
  });
  try {
    const plan = await createComposeDeploy({}, { cwd: root, run: fakeRun().run }).plan([
      { name: 'a', layer: 'knowledge' }, { name: 'b', layer: 'guardrail' }, { name: 'c', layer: 'cache' },
    ]);
    assert.deepEqual(plan.steps, [
      '# no compose file for layer guardrail',
      '# no compose file for layer cache',
      'docker compose -p agent-layers -f reference/knowledge/compose.yml up -d --wait',
    ]);
  } finally {
    await cleanup();
  }
});

test('up: writes the generated file, runs every file in order, returns endpoints', async () => {
  const { root, cleanup } = await tempProject({ '.env': 'API_TOKEN=s3cret-value\n' });
  try {
    const { run, calls } = fakeRun();
    const deploy = createComposeDeploy({}, { cwd: root, run });
    const endpoints = await deploy.up([{ name: 'llm', layer: 'llm', ports: [11434] }, { name: 'skipped', layer: 'eval', ports: [1] }, image]);
    assert.deepEqual(endpoints, [
      { service: 'llm', url: 'http://localhost:11434' },
      { service: 'api', url: 'http://localhost:8080' },
      { service: 'api', url: 'http://localhost:9090' },
    ]);
    assert.deepEqual(calls.map((c) => [c.cmd, c.cwd]), [['docker', root], ['docker', root]]);
    assert.deepEqual(calls[0]!.args, ['compose', '-p', 'agent-layers', '-f', 'reference/llm/compose.yml', '--env-file', '.env', 'up', '-d', '--wait']);
    assert.deepEqual(calls[1]!.args.slice(0, 5), ['compose', '-p', 'agent-layers', '-f', GENERATED_FILE]);
    const written = await readFile(join(root, GENERATED_FILE), 'utf8');
    assert.equal(written, composeFor([image]));
    assert.ok(!written.includes('s3cret-value'));
  } finally {
    await cleanup();
  }
});

test('down: regenerates the file and stops in reverse order', async () => {
  const { root, cleanup } = await tempProject();
  try {
    const { run, calls } = fakeRun();
    await createComposeDeploy({}, { cwd: root, run }).down([{ name: 'llm', layer: 'llm' }, image]);
    assert.deepEqual(calls.map((c) => c.args.at(-1)), ['down', 'down']);
    assert.ok(calls[0]!.args.includes(GENERATED_FILE));
    assert.ok(calls[1]!.args.includes('reference/llm/compose.yml'));
    assert.match(await readFile(join(root, GENERATED_FILE), 'utf8'), /image: "example\/api:1"/);
  } finally {
    await cleanup();
  }
});

test('dryRun runs nothing and writes nothing', async () => {
  const { root, cleanup } = await tempProject();
  try {
    const { run, calls } = fakeRun();
    const deploy = createComposeDeploy({}, { cwd: root, run });
    const before = await listing(root);
    assert.equal((await deploy.up([image], { dryRun: true })).length, 2);
    await deploy.down([image], { dryRun: true });
    assert.equal(calls.length, 0);
    assert.deepEqual(await listing(root), before);
  } finally {
    await cleanup();
  }
});

test('a non-zero exit throws with the error output and stops', async () => {
  const { root, cleanup } = await tempProject();
  try {
    const { run, calls } = fakeRun({ code: 1, stdout: '', stderr: 'no configuration file provided\n' });
    const deploy = createComposeDeploy({}, { cwd: root, run });
    await assert.rejects(deploy.up([{ name: 'llm', layer: 'llm' }, image]), /compose up failed \(exit 1\): no configuration file provided$/);
    assert.equal(calls.length, 1);
    await assert.rejects(deploy.down([image]), /compose down failed/);
  } finally {
    await cleanup();
  }
});

test('invalid services are rejected', async () => {
  const { root, cleanup } = await tempProject();
  try {
    const deploy = createComposeDeploy({}, { cwd: root, run: fakeRun().run });
    await assert.rejects(deploy.plan([{ name: 'x' }]), /needs an image or a layer/);
    await assert.rejects(deploy.plan([{ name: 'x', image: 'i', secretRefs: ['A B'] }]), /invalid secret reference/);
    await assert.rejects(deploy.plan([{ name: 'x y', image: 'i' }]), /invalid name/);
    await assert.rejects(deploy.plan([{ name: 'x', image: 'i', env: { 'A-B': '1' } }]), /invalid variable name/);
  } finally {
    await cleanup();
  }
});

test('generated file: secrets by reference, loopback ports, healthcheck', () => {
  assert.equal(composeFor([image]), [
    'services:',
    '  api:',
    '    image: "example/api:1"',
    '    environment:',
    '      MODE: "dev"',
    '      PRICE: "a$$b"',
    '      API_TOKEN: "${API_TOKEN}"',
    '    ports:',
    '      - "127.0.0.1:8080:8080"',
    '      - "127.0.0.1:9090:9090"',
    '    healthcheck:',
    '      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]',
    '      interval: 5s',
    '      timeout: 3s',
    '      retries: 12',
    '',
  ].join('\n'));
});

test('spawnRun captures output, exit codes and spawn failures', async () => {
  const ok = await spawnRun(process.execPath, ['-e', 'console.log("out"); console.error("err")'], { cwd: process.cwd() });
  assert.deepEqual(ok, { code: 0, stdout: 'out\n', stderr: 'err\n' });
  assert.equal((await spawnRun(process.execPath, ['-e', 'process.exit(3)'], { cwd: process.cwd() })).code, 3);
  const missing = await spawnRun('agent-layers-no-such-command', [], { cwd: process.cwd() });
  assert.equal(missing.code, -1);
  assert.match(missing.stderr, /ENOENT/);
});
