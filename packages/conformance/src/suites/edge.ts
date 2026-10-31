import type { ChannelHandle, ChannelHost, ChannelPort, DeployPort, SecretPort, ServiceSpec, Trigger, TriggerPort } from '@agent-layers/core';
import { Checks } from '../check.ts';
import { conforms } from '../schemas.ts';

export interface DeployFixtures { services?: ServiceSpec[]; /** Also run up and down (default false). */ live?: boolean }

export async function checkDeploy(port: DeployPort, f: DeployFixtures = {}, c = new Checks()): Promise<Checks> {
  const services = f.services ?? [{ name: 'conformance', image: 'busybox:1.36', ports: [8080] }];
  services.forEach((s, i) => c.all(conforms('service-spec', s), `fixture service[${i}]`));
  const plan = await c.attempt('plan', () => port.plan(services, { dryRun: true }));
  if (plan) {
    c.expect(Array.isArray(plan.artifacts) && plan.artifacts.every((a) => typeof a.path === 'string' && typeof a.content === 'string'), 'plan: artifacts must be {path, content}');
    c.expect(Array.isArray(plan.steps) && plan.steps.every((s) => typeof s === 'string'), 'plan: steps must be strings');
    c.expect(!JSON.stringify(plan).includes('change-me'), 'plan: must not inline secret values');
  }
  if (!f.live) { c.skip('up/down: live fixture not set'); return c; }
  const endpoints = await c.attempt('up', () => port.up(services), 300_000);
  c.expect(Array.isArray(endpoints), 'up: must resolve to endpoints');
  await c.attempt('down', () => port.down(services), 300_000);
  return c;
}

export async function checkSecrets(port: SecretPort, f: { known?: [string, string] } = {}, c = new Checks()): Promise<Checks> {
  c.expect(await c.attempt('get unknown', () => port.get('conformance-missing-secret')) === undefined, 'get: unknown ref must resolve to undefined');
  if (f.known) c.expect(await c.attempt('get known', () => port.get(f.known![0])) === f.known[1], 'get: wrong value for known ref');
  else c.skip('get known: needs a known secret fixture');
  return c;
}

const fakeHost = (): ChannelHost & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    agents: () => ['conformance'],
    run: async (agent, input) => { calls.push(typeof input === 'string' ? input : 'messages'); return { runId: 'conformance-run', status: 'completed', output: `echo:${typeof input === 'string' ? input : ''}`, ...(agent ? {} : {}) }; },
  };
};

export interface ChannelFixtures {
  /** Drive the served channel (send a message); the fake host records the inputs it received. */
  exercise?: (handle: ChannelHandle, host: ChannelHost) => Promise<void>;
  expectInput?: string;
}

export async function checkChannel(port: ChannelPort, f: ChannelFixtures = {}, c = new Checks()): Promise<Checks> {
  const host = fakeHost();
  const handle = await c.attempt('serve', () => port.serve(host));
  if (!handle) return c;
  c.expect(typeof handle.close === 'function', 'serve: handle needs close()');
  if (f.exercise) {
    await c.attempt('exercise', () => f.exercise!(handle, host));
    if (f.expectInput) c.expect(host.calls.includes(f.expectInput), `exercise: host never received "${f.expectInput}"`);
  } else c.skip('exercise: no fixture');
  await c.attempt('close', () => handle.close());
  return c;
}

export async function checkTrigger(port: TriggerPort, f: { fire?: () => Promise<void> } = {}, c = new Checks()): Promise<Checks> {
  const seen: Trigger[] = [];
  const handle = await c.attempt('start', () => port.start(async (t) => { seen.push(t); }));
  if (!handle) return c;
  if (f.fire) {
    await c.attempt('fire', () => f.fire!());
    await new Promise((r) => setTimeout(r, 50));
    c.expect(seen.length > 0, 'fire: handler was not called');
    seen.forEach((t, i) => c.all(conforms('trigger', t), `trigger[${i}]`));
  } else c.skip('fire: no fixture');
  await c.attempt('close', () => handle.close());
  return c;
}
