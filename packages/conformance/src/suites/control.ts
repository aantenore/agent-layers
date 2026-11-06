import { GUARD_STAGES, PORT_VERSIONS, validate, versionAtLeast, type AccessQuestion, type ApprovalPort, type ApprovalRequest, type AuthorizationPort, type Caller, type CredentialPort, type GuardPort, type GuardStage, type GuardVerdict, type IdentityPort } from '@agent-layers/core';
import { Checks } from '../check.ts';
import { conforms, schema } from '../schemas.ts';

export interface IdentityFixtures { valid?: string; expectId?: string; invalid?: string[] }

export async function checkIdentity(port: IdentityPort, f: IdentityFixtures = {}, c = new Checks()): Promise<Checks> {
  for (const bad of f.invalid ?? ['', 'not-a-credential']) await c.rejects(`verify(${JSON.stringify(bad)})`, () => port.verify(bad));
  // Without a credential to verify, only the rejections above ran: the report then counts no attempt, so it is not an ok.
  if (!f.valid) { c.skip(`verify valid: ${NEEDS_CALLER}`); return c; }
  const caller = await c.attempt('verify valid', (signal) => port.verify(f.valid!, { signal }));
  if (caller) {
    const { credential: _credential, ...pub } = caller;
    c.all(conforms('caller', pub), 'caller');
    c.produced('verify', caller);
    if (f.expectId) c.expect(caller.id === f.expectId, `verify: id "${caller.id}", expected "${f.expectId}"`);
  }
  return c;
}

export interface CredentialFixtures {
  /** Audience to request (default `conformance`); a real provider may only issue tokens for audiences it knows. */
  audience?: string;
  /** Caller to act for. Required, with its inbound `credential`, to probe an adapter with `requiresCaller`. */
  caller?: Caller;
}

/** Why the token probe of an on-behalf-of adapter is skipped without a caller. */
export const NEEDS_CALLER = 'needs a caller token (--token)';

export async function checkCredentials(port: CredentialPort, f: CredentialFixtures = {}, c = new Checks()): Promise<Checks> {
  const audience = f.audience ?? 'conformance';
  if (port.requiresCaller) {
    // On behalf of a caller only: never a silent fallback to the agent's own identity.
    await c.rejects('token without a caller', () => port.token(audience));
    if (!f.caller?.credential) { c.skip(`token: ${NEEDS_CALLER}`); return c; }
  }
  const token = await c.attempt('token', (signal) => port.token(audience, { ...(f.caller ? { caller: f.caller } : {}), signal }));
  c.expect(typeof token === 'string' && token.length > 0, 'token: must resolve to a non-empty string');
  return c;
}

/** A question about calling a tool, for the authorization and approval suites. */
export const sampleQuestion = (over: { tool?: string; risk?: 'read' | 'write' | 'exec'; roles?: string[]; kind?: 'user' | 'agent' } = {}): AccessQuestion => ({
  caller: { id: 'conformance-user', kind: over.kind ?? 'user', roles: over.roles ?? [], scopes: [] },
  action: 'call',
  target: { kind: 'tool', id: over.tool ?? 'conformance__read', layer: 'tool', risk: over.risk ?? 'read', agent: 'conformance' },
  args: {},
});

export interface AuthorizationFixtures { allow?: AccessQuestion[]; deny?: AccessQuestion[] }

export async function checkAuthorization(port: AuthorizationPort, f: AuthorizationFixtures = {}, c = new Checks()): Promise<Checks> {
  const sample = await c.attempt('evaluate', (signal) => port.evaluate(sampleQuestion(), { signal }));
  if (sample) {
    c.all(conforms('access-decision', sample), 'decision');
    c.produced('evaluate', sample);
  }
  for (const [i, q] of (f.allow ?? []).entries()) {
    const d = await c.attempt(`allow #${i}`, (signal) => port.evaluate(q, { signal }));
    c.expect(d?.allowed === true, `allow #${i}: expected allowed true`);
    c.produced(`allow #${i}`, d);
  }
  for (const [i, q] of (f.deny ?? []).entries()) {
    const d = await c.attempt(`deny #${i}`, (signal) => port.evaluate(q, { signal }));
    c.expect(d?.allowed === false, `deny #${i}: expected allowed false`);
    c.produced(`deny #${i}`, d);
  }
  const anonymous: AccessQuestion = { ...sampleQuestion({ risk: 'read' }), caller: { kind: 'anonymous', id: 'anonymous', roles: [], scopes: [] } };
  const decision = await c.attempt('evaluate anonymous', (signal) => port.evaluate(anonymous, { signal }));
  if (decision) {
    c.expect(decision.allowed !== true, 'anonymous: an unauthenticated caller must be denied');
    c.produced('evaluate anonymous', decision);
  }
  return c;
}

