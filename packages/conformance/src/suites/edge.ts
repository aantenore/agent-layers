import { findRoute, lastUserText, type CallContext, type ChannelHandle, type ChannelHost, type ChannelPort, type DeployPort, type InboundContext, type InboundMount, type SecretPort, type ServiceSpec, type Trigger, type TriggerPort, type TriggerSink } from '@agent-layers/core';
import { Checks } from '../check.ts';
import { conforms } from '../schemas.ts';

export interface DeployFixtures { services?: ServiceSpec[]; /** Also run up and down (default false). */ live?: boolean }

export async function checkDeploy(port: DeployPort, f: DeployFixtures = {}, c = new Checks()): Promise<Checks> {
  const services = f.services ?? [{ name: 'conformance', image: 'busybox:1.36', ports: [8080] }];
  services.forEach((s, i) => c.all(conforms('service-spec', s), `fixture service[${i}]`));
  const plan = await c.attempt('plan', () => port.plan(services, { dryRun: true }));
  if (plan) {
    c.produced('plan', plan);
    c.expect(Array.isArray(plan.artifacts) && plan.artifacts.every((a) => typeof a.path === 'string' && typeof a.content === 'string'), 'plan: artifacts must be {path, content}');
    c.expect(Array.isArray(plan.steps) && plan.steps.every((s) => typeof s === 'string'), 'plan: steps must be strings');
    c.expect(!JSON.stringify(plan).includes('change-me'), 'plan: must not inline secret values');
  }
  if (!f.live) { c.skip('up/down: live fixture not set'); return c; }
  const endpoints = await c.attempt('up', () => port.up(services), c.deployTimeoutMs);
  c.expect(Array.isArray(endpoints), 'up: must resolve to endpoints');
  c.produced('up', endpoints);
  await c.attempt('down', () => port.down(services), c.deployTimeoutMs);
  return c;
}

export async function checkSecrets(port: SecretPort, f: { known?: [string, string] } = {}, c = new Checks()): Promise<Checks> {
  c.expect(await c.attempt('get unknown', () => port.get('conformance-missing-secret')) === undefined, 'get: unknown ref must resolve to undefined');
  if (f.known) c.expect(await c.attempt('get known', () => port.get(f.known![0])) === f.known[1], 'get: wrong value for known ref');
  else c.skip('get known: needs a known secret fixture');
  return c;
}

/** Approval id of the fake host's waiting runs and pending tool calls. */
export const CONFORMANCE_APPROVAL = 'conformance-approval';
/** Text that makes the fake host end a run (or a tool call) with this status: `conformance:waiting`, `conformance:stopped`. */
export const conformanceInput = (status: 'completed' | 'waiting' | 'stopped') => `conformance:${status}`;

const statusIn = (text: string) => (text.includes(conformanceInput('waiting')) ? 'waiting' : text.includes(conformanceInput('stopped')) ? 'stopped' : 'completed');

/**
 * Host that echoes, records every call context, and ends a run (or a call of its one tool, `conformance__echo` with
 * `{text}`) `waiting` for an approval or `stopped` by a guard when the text asks for it.
 */
const fakeHost = (c: Checks): ChannelHost & { calls: string[]; contexts: Partial<CallContext>[] } => {
  const calls: string[] = [];
  const contexts: Partial<CallContext>[] = [];
  return {
    calls,
    contexts,
    agents: () => ['conformance'],
    run: async (_agent, input, ctx = {}) => {
      calls.push(typeof input === 'string' ? input : 'messages');
      contexts.push(ctx);
      c.produced('channel input', input);
      const text = typeof input === 'string' ? input : lastUserText(input.messages);
      const status = statusIn(text);
      if (status === 'waiting') {
        return { runId: 'conformance-run', status, output: '', reason: { code: 'needs_input', layer: 'identity', by: 'approval', detail: CONFORMANCE_APPROVAL }, ext: { 'sdk.approval': { id: CONFORMANCE_APPROVAL } } };
      }
      if (status === 'stopped') return { runId: 'conformance-run', status, output: '', reason: { code: 'guard_block', layer: 'guardrail', by: 'conformance', stage: 'input' } };
      return { runId: 'conformance-run', status, output: `echo:${typeof input === 'string' ? input : ''}` };
    },
    tools: () => ({
      listTools: async () => [{ name: 'conformance__echo', description: 'Echoes text.', params: { type: 'object', properties: { text: { type: 'string' } } }, risk: 'read' }],
      async callTool(_name, args, ctx) {
        contexts.push(ctx);
        const text = String(args?.text ?? '');
        const status = statusIn(text);
        if (status === 'waiting') return { ok: false, text: `Waiting for approval ${CONFORMANCE_APPROVAL}`, ext: { 'sdk.outcome': 'pending', 'sdk.approval': CONFORMANCE_APPROVAL } };
        if (status === 'stopped') return { ok: false, text: 'Blocked by guardrail conformance', ext: { 'sdk.outcome': 'blocked' } };
        return { ok: true, text: `echo:${text}`, ext: { 'sdk.outcome': 'ok' } };
      },
    }),
  };
};

