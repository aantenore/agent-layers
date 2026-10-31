import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AdapterRegistry, limitFindings, limitList, noopTelemetry } from '@agent-layers/core';
import { adapter, createJsonlTelemetry, LIMITS } from '../src/index.ts';

const ctx = { name: 'jsonl-telemetry', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };

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

const L = { 'agent.layer': 'tool' } as const;
const files = (name: string) => readdirSync(dir).filter((f) => f === name || f.startsWith(`${name}.`)).sort();
/** Bytes of one record as the adapter writes it, to size the cap in whole records. */
const recordBytes = (extra = '') => Buffer.byteLength(`${JSON.stringify({ type: 'event', name: 'e', layer: 'tool', time: '2026-01-01T00:00:00.000Z', attrs: { 'agent.layer': 'tool', ...(extra ? { x: extra } : {}) } })}\n`);

test('rotates at maxFileBytes: file -> file.1 -> ... and the oldest is deleted', () => {
  const port = createJsonlTelemetry({ path: 'rot.jsonl', maxFileBytes: 1024, maxFiles: 2 }, { cwd: dir });
  const pad = 'x'.repeat(300);
  for (let i = 0; i < 10; i++) port.event(`e${i}`, { ...L, pad });
  assert.deepEqual(files('rot.jsonl'), ['rot.jsonl', 'rot.jsonl.1', 'rot.jsonl.2']);
  // oldest first: .2, .1, then the active file; together the newest records, in order, without gaps
  const kept = ['rot.jsonl.2', 'rot.jsonl.1', 'rot.jsonl'].flatMap((f) => lines(join(dir, f)).map((r) => Number(r.name.slice(1))));
  assert.equal(kept.at(-1), 9);
  assert.ok(kept.length < 10 && kept[0]! > 0, 'e0 was deleted with the oldest file');
  assert.deepEqual(kept, Array.from({ length: kept.length }, (_, i) => 10 - kept.length + i));
  for (const f of files('rot.jsonl')) assert.ok(statSync(join(dir, f)).size <= 1024, f);
});

test('maxFiles: 1 keeps only the previous file', () => {
  const port = createJsonlTelemetry({ path: 'one.jsonl', maxFileBytes: 1024, maxFiles: 1 }, { cwd: dir });
  for (let i = 0; i < 12; i++) port.event(`e${i}`, { ...L, pad: 'x'.repeat(300) });
  assert.deepEqual(files('one.jsonl'), ['one.jsonl', 'one.jsonl.1']);
});

test('a record larger than the cap is still written, to a fresh file', () => {
  const port = createJsonlTelemetry({ path: 'big.jsonl', maxFileBytes: 1024, maxFiles: 3 }, { cwd: dir });
  port.event('small', L);
  port.event('huge', { ...L, pad: 'x'.repeat(5000) });
  port.event('after', L);
  assert.ok(recordBytes() < 1024 && recordBytes('x'.repeat(5000)) > 1024);
  assert.deepEqual(lines(join(dir, 'big.jsonl.2')).map((r) => r.name), ['small']);
  assert.deepEqual(lines(join(dir, 'big.jsonl.1')).map((r) => r.name), ['huge']);
  assert.deepEqual(lines(join(dir, 'big.jsonl')).map((r) => r.name), ['after']);
});

test('an existing file over the cap is rotated by the first write; the size is read at start', () => {
  writeFileSync(join(dir, 'old.jsonl'), `${'{"old":true}\n'.repeat(200)}`);
  const port = createJsonlTelemetry({ path: 'old.jsonl', maxFileBytes: 1024 }, { cwd: dir });
  port.event('fresh', L);
  assert.deepEqual(lines(join(dir, 'old.jsonl')).map((r) => r.name), ['fresh']);
  assert.equal(lines(join(dir, 'old.jsonl.1')).length, 200);
});

test('truncate empties the active file only', () => {
  writeFileSync(join(dir, 'trunc.jsonl.1'), '{"kept":true}\n');
  const port = createJsonlTelemetry({ path: 'trunc.jsonl', truncate: true }, { cwd: dir });
  port.event('a', L);
  assert.deepEqual(files('trunc.jsonl'), ['trunc.jsonl', 'trunc.jsonl.1']);
  assert.deepEqual(lines(join(dir, 'trunc.jsonl')).map((r) => r.name), ['a']);
});