export interface ApprovalFixtures {
  /** ApprovalPort version the adapter implements (`checkAdapter` passes its descriptor's; default: the core's). `list` and `cancel` are checked from 1.2.0. */
  portVersion?: string;
}

export async function checkApproval(port: ApprovalPort, f: ApprovalFixtures = {}, c = new Checks()): Promise<Checks> {
  const req = { question: sampleQuestion({ risk: 'write' }), agent: 'conformance', runId: 'conformance-run' };
  const a = await c.attempt('request', () => port.request(req));
  if (!a) return c;
  c.all(conforms('approval', a), 'approval');
  c.produced('request', a);
  c.expect(a.status === 'pending', 'request: a new approval must be pending');
  c.expect((await c.attempt('get', () => port.get(a.id)))?.id === a.id, 'get: must return the approval');
  c.expect((await c.attempt('get unknown', () => port.get('conformance-missing'))) === undefined, 'get: unknown id must resolve to undefined');
  const b = await c.attempt('request second', () => port.request(req));
  if (b) c.expect((await c.attempt('wait with timeout', () => port.wait(b.id, { timeoutMs: 20 })))?.status === 'pending', 'wait: must resolve pending on timeout');
  const waiting = port.wait(a.id, { timeoutMs: 2000 });
  const decided = await c.attempt('decide', () => port.decide(a.id, { approved: true, by: 'conformance' }));
  c.expect(decided?.status === 'approved', 'decide: status must be approved');
  c.produced('decide', decided);
  c.expect((await c.attempt('wait', () => waiting))?.status === 'approved', 'wait: must resolve once decided');
  if (port.lookup) await checkApprovalLookup(port, req, c);
  const version = f.portVersion ?? PORT_VERSIONS.ApprovalPort;
  if (!versionAtLeast(version, '1.2.0')) c.skip(`list, cancel: ApprovalPort ${version} predates them (1.2.0)`);
  else if (!port.list || !port.cancel) c.skip('list, cancel: optional, not implemented');
  else await checkApprovalListCancel(port, req, c);
  return c;
}