export interface ChannelFixtures {
  /** Drive the served channel (send a message); the fake host records the inputs it received. */
  exercise?: (handle: ChannelHandle, host: ChannelHost) => Promise<void>;
  /** Drive the mounted channel through its routes (see `inboundFetch`); the fake host records the inputs. */
  exerciseMount?: (mount: InboundMount, host: ChannelHost) => Promise<void>;
  expectInput?: string;
  /**
   * Sends `text` through the mounted channel (see `inboundFetch`, whose test caller must reach the host), in session
   * `session` when given, and returns the outcome as the protocol shows it to the client (a task state, a finish
   * reason, a header). Enables the caller, status and session checks.
   */
  sendMount?: (mount: InboundMount, text: string, opts: { session?: string }) => Promise<string | undefined>;
  /** Outcome `sendMount` must return for a run (or tool call) that ended with each status; a missing one is not compared. */
  expectStates?: Partial<Record<'completed' | 'waiting' | 'stopped', string>>;
  /** The channel carries a client session (`sendMount` honours `session`); default false. */
  sessions?: boolean;
}

/** Caller, status mapping and session checks of a mounted channel, through `sendMount`. */
async function checkSend(mount: InboundMount, host: ReturnType<typeof fakeHost>, f: ChannelFixtures, c: Checks): Promise<void> {
  const send = (text: string, session?: string) => c.attempt(`send ${text}`, () => f.sendMount!(mount, text, session ? { session } : {}));
  const states: Partial<Record<'completed' | 'waiting' | 'stopped', string | undefined>> = {};
  for (const status of ['completed', 'waiting', 'stopped'] as const) {
    const before = host.contexts.length;
    states[status] = await send(conformanceInput(status));
    if (!c.expect(host.contexts.length > before, `send: the host never received "${conformanceInput(status)}"`)) continue;
    const expected = f.expectStates?.[status];
    if (expected !== undefined) c.expect(states[status] === expected, `status ${status}: the client saw "${states[status]}", expected "${expected}"`);
    c.expect(host.contexts.at(-1)?.caller?.id === 'conformance-user', `send: the verified caller did not reach the host (status ${status})`);
  }
  c.expect(states.waiting !== states.completed, `status waiting: the client cannot tell it from completed (both "${states.waiting}")`);
  if (!f.sessions) { c.skip('session: the channel declares no client session'); return; }
  const sessionAt = async (session: string) => { await send(conformanceInput('completed'), session); return host.contexts.at(-1)?.sessionId; };
  const first = await sessionAt('conformance-session-1');
  const again = await sessionAt('conformance-session-1');
  const other = await sessionAt('conformance-session-2');
  c.expect(typeof first === 'string' && first.length > 0, 'session: a session given by the client did not reach the host as sessionId');
  c.expect(first === again, 'session: the same session given twice reached the host as different sessionIds');
  c.expect(first !== other, 'session: two sessions reached the host as the same sessionId');
}

/** Calls the route of a mount that matches the request, as a host server would, with a verified test caller. */
export async function inboundFetch(mount: InboundMount, req: Request, ctx: Partial<InboundContext> = {}): Promise<Response> {
  const url = new URL(req.url);
  const { route, allowed } = findRoute(mount.routes, req.method, url.pathname);
  if (!route) return new Response(null, { status: allowed.length ? 405 : 404 });
  return route.handle(req, { requestId: 'conformance-request', signal: req.signal, origin: url.origin, caller: { id: 'conformance-user', kind: 'user', roles: [], scopes: [] }, ...ctx });
}