test('unbounded never rotates', () => {
  const port = createJsonlTelemetry({ path: 'free.jsonl', maxFileBytes: 'unbounded' }, { cwd: dir });
  for (let i = 0; i < 50; i++) port.event(`e${i}`, { ...L, pad: 'x'.repeat(300) });
  assert.deepEqual(files('free.jsonl'), ['free.jsonl']);
  assert.equal(lines(join(dir, 'free.jsonl')).length, 50);
});

test('a rotation that fails does not lose the record or break the run', async () => {
  const port = createJsonlTelemetry({ path: 'stuck.jsonl', maxFileBytes: 1024, maxFiles: 2 }, { cwd: dir });
  port.event('first', { ...L, pad: 'x'.repeat(900) });
  mkdirSync(join(dir, 'stuck.jsonl.2', 'not-empty'), { recursive: true }); // the oldest slot cannot be deleted
  assert.equal(await port.span('second', L, async () => 1), 1);
  assert.deepEqual(lines(join(dir, 'stuck.jsonl')).map((r) => r.name), ['first', 'second']);
});

test('limits: numeric strings from ${env:...} are coerced; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  const make = (options: Record<string, unknown>) => registry.create('TelemetryPort', 'jsonl-telemetry', { path: 'lim.jsonl', ...options }, ctx);
  await make({ maxFileBytes: '2048', maxFiles: '3' });
  await make({ maxFileBytes: 'unbounded' });
  await assert.rejects(make({ maxFileBytes: 1023 }), /maxFileBytes/);
  await assert.rejects(make({ maxFileBytes: 'big' }), /maxFileBytes/);
  await assert.rejects(make({ maxFiles: 0 }), /maxFiles/);
  await assert.rejects(make({ maxFiles: 101 }), /maxFiles/);
  await assert.rejects(make({ maxFiles: 'unbounded' }), /maxFiles/);
});

test('production readiness: unbounded and oversize caps are warnings, defaults are clean', () => {
  const specs = limitList(LIMITS);
  assert.equal(LIMITS.maxFileBytes.default, 104_857_600);
  assert.equal(LIMITS.maxFiles.default, 5);
  assert.deepEqual(limitFindings(specs, { options: {} }, 'production'), []);
  const findings = limitFindings(specs, { options: { maxFileBytes: 'unbounded' } }, 'production');
  assert.deepEqual(findings.map((f) => [f.path, f.severity]), [['options.maxFileBytes', 'warn']]);
  assert.deepEqual(limitFindings(specs, { options: { maxFileBytes: 2_000_000_000 } }, 'production').map((f) => [f.path, f.severity]), [['options.maxFileBytes', 'warn']]);
  assert.deepEqual(limitFindings(specs, { options: { maxFileBytes: 'unbounded' } }, 'prototype'), []);
});

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';
let n = 0;
async function traced(trace: { parent: string; state?: string }) {
  const path = `trace-${n++}.jsonl`;
  const port = createJsonlTelemetry({ path }, { cwd: dir });
  let inside: ReturnType<NonNullable<typeof port.current>>;
  await port.span('s', L, async () => { inside = port.current!(); }, { parent: trace });
  const [record] = lines(join(dir, path));
  return { record, inside: inside!, joined: record.traceId === TRACE && record.parentSpanId === SPAN };
}

test('traceIds: a valid remote parent is joined, flags and tracestate kept, current() speaks W3C', async () => {
  const r = await traced({ parent: `00-${TRACE}-${SPAN}-00`, state: 'vendor=a,b=2' });
  assert.equal(r.joined, true);
  assert.match(r.record.spanId, /^[0-9a-f]{16}$/);
  assert.equal(r.inside.parent, `00-${TRACE}-${r.record.spanId}-00`);
  assert.equal(r.inside.state, 'vendor=a,b=2');
});

