// Live contract test against reference/identity (Keycloak 26.4.2 + OPA 1.10.1). Skips when the stack is not running:
//   docker compose -f reference/identity/compose.yml --env-file .env.example up -d --wait
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { compose, recordingTelemetry, resolveProfile, toolAccessRequest, type Identity, type TelemetryRecord } from '@agent-layers/core';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter as basicRuntime } from '@agent-layers/adapter-basic-runtime';
import { adapter as functions, defineTool } from '@agent-layers/adapter-functions';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { adapter as opa } from '../../opa/src/index.ts';
import { createOidcCredentials, createOidcIdentity, credentialAdapter, identityAdapter } from '../src/index.ts';

const env = process.env;
const issuer = env.OIDC_ISSUER ?? 'http://localhost:8080/realms/agents';
const clientId = env.OIDC_CLIENT_ID ?? 'agent-runtime';
const clientSecret = env.OIDC_CLIENT_SECRET ?? 'change-me';
const toolsAudience = env.TOOLS_AUDIENCE ?? 'tools-api';
const opaUrl = env.OPA_URL ?? 'http://localhost:8181';
// Test-only users of reference/identity/realm/agents-realm.json; the `agents-test` client exists for these tests only.
const USERS = { alice: 'alice-test-only', bob: 'bob-test-only' } as const;

const up = async (url: string) => fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
const skip = !(await up(`${issuer}/.well-known/openid-configuration`)) || !(await up(`${opaUrl}/health`))
  ? `reference/identity not reachable (${issuer}, ${opaUrl})` : false;

