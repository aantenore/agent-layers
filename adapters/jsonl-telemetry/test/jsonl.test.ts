import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createJsonlTelemetry } from '../src/index.ts';

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), 'jsonl-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const lines = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('writes one record per line and creates parent directories', async () => {
  const port = createJsonlTelemetry({ path: 'a/b/t.jsonl' }, { cwd: dir });
  await port.span('knowledge.search', { 'agent.layer': 'knowledge', source: 'docs' }, async () => {});
  port.event('guard.block', { 'agent.layer': 'guardrail' });
  port.metric('tokens', 7, { 'agent.layer': 'llm' });
  const records = lines(join(dir, 'a/b/t.jsonl'));
  assert.deepEqual(records.map((r) => [r.type, r.name, r.layer]), [
    ['span', 'knowledge.search', 'knowledge'], ['event', 'guard.block', 'guardrail'], ['metric', 'tokens', 'llm'],
  ]);
  assert.equal(records[0].status, 'ok');
  assert.equal(records[0].attrs.source, 'docs');
  assert.equal(records[2].value, 7);
});

test('appends across instances unless truncate is set', async () => {
  const file = join(dir, 'keep.jsonl');
  createJsonlTelemetry({ path: 'keep.jsonl' }, { cwd: dir }).event('one', { 'agent.layer': 'tool' });
  createJsonlTelemetry({ path: 'keep.jsonl' }, { cwd: dir }).event('two', { 'agent.layer': 'tool' });
  assert.deepEqual(lines(file).map((r) => r.name), ['one', 'two']);
  createJsonlTelemetry({ path: 'keep.jsonl', truncate: true }, { cwd: dir }).event('three', { 'agent.layer': 'tool' });
  assert.deepEqual(lines(file).map((r) => r.name), ['three']);
});

test('records failed spans and masks secret-looking attributes', async () => {
  const port = createJsonlTelemetry({ path: 'err.jsonl' }, { cwd: dir });
  await assert.rejects(port.span('tool.call', { 'agent.layer': 'tool', api_key: 'sk-1' }, async () => { throw new Error('boom'); }), /boom/);
  const [record] = lines(join(dir, 'err.jsonl'));
  assert.equal(record.status, 'error');
  assert.equal(record.error, 'boom');
  assert.equal(record.attrs.api_key, '[redacted]');
});

test('a write failure does not break the run', async () => {
  const port = createJsonlTelemetry({ path: 'gone/t.jsonl' }, { cwd: dir });
  rmSync(join(dir, 'gone'), { recursive: true, force: true });
  writeFileSync(join(dir, 'gone'), 'now a file');
  assert.equal(await port.span('s', { 'agent.layer': 'tool' }, async () => 42), 42);
});