/** `list` and `cancel` (ApprovalPort 1.2.0, optional): pending approvals oldest first; a cancelled one leaves the list. */
async function checkApprovalListCancel(port: ApprovalPort, base: ApprovalRequest, c: Checks): Promise<void> {
  const list = port.list!.bind(port);
  const cancel = port.cancel!.bind(port);
  const runId = `conformance-list-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const first = await c.attempt('request to list', () => port.request({ ...base, runId }));
  const second = await c.attempt('request to list again', () => port.request({ ...base, runId }));
  if (!first || !second) return;
  const pending = await c.attempt('list', () => list());
  if (pending) {
    pending.forEach((a, i) => c.all(conforms('approval', a), `listed approval[${i}]`));
    c.produced('list', pending);
    c.expect(pending.every((a) => a.status === 'pending'), 'list: without status must return pending approvals only');
    const ids = pending.map((a) => a.id);
    c.expect(ids.includes(first.id) && ids.indexOf(first.id) < ids.indexOf(second.id), 'list: must return pending approvals, oldest first');
    c.expect(!JSON.stringify(pending).includes('"credential"'), 'list: approvals must not carry a caller credential');
  }
  c.expect((await c.attempt('list limit', () => list({ limit: 1 })))?.length === 1, 'list: must respect limit');
  const waiting = port.wait(second.id, { timeoutMs: 2000 });
  const cancelled = await c.attempt('cancel', () => cancel(second.id, { by: 'conformance' }));
  c.expect(cancelled?.status === 'cancelled' && cancelled.decidedBy === 'conformance', 'cancel: status must be cancelled, decidedBy the one who cancelled');
  c.expect((await c.attempt('wait cancelled', () => waiting))?.status === 'cancelled', 'wait: must resolve once cancelled');
  c.expect((await c.attempt('get cancelled', () => port.get(second.id)))?.status === 'cancelled', 'get: must return the cancelled approval');
  c.expect(!(await c.attempt('list after cancel', () => list()))?.some((a) => a.id === second.id), 'list: a cancelled approval is no longer pending');
  c.expect(!!(await c.attempt('list cancelled', () => list({ status: 'cancelled' })))?.some((a) => a.id === second.id), 'list: status cancelled must return it');
  await c.rejects('decide cancelled', () => port.decide(second.id, { approved: true }));
  await c.rejects('cancel twice', () => cancel(second.id));
  await c.rejects('cancel unknown', () => cancel('conformance-missing'));
  await c.attempt('cancel cleanup', () => cancel(first.id));
}

/** `lookup` (ApprovalPort 1.1.0, optional): by key, latest first; an approved approval is consumed once. */
async function checkApprovalLookup(port: ApprovalPort, base: ApprovalRequest, c: Checks): Promise<void> {
  const lookup = port.lookup!.bind(port);
  const key = `conformance-key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  c.expect((await c.attempt('lookup unknown key', () => lookup(`${key}-missing`))) === undefined, 'lookup: an unknown key must resolve to undefined');
  const first = await c.attempt('request with key', () => port.request({ ...base, key }));
  if (!first) return;
  c.all(conforms('approval', first), 'approval with key');
  c.expect((await c.attempt('lookup pending', () => lookup(key, { consume: true })))?.id === first.id, 'lookup: must return the approval requested with the key');
  c.expect((await c.attempt('lookup pending again', () => lookup(key)))?.status === 'pending', 'lookup: consume must leave a pending approval in place');
  await c.attempt('decide keyed', () => port.decide(first.id, { approved: true }));
  c.expect((await c.attempt('lookup approved', () => lookup(key, { consume: true })))?.status === 'approved', 'lookup: must return the approved approval');
  c.expect((await c.attempt('lookup consumed', () => lookup(key))) === undefined, 'lookup: a consumed approval must not be returned again');
  const denied = await c.attempt('request to deny', () => port.request({ ...base, key: `${key}-d` }));
  if (!denied) return;
  await c.attempt('decide deny', () => port.decide(denied.id, { approved: false }));
  await c.attempt('lookup denied', () => lookup(`${key}-d`, { consume: true }));
  c.expect((await c.attempt('lookup denied again', () => lookup(`${key}-d`, { consume: true })))?.status === 'denied', 'lookup: consume must not remove a denial');
}

export interface GuardSample { stage: GuardStage; text: string }
export interface GuardFixtures {
  /** Must be allowed (default: a harmless sentence at every stage the guard covers). */
  allow?: GuardSample[];
  block?: GuardSample[];
  /** Must be redacted; the redacted text must not contain `secret`. */
  redact?: (GuardSample & { secret: string })[];
}

export async function checkGuard(port: GuardPort, f: GuardFixtures = {}, c = new Checks()): Promise<Checks> {
  const stages = port.stages ?? GUARD_STAGES;
  c.expect(stages.every((s) => GUARD_STAGES.includes(s)), `stages: unknown stage in ${stages.join(', ')}`);
  const run = async (s: GuardSample) => {
    const v = await c.attempt(`check ${s.stage} ${JSON.stringify(s.text.slice(0, 30))}`, (signal) => port.check({ stage: s.stage, text: s.text, agent: 'conformance', runId: 'conformance-run' }, { signal }));
    if (v) {
      c.all(validate(schema('guard-verdict'), v, 'verdict'), `verdict for ${s.stage}`);
      c.produced(`check ${s.stage}`, v);
    }
    return v;
  };
  // The verdict reason says why ("llm-guard unavailable: authentication failed (HTTP 401)"), so a failure is diagnosable.
  const got = (v: GuardVerdict) => (v.reason ? `${v.action} (${v.reason})` : v.action);
  for (const s of f.allow ?? stages.map((stage) => ({ stage, text: 'The weather is pleasant today.' }))) {
    const v = await run(s);
    if (v) c.expect(v.action === 'allow', `allow: ${s.stage} sample got ${got(v)}`);
  }
  for (const s of f.block ?? []) {
    const v = await run(s);
    if (v) c.expect(v.action === 'block', `block: ${s.stage} sample got ${got(v)}`);
  }
  for (const s of f.redact ?? []) {
    const v = await run(s);
    if (v && c.expect(v.action === 'redact', `redact: ${s.stage} sample got ${got(v)}`)) {
      c.expect(typeof v.text === 'string' && !v.text.includes(s.secret), `redact: ${s.stage} text still contains the secret`);
    }
  }
  return c;
}
