import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reinloop } from '../../../lib/reinloop.mjs';
import { reachable } from '../../../lib/wait.mjs';

try { process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env')); } catch { /* .env is optional */ }

const issuer = process.env.OIDC_ISSUER ?? 'http://localhost:8080/realms/agents';
const clientId = process.env.OIDC_CLIENT_ID ?? 'agent-runtime';
const clientSecret = process.env.OIDC_CLIENT_SECRET ?? 'change-me';
const toolsAudience = process.env.TOOLS_AUDIENCE ?? 'tools-api';
const opaUrl = process.env.OPA_URL ?? 'http://localhost:8181';
// Fixed service-account user id of agent-runtime in realm/agents-realm.json: the `sub` of its client_credentials tokens.
const agentSubject = process.env.OIDC_AGENT_SUBJECT ?? '2f6d2c1e-7a4b-4c1d-9e3f-5b8a0c6d7e01';

// Test-only users and passwords from realm/agents-realm.json; the `agents-test` client exists only for these tests.
const USERS = { alice: 'alice-test-only', bob: 'bob-test-only' };

const { oidcVerifier, oidcCredentials, createRuntime, serve, checkIdentityVerifier } = reinloop;

async function skipReason() {
  if (!(await reachable(`${issuer}/.well-known/openid-configuration`))) return `Keycloak not reachable at ${issuer} (make up LAYER=identity)`;
  if (!(await reachable(`${opaUrl}/health`))) return `OPA not reachable at ${opaUrl} (make up LAYER=identity)`;
  return undefined;
}
const skip = await skipReason();
if (skip) console.log(`# skipping identity live tests: ${skip}`);

async function userToken(username) {
  const res = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'agents-test', username, password: USERS[username], scope: 'openid' }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(res.status, 200, `password grant for ${username}`);
  return (await res.json()).access_token;
}

// User tokens from the test client carry aud agent-runtime (audience mapper): the runtime is their audience.
const inbound = () => oidcVerifier({ issuer, audience: clientId });
// agent-runtime tokens are `agent` only when their `sub` is its service account (exchanged tokens keep the user's sub).
const downstream = () => oidcVerifier({ issuer, audience: toolsAudience, agentClients: [clientId], agentSubjects: { [clientId]: agentSubject } });

describe('l5 identity (Keycloak + OPA)', { skip }, () => {
  let alice;
  let bob;
  before(async () => {
    alice = await inbound().verify(await userToken('alice'));
    bob = await inbound().verify(await userToken('bob'));
  });

  it('verifies a Keycloak user token into an Identity', async () => {
    assert.equal(alice.kind, 'user');
    assert.equal(alice.claims.preferred_username, 'alice');
    assert.ok(alice.roles.includes('analyst'));
    assert.ok(bob.roles.includes('viewer') && !bob.roles.includes('analyst'));
    assert.deepEqual(await checkIdentityVerifier(inbound(), { validToken: alice.token, expect: { kind: 'user', roles: ['analyst'] } }), []);
    await assert.rejects(downstream().verify(alice.token), /audience/);
  });

  it('exchanges the user token on behalf of alice for the tools-api audience (RFC 8693)', async () => {
    const creds = oidcCredentials({ issuer, clientId, clientSecret, mode: 'on-behalf-of' })(alice);
    const token = await creds.token(toolsAudience);
    const exchanged = await downstream().verify(token);
    assert.equal(exchanged.subject, alice.subject);
    assert.equal(exchanged.kind, 'user');
    assert.equal(exchanged.claims.azp, clientId);
    assert.ok([exchanged.claims.aud].flat().includes(toolsAudience));
    assert.equal(await creds.token(toolsAudience), token, 'cached');
  });

  it('gets the agent its own token with client_credentials (kind agent)', async () => {
    const creds = oidcCredentials({ issuer, clientId, clientSecret, mode: 'self' })();
    const self = await downstream().verify(await creds.token(toolsAudience));
    assert.equal(self.kind, 'agent');
    assert.equal(self.claims.azp, clientId);
  });

  it('OPA decides on AccessQuestions in SDK names: alice writes, bob reads only, exec and anonymous denied', async () => {
    // The question the `opa` adapter sends (adapters/opa): caller and target in SDK names, never a credential.
    const question = (identity, risk) => ({
      caller: identity ? { id: identity.subject, kind: identity.kind, roles: identity.roles ?? [], scopes: identity.scopes ?? [] } : { kind: 'anonymous', id: 'anonymous', roles: [], scopes: [] },
      action: 'call',
      target: { kind: 'tool', id: `notes__${risk}`, layer: 'tool', risk, agent: 'notes' },
    });
    const decide = async (identity, risk) => {
      const res = await fetch(`${opaUrl}/v1/data/agents/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: question(identity, risk) }), signal: AbortSignal.timeout(5000),
      });
      assert.equal(res.status, 200);
      return (await res.json()).result;
    };
    assert.deepEqual(await decide(alice, 'write'), { allow: true, reason: 'allowed' });
    assert.deepEqual(await decide(alice, 'exec'), { allow: false, reason: 'exec tools are denied to everyone' });
    assert.equal((await decide(bob, 'read')).allow, true);
    assert.match((await decide(bob, 'write')).reason, /^user .* may not call write tools$/);
    assert.equal((await decide(bob, 'write')).allow, false);
    assert.deepEqual(await decide(undefined, 'read'), { allow: false, reason: 'anonymous anonymous may not call read tools' });
  });

  it('serve answers 401 without a token and runs as the caller with one', async () => {
    const rt = await createRuntime({
      providers: { mock: { type: 'mock', responses: [{ text: 'hello' }], loop: true } },
      models: { m: { provider: 'mock', model: 'mock-1' } },
      agents: { echo: { model: 'm', description: 'Echo' } },
      identity: { verifier: { issuer, audience: clientId } },
    });
    const served = await serve(rt, { port: 0 });
    try {
      const url = `${served.url}/v1/agents/echo/runs`;
      const none = await fetch(url, { method: 'POST', body: '{"input":"hi"}' });
      assert.equal(none.status, 401);
      assert.match(none.headers.get('www-authenticate'), /^Bearer/);
      const ok = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${alice.token}` }, body: '{"input":"hi"}' });
      assert.equal(ok.status, 200);
      const events = await rt.store.load((await ok.json()).runId);
      assert.equal(events.find((e) => e.type === 'run_start').data.subject, alice.subject);
    } finally {
      await served.close();
      await rt.close();
    }
  });
});