test('traceIds: spans nest and root spans start a trace', async () => {
  const port = createJsonlTelemetry({ path: 'nest.jsonl' }, { cwd: dir });
  await port.span('outer', L, async () => { await port.span('inner', L, async () => {}); });
  const [inner, outer] = lines(join(dir, 'nest.jsonl'));
  assert.match(outer.traceId, /^[0-9a-f]{32}$/);
  assert.equal(inner.traceId, outer.traceId);
  assert.equal(inner.parentSpanId, outer.spanId);
  assert.equal(outer.parentSpanId, undefined);
});

test('traceIds: false writes no ids and has no current()', async () => {
  const port = createJsonlTelemetry({ path: 'noids.jsonl', traceIds: false }, { cwd: dir });
  await port.span('s', L, async () => {}, { parent: { parent: `00-${TRACE}-${SPAN}-01` } });
  const [record] = lines(join(dir, 'noids.jsonl'));
  assert.equal(record.traceId, undefined);
  assert.equal(port.current, undefined);
});

test('traceIds: malformed traceparent values are ignored and start a new trace', async () => {
  const bad = [
    'garbage', '', `00-${TRACE}-${SPAN}`, `00-${TRACE}-${SPAN}-01-extra`, `00-${TRACE}-${SPAN}-01-`,
    `00-${TRACE.toUpperCase()}-${SPAN}-01`, `00-${TRACE}-${SPAN.toUpperCase()}-01`, `0G-${TRACE}-${SPAN}-01`, `00-${TRACE}-${SPAN}-0G`,
    `00-${TRACE.slice(1)}-${SPAN}-01`, `00-${TRACE}0-${SPAN}-01`, `00-${TRACE}-${SPAN.slice(1)}-01`, `00-${TRACE}-${SPAN}0-01`, `00-${TRACE}-${SPAN}-1`,
    `ff-${TRACE}-${SPAN}-01`, `00-${'0'.repeat(32)}-${SPAN}-01`, `00-${TRACE}-${'0'.repeat(16)}-01`, ` 00-${TRACE}-${SPAN}-01`, `00_${TRACE}_${SPAN}_01`,
  ];
  for (const parent of bad) {
    const r = await traced({ parent });
    assert.equal(r.joined, false, JSON.stringify(parent));
    assert.equal(r.record.parentSpanId, undefined, JSON.stringify(parent));
    assert.match(r.record.traceId, /^[0-9a-f]{32}$/);
  }
  for (const trace of [{ parent: 5 as unknown as string }, { parent: undefined as unknown as string }, null as never]) {
    const port = createJsonlTelemetry({ path: 'weird.jsonl' }, { cwd: dir });
    assert.equal(await port.span('s', L, async () => 1, { parent: trace }), 1);
  }
});

test('traceIds: a future version with more fields joins and is re-emitted as version 00', async () => {
  const r = await traced({ parent: `01-${TRACE}-${SPAN}-01-extra` });
  assert.equal(r.joined, true);
  assert.equal(r.inside.parent, `00-${TRACE}-${r.record.spanId}-01`);
  assert.equal((await traced({ parent: `01-${TRACE}-${SPAN}01-x` })).joined, false);
});

test('traceIds: an invalid tracestate is dropped, the trace still joins', async () => {
  const parent = `00-${TRACE}-${SPAN}-01`;
  const members = (count: number) => Array.from({ length: count }, (_, i) => `k${i}=v`).join(',');
  for (const state of ['vendor=a', 'a=1,b=2', 'tenant@sys=v', members(32)]) assert.equal((await traced({ parent, state })).inside.state, state, state);
  const bad = ['', members(33), `k=${'v'.repeat(600)}`, `${'a'.repeat(300)}=1`, 'novalue', '=v', 'UPPER=1', '1abc=v', 'a=1,a=2', 'a=b=c', 'k=v\u0001', 'k=café', 'a=1;b=2', `k=${'v'.repeat(257)}`, 'a@b@c=1', 'tenant@SYS=1'];
  for (const state of bad) {
    const r = await traced({ parent, state });
    assert.equal(r.joined, true, state);
    assert.equal(r.inside.state, undefined, JSON.stringify(state));
  }
});
