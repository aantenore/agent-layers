import { GUARD_STAGES, type AccessRequest, type ApprovalPort, type AuthorizationPort, type CredentialPort, type GuardPort, type GuardStage, type IdentityPort } from '@agent-layers/core';
import { Checks } from '../check.ts';
import { conforms, schema } from '../schemas.ts';
import { validate } from '@agent-layers/core';

export interface IdentityFixtures { valid?: string; expectSubject?: string; invalid?: string[] }

export async function checkIdentity(port: IdentityPort, f: IdentityFixtures = {}, c = new Checks()): Promise<Checks> {
  for (const bad of f.invalid ?? ['', 'not-a-credential']) await c.rejects(`verify(${JSON.stringify(bad)})`, () => port.verify(bad));
  if (!f.valid) { c.skip('verify valid: needs a valid credential fixture'); return c; }
  const id = await c.attempt('verify valid', () => port.verify(f.valid!));
  if (id) {
    const { token: _t, ...pub } = id;
    c.all(conforms('identity', pub), 'identity');
    if (f.expectSubject) c.expect(id.subject === f.expectSubject, `verify: subject "${id.subject}", expected "${f.expectSubject}"`);
  }
  return c;
}

export async function checkCredentials(port: CredentialPort, f: { audience?: string } = {}, c = new Checks()): Promise<Checks> {
  const token = await c.attempt('token', () => port.token(f.audience ?? 'conformance'));
  c.expect(typeof token === 'string' && token.length > 0, 'token: must resolve to a non-empty string');
  return c;
}

export const sampleAccess = (over: { tool?: string; risk?: 'read' | 'write' | 'exec'; roles?: string[]; kind?: 'user' | 'agent' } = {}): AccessRequest => ({
  subject: { type: over.kind ?? 'user', id: 'conformance-user', properties: { roles: over.roles ?? [], scopes: [], authenticated: true } },
  action: { name: 'call' },
  resource: { type: 'tool', id: over.tool ?? 'conformance__read', properties: { risk: over.risk ?? 'read', agent: 'conformance' } },
  context: { args: {} },
});

export interface AuthorizationFixtures { allow?: AccessRequest[]; deny?: AccessRequest[] }

export async function checkAuthorization(port: AuthorizationPort, f: AuthorizationFixtures = {}, c = new Checks()): Promise<Checks> {
  const sample = await c.attempt('evaluate', () => port.evaluate(sampleAccess()));
  if (sample) c.all(conforms('access-decision', sample), 'decision');
  for (const [i, r] of (f.allow ?? []).entries()) c.expect((await c.attempt(`allow #${i}`, () => port.evaluate(r)))?.decision === true, `allow #${i}: expected decision true`);
  for (const [i, r] of (f.deny ?? []).entries()) c.expect((await c.attempt(`deny #${i}`, () => port.evaluate(r)))?.decision === false, `deny #${i}: expected decision false`);
  const anon = sampleAccess({ risk: 'read' });
  anon.subject = { type: 'anonymous', id: 'anonymous', properties: { roles: [], scopes: [], authenticated: false } };
  const anonymous = await c.attempt('evaluate anonymous', () => port.evaluate(anon));
  if (anonymous) c.expect(anonymous.decision !== true, 'anonymous: an unauthenticated subject must be denied');
  return c;
}

export async function checkApproval(port: ApprovalPort, _f: unknown = {}, c = new Checks()): Promise<Checks> {
  const req = { access: sampleAccess({ risk: 'write' }), agent: 'conformance', runId: 'conformance-run' };
  const a = await c.attempt('request', () => port.request(req));
  if (!a) return c;
  c.all(conforms('approval', a), 'approval');
  c.expect(a.status === 'pending', 'request: a new approval must be pending');
  c.expect((await c.attempt('get', () => port.get(a.id)))?.id === a.id, 'get: must return the approval');
  c.expect((await c.attempt('get unknown', () => port.get('conformance-missing'))) === undefined, 'get: unknown id must resolve to undefined');
  const b = await c.attempt('request second', () => port.request(req));
  if (b) c.expect((await c.attempt('wait with timeout', () => port.wait(b.id, { timeoutMs: 20 })))?.status === 'pending', 'wait: must resolve pending on timeout');
  const waiting = port.wait(a.id, { timeoutMs: 2000 });
  c.expect((await c.attempt('decide', () => port.decide(a.id, { approved: true, by: 'conformance' })))?.status === 'approved', 'decide: status must be approved');
  c.expect((await c.attempt('wait', () => waiting))?.status === 'approved', 'wait: must resolve once decided');
  return c;
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
    const v = await c.attempt(`check ${s.stage} ${JSON.stringify(s.text.slice(0, 30))}`, () => port.check({ ...s, agent: 'conformance', runId: 'conformance-run' }));
    if (v) c.all(validate(schema('guard-verdict'), v, 'verdict'), `verdict for ${s.stage}`);
    return v;
  };
  for (const s of f.allow ?? stages.map((stage) => ({ stage, text: 'The weather is pleasant today.' }))) {
    const v = await run(s);
    if (v) c.expect(v.action === 'allow', `allow: ${s.stage} sample got ${v.action}`);
  }
  for (const s of f.block ?? []) {
    const v = await run(s);
    if (v) c.expect(v.action === 'block', `block: ${s.stage} sample got ${v.action}`);
  }
  for (const s of f.redact ?? []) {
    const v = await run(s);
    if (v && c.expect(v.action === 'redact', `redact: ${s.stage} sample got ${v.action}`)) {
      c.expect(typeof v.text === 'string' && !v.text.includes(s.secret), `redact: ${s.stage} text still contains the secret`);
    }
  }
  return c;
}