async function passwordToken(user: keyof typeof USERS): Promise<string> {
  const res = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'agents-test', username: user, password: USERS[user], scope: 'openid' }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(res.status, 200, `password grant for ${user}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/**
 * Keycloak's client-credentials tokens carry the service-account user id as `sub`. The realm import does not fix that
 * id, so it is read once through the admin API (test-only admin password from .env.example).
 */
async function serviceAccountId(client: string): Promise<string> {
  const base = issuer.slice(0, issuer.indexOf('/realms/'));
  const realm = issuer.slice(issuer.indexOf('/realms/') + 8);
  const admin = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: env.KEYCLOAK_ADMIN_PASSWORD ?? 'change-me' }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(admin.status, 200, 'admin token');
  const headers = { authorization: `Bearer ${((await admin.json()) as { access_token: string }).access_token}` };
  const get = async (path: string) => (await fetch(`${base}/admin/realms/${realm}${path}`, { headers, signal: AbortSignal.timeout(10_000) })).json() as Promise<any>;
  const [found] = await get(`/clients?clientId=${encodeURIComponent(client)}`);
  return (await get(`/clients/${found.id}/service-account-user`)).id;
}

let agentSubjects: Record<string, string> = {};
const agentOptions = () => ({ agentClients: [clientId], agentSubjects });
const inbound = () => createOidcIdentity({ issuer, audience: clientId, ...agentOptions() });
const downstream = () => createOidcIdentity({ issuer, audience: toolsAudience, ...agentOptions() });

describe('reference/identity (Keycloak + OPA)', { skip }, () => {
  let alice: Identity;
  let bob: Identity;
  before(async () => {
    agentSubjects = { [clientId]: await serviceAccountId(clientId) };
    alice = await inbound().verify(await passwordToken('alice'));
    bob = await inbound().verify(await passwordToken('bob'));
  });

  test('verifies Keycloak user tokens; passes IdentityPort conformance', async () => {
    assert.equal(alice.kind, 'user');
    assert.equal(alice.claims?.preferred_username, 'alice');
    assert.ok(alice.roles?.includes('analyst'));
    assert.ok(bob.roles?.includes('viewer') && !bob.roles.includes('analyst'));
    await assert.rejects(downstream().verify(alice.token!), /audience/);
    const report = await checkAdapter(identityAdapter, { options: { issuer, audience: clientId }, fixtures: { valid: alice.token, expectSubject: alice.subject } });
    assert.deepEqual(report.failures, []);
  });

  test('exchanges alice\'s token on her behalf for tools-api (RFC 8693)', async () => {
    const creds = createOidcCredentials({ issuer, clientId, clientSecret, mode: 'on-behalf-of' });
    const token = await creds.token(toolsAudience, { identity: alice });
    const exchanged = await downstream().verify(token);
    assert.equal(exchanged.subject, alice.subject);
    assert.equal(exchanged.kind, 'user');
    assert.equal(exchanged.claims?.azp, clientId);
    assert.ok([exchanged.claims?.aud].flat().includes(toolsAudience));
    assert.equal(await creds.token(toolsAudience, { identity: alice }), token, 'cached');
    assert.notEqual(await creds.token(toolsAudience, { identity: bob }), token, 'per caller');
  });

  test('gets the agent its own token with client_credentials; passes CredentialPort conformance', async () => {
    const token = await createOidcCredentials({ issuer, clientId, clientSecret, mode: 'self' }).token(toolsAudience);
    const self = await downstream().verify(token);
    assert.equal(self.kind, 'agent');
    assert.equal(self.subject, agentSubjects[clientId]);
    assert.equal(self.claims?.azp, clientId);
    assert.equal((await createOidcIdentity({ issuer, audience: toolsAudience }).verify(token)).kind, 'user', 'without agentClients never agent');
    const report = await checkAdapter(credentialAdapter, { options: { issuer, clientId, clientSecret, mode: 'self' }, fixtures: { audience: toolsAudience } });
    assert.deepEqual(report.failures, []);
  });

  test('OPA allows alice and denies bob on a write tool (AuthorizationPort conformance)', async () => {
    const spec = { name: 'notes__save', description: 's', inputSchema: {}, risk: 'write' as const };
    const req = (identity?: Identity) => toolAccessRequest('notes__save', spec, {}, { runId: 'r', agent: 'notes', ...(identity ? { identity } : {}) });
    const report = await checkAdapter(opa, { options: { url: opaUrl }, fixtures: { allow: [req(alice)], deny: [req(bob), req()] } });
    assert.deepEqual(report.failures, []);
  });

  test('composed stack: alice saves on her own behalf, bob is denied by OPA, no token reaches telemetry', async () => {
    const records: TelemetryRecord[] = [];
    const issued: string[] = [];
    const save = defineTool({
      name: 'save_note', description: 'Saves a note', risk: 'write', audience: toolsAudience,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      async run(_args, ctx) {
        const token = await ctx.credentials!.token(toolsAudience);
        issued.push(token);
        return `saved for ${(await downstream().verify(token)).subject}`;
      },
    });
    const config = resolveProfile({
      layers: {
        identity: { adapter: 'oidc', options: { issuer, audience: clientId, ...agentOptions() } },
        credentials: { adapter: 'oidc', options: { issuer, clientId, clientSecret, mode: 'on-behalf-of' } },
        authorization: { adapter: 'opa', options: { url: opaUrl } },
        model: { adapter: 'mock-model', options: { rules: [{ match: 'save', tool: 'save_note', args: { text: 'hello' } }] } },
        runtime: { adapter: 'basic-runtime', options: { maxTurns: 3 } },
        tools: { notes: { adapter: 'functions' } },
      },
      agents: { notes: { instructions: 'You save notes.', model: 'mock', tools: ['notes__*'] } },
    });
    const notes = { ...functions, create: () => functions.create({ tools: [save] }, { name: 'notes', env: {}, cwd: process.cwd(), telemetry: undefined as never }) };
    const stack = await compose(config, { adapters: [identityAdapter, credentialAdapter, opa, mockModel, basicRuntime, notes], telemetry: [recordingTelemetry((r) => records.push(r))] });
    try {
      const agent = await stack.agent('notes');
      const asAlice = await agent.run('save a note', { identity: await stack.verify(alice.token!) });
      assert.equal(asAlice.output, `saved for ${alice.subject}`);
      const asBob = await agent.run('save a note', { identity: await stack.verify(bob.token!) });
      assert.match(asBob.output, new RegExp(`^Denied: user ${bob.subject} may not call write tools$`));
      const anonymous = await agent.run('save a note');
      assert.match(anonymous.output, /^Denied: anonymous anonymous may not call write tools$/);
      assert.equal(issued.length, 1, 'denied calls never get a token');

      const dump = JSON.stringify([records, asAlice.events, asBob.events, anonymous.events]);
      for (const secret of [alice.token!, bob.token!, ...issued, clientSecret]) assert.ok(!dump.includes(secret), 'no token or secret in telemetry or events');
      assert.ok(records.some((r) => r.name === 'authorize'), 'authorization was traced');
    } finally {
      await stack.close();
    }
  });
});