function checkMount(mount: InboundMount | undefined, c: Checks, label: string): mount is InboundMount {
  if (!c.expect(mount && Array.isArray(mount.routes) && mount.routes.length > 0, `${label}: must resolve to { routes } with at least one route`)) return false;
  for (const [i, r] of mount!.routes.entries()) {
    c.expect(typeof r.path === 'string' && r.path.startsWith('/'), `${label}: route[${i}].path must start with /`);
    c.expect(typeof r.handle === 'function', `${label}: route[${i}].handle must be a function`);
    c.expect(!r.methods || (Array.isArray(r.methods) && r.methods.every((m) => m === m.toUpperCase())), `${label}: route[${i}].methods must be upper-case`);
  }
  return true;
}

export async function checkChannel(port: ChannelPort, f: ChannelFixtures = {}, c = new Checks()): Promise<Checks> {
  c.expect(typeof port.serve === 'function' || typeof port.mount === 'function', 'channel needs serve() or mount()');
  if (port.serve) {
    const host = fakeHost(c);
    const handle = await c.attempt('serve', () => port.serve!(host));
    if (handle) {
      c.expect(typeof handle.close === 'function', 'serve: handle needs close()');
      if (f.exercise) {
        await c.attempt('exercise', () => f.exercise!(handle, host));
        if (f.expectInput) c.expect(host.calls.includes(f.expectInput), `exercise: host never received "${f.expectInput}"`);
      } else c.skip('exercise: no fixture');
      await c.attempt('close', () => handle.close());
    }
  }
  if (port.mount) {
    const host = fakeHost(c);
    const mount = await c.attempt('mount', () => port.mount!(host));
    if (checkMount(mount, c, 'mount')) {
      if (f.exerciseMount) {
        await c.attempt('exercise mount', () => f.exerciseMount!(mount, host));
        if (f.expectInput) c.expect(host.calls.includes(f.expectInput), `exercise mount: host never received "${f.expectInput}"`);
      } else c.skip('exercise mount: no fixture');
      if (f.sendMount) await checkSend(mount, host, f, c);
      else c.skip('send: no sendMount fixture (caller, status and session checks)');
      if (mount.close) await c.attempt('close mount', () => mount.close!());
    }
  }
  return c;
}

export interface TriggerFixtures {
  fire?: () => Promise<void>;
  /** Send an event through the mounted routes (see `inboundFetch`). */
  fireMount?: (mount: InboundMount) => Promise<void>;
}

export async function checkTrigger(port: TriggerPort, f: TriggerFixtures = {}, c = new Checks()): Promise<Checks> {
  c.expect(typeof port.start === 'function' || typeof port.mount === 'function', 'trigger needs start() or mount()');
  const seen: Trigger[] = [];
  const validate = (label: string) => {
    c.expect(seen.length > 0, `${label}: no trigger was delivered`);
    seen.forEach((t, i) => c.all(conforms('trigger', t), `trigger[${i}]`));
    c.produced(label, seen);
    seen.length = 0;
  };
  if (port.start) {
    const handle = await c.attempt('start', () => port.start!(async (t) => { seen.push(t); }));
    if (handle) {
      if (f.fire) {
        await c.attempt('fire', () => f.fire!());
        await new Promise((r) => setTimeout(r, 50));
        validate('fire');
      } else c.skip('fire: no fixture');
      await c.attempt('close', () => handle.close());
    }
  }
  if (port.mount) {
    const sink: TriggerSink = { agents: () => ['conformance'], accept: async (t) => { seen.push(t); return { runId: t.id }; } };
    const mount = await c.attempt('mount', () => port.mount!(sink));
    if (checkMount(mount, c, 'mount')) {
      if (f.fireMount) {
        await c.attempt('fire mount', () => f.fireMount!(mount));
        validate('fire mount');
      } else c.skip('fire mount: no fixture');
      if (mount.close) await c.attempt('close mount', () => mount.close!());
    }
  }
  return c;
}
