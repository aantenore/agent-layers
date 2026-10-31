import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, limitFindings, limitList, noopTelemetry, type RunEvent, type StatePort } from '@agent-layers/core';
import { adapter, createMemoryState, LIMITS } from '../src/index.ts';

const ctx = { name: 'state', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const make = (options: Record<string, unknown>) => new AdapterRegistry().register(adapter).create('StatePort', 'memory-state', options, ctx) as Promise<StatePort>;
const text = (t: string): RunEvent => ({ type: 'text', text: t });
const texts = async (state: StatePort, id: string) => (await state.read(id)).map((e) => (e as { text: string }).text);

test('maxSessions evicts the least recently appended session', async () => {
  const state = createMemoryState({ maxSessions: 2 });
  await state.append('a', [text('1')]);
  await state.append('b', [text('1')]);
  await state.append('a', [text('2')]); // a is now the most recent
  await state.append('c', [text('1')]);
  assert.deepEqual(await state.list(), ['c', 'a']);
  assert.deepEqual(await state.read('b'), []);
  assert.deepEqual(await texts(state, 'a'), ['1', '2']);
});

test('maxEventsPerSession drops the oldest events and keeps the tail', async () => {
  const state = createMemoryState({ maxEventsPerSession: 3 });
  await state.append('s', [text('1'), text('2')]);
  await state.append('s', [text('3'), text('4')]);
  assert.deepEqual(await texts(state, 's'), ['2', '3', '4']);
  await state.append('s', [text('5'), text('6'), text('7'), text('8')]); // one append larger than the cap
  assert.deepEqual(await texts(state, 's'), ['6', '7', '8']);
});

test('defaults apply; numeric strings and "unbounded" are accepted', async () => {
  assert.equal(LIMITS.maxSessions.default, 1000);
  assert.equal(LIMITS.maxEventsPerSession.default, 10_000);
  const state = createMemoryState({ maxSessions: 'unbounded', maxEventsPerSession: 'unbounded' });
  for (let i = 0; i < 1100; i++) await state.append(`s${i}`, [text('x')]);
  assert.equal((await state.list()).length, 1100);
  const capped = await make({ maxSessions: '1' });
  await capped.append('a', [text('1')]);
  await capped.append('b', [text('1')]);
  assert.deepEqual(await capped.list(), ['b']);
});

test('invalid values are rejected', async () => {
  await assert.rejects(make({ maxSessions: 0 }), /maxSessions/);
  await assert.rejects(make({ maxEventsPerSession: -1 }), /maxEventsPerSession/);
  await assert.rejects(make({ maxSessions: 'many' }), /maxSessions/);
});

test('production readiness: warns on unbounded and on values above the safe range', () => {
  const specs = limitList(LIMITS);
  assert.deepEqual(limitFindings(specs, { options: {} }, 'production'), []);
  const findings = limitFindings(specs, { options: { maxSessions: 'unbounded', maxEventsPerSession: 5_000_000 } }, 'production');
  assert.deepEqual(findings.map((f) => [f.path, f.severity]), [['options.maxSessions', 'warn'], ['options.maxEventsPerSession', 'warn']]);
  assert.deepEqual(limitFindings(specs, { options: { maxSessions: 'unbounded' } }, 'prototype'), []);
});
