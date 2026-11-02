import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATTR, compose, defineAdapter, noopTelemetry, PORT_VERSIONS, recordingTelemetry, resolveProfile, AdapterRegistry, type RuntimePort, type TelemetryRecord, type Trigger } from '@agent-layers/core';
import { adapter, createCronTrigger, nextCron, parseCron, RUN_FAILED_EVENT, SCHEDULE_KEY } from '../../src/cron-trigger/index.ts';

function recorder() {
  const records: TelemetryRecord[] = [];
  return { records, telemetry: recordingTelemetry((r) => records.push(r)) };
}

const at = (iso: string) => Date.parse(iso);
const next = (expr: string, from: string) => { const t = nextCron(parseCron(expr), at(from)); return t === undefined ? undefined : new Date(t).toISOString(); };

test('nextCron finds the next matching minute in UTC', () => {
  assert.equal(next('* * * * *', '2026-11-02T10:15:30Z'), '2026-11-02T10:16:00.000Z');
  assert.equal(next('*/15 * * * *', '2026-11-02T10:15:00Z'), '2026-11-02T10:30:00.000Z');
  assert.equal(next('0 9 * * 1-5', '2026-11-06T09:00:00Z'), '2026-11-09T09:00:00.000Z', 'Friday 09:00 → Monday 09:00');
  assert.equal(next('30 23 31 12 *', '2026-11-02T00:00:00Z'), '2026-12-31T23:30:00.000Z');
  assert.equal(next('0 0 29 2 *', '2026-11-02T00:00:00Z'), '2028-02-29T00:00:00.000Z');
  assert.equal(next('0 12 1 * 7', '2026-11-02T00:00:00Z'), '2026-11-08T12:00:00.000Z', 'day of month or Sunday (7)');
  assert.equal(next('0 0 31 2 *', '2026-11-02T00:00:00Z'), undefined);
});

test('parseCron rejects malformed expressions', () => {
  for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '5-1 * * * *', '*/0 * * * *', 'a * * * *']) {
    assert.throws(() => parseCron(bad), /cron/, bad);
  }
});

/** Lets the promise callbacks of a firing (handler, catch, finally) run. */
const settle = () => new Promise((r) => setImmediate(r));

test('a schedule fires triggers with its name, agent and input until closed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const seen: Trigger[] = [];
  const handle = await createCronTrigger({ schedules: [{ name: 'tick', everyMs: 1000, agent: 'assistant', input: 'ping' }] }).start!(async (x) => { seen.push(x); });
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(1000); await settle(); }
  await handle.close();
  assert.equal(seen.length, 3);
  assert.deepEqual({ ...seen[0], id: '', at: '' }, { id: '', kind: 'schedule', source: 'cron-trigger/tick', at: '', agent: 'assistant', data: 'ping', ext: { [SCHEDULE_KEY]: 'tick' } });
  assert.equal(seen[0]!.at, new Date(1000).toISOString());
  assert.notEqual(seen[0]!.id, seen[1]!.id);
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(seen.length, 3, 'nothing fires after close');
});

test('a firing is skipped while the previous run is going; a failed run is reported and the schedule goes on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const rec = recorder();
  let release!: () => void;
  let calls = 0;
  const handle = await createCronTrigger({ schedules: [{ name: 'slow', everyMs: 1000 }] }, 'cron', { telemetry: rec.telemetry }).start!(async () => {
    calls++;
    await new Promise<void>((r) => { release = r; });
    throw new Error('run failed');
  });
  t.mock.timers.tick(1000);
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(calls, 1, 'the second firing found the first run going');
  release();
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  await handle.close();
  assert.equal(calls, 2);
  const failed = rec.records.filter((r) => r.type === 'event' && r.name === RUN_FAILED_EVENT);
  assert.equal(failed.length, 1);
  assert.equal((failed[0] as { attrs: Record<string, unknown> }).attrs[ATTR.name], 'slow');
  assert.equal((failed[0] as { attrs: Record<string, unknown> }).attrs[ATTR.error], 'run failed');
});

test('start rejects a schedule that never fires or names an unknown agent; everyMs is at least 1000', async () => {
  await assert.rejects(createCronTrigger({ schedules: [{ name: 'never', cron: '0 0 30 2 *' }] }).start!(async () => {}), /never fires/);
  await assert.rejects(createCronTrigger({ schedules: [{ name: 'x', everyMs: 1000, agent: 'ghost' }] }, 'cron', { agents: () => ['assistant'] }).start!(async () => {}), /schedule "x": unknown agent "ghost" \(known: assistant\)/);
  assert.throws(() => createCronTrigger({ schedules: [{ name: 'both', everyMs: 1000, cron: '* * * * *' }] }), /exactly one/);
  assert.throws(() => createCronTrigger({ schedules: [{ name: 'none' }] }), /exactly one/);
  assert.throws(() => createCronTrigger({ schedules: [{ name: 'fast', everyMs: 999 }] }), /at least 1000/);
  const registry = new AdapterRegistry().register(adapter);
  const ctx = { name: 'cron', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
  await assert.rejects(registry.create('TriggerPort', 'cron-trigger', { schedules: [{ name: 'x', everyMs: 10 }] }, ctx), /everyMs/);
});

test('stack.start runs the scheduled agent with the input, and refuses a schedule for an agent the stack lacks', async (t) => {
  const inputs: string[] = [];
  const echo = defineAdapter<'RuntimePort'>({
    layer: 'harness', port: 'RuntimePort', name: 'echo', direction: 'outbound', maps: { technology: 'test' },
    portVersion: PORT_VERSIONS.RuntimePort, tiers: ['prototype'], optionsSchema: { type: 'object' },
    create: (): RuntimePort => ({
      name: 'echo',
      bind: (_stack, agent) => ({ name: agent.name, run: async (input, init) => { inputs.push(String(input)); return { runId: init?.runId ?? 'r', status: 'completed', output: '' }; } }),
    }),
  });
  const stack = await compose(resolveProfile({
    agents: { assistant: { instructions: '', model: 'none' } },
    layers: { runtime: { adapter: 'echo' }, triggers: [{ adapter: 'cron-trigger', options: { schedules: [{ name: 'tick', everyMs: 1000, input: 'scheduled' }] } }] },
  }), { adapters: [echo, adapter] });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const handle = await stack.start();
  try {
    t.mock.timers.tick(1000);
    for (let i = 0; i < 20 && !inputs.length; i++) await settle();
    assert.ok(inputs.includes('scheduled'));
  } finally {
    await handle.close();
    await stack.close();
  }
  const wrong = await compose(resolveProfile({
    agents: { assistant: { instructions: '', model: 'none' } },
    layers: { runtime: { adapter: 'echo' }, triggers: [{ adapter: 'cron-trigger', options: { schedules: [{ name: 'tick', everyMs: 1000, agent: 'ghost' }] } }] },
  }), { adapters: [echo, adapter] });
  await assert.rejects(wrong.start(), /unknown agent "ghost"/);
  await wrong.close();
});

test('cron day rule: a day field starting with * leaves the day unrestricted (Vixie cron), so both fields must match', () => {
  // 2026-11-02 is a Monday with an even day of month; */2 means the odd days.
  assert.equal(next('0 0 */2 * 1', '2026-11-02T00:00:00Z'), '2026-11-09T00:00:00.000Z', 'an odd day that is a Monday');
  assert.equal(next('0 0 1-31/2 * 1', '2026-11-02T00:00:00Z'), '2026-11-03T00:00:00.000Z', 'both restricted: an odd day or a Monday');
  assert.equal(parseCron('0 0 * * */2').either, false);
});
