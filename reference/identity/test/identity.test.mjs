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

// Test-only users and passwords from realm/agents-realm.json; the `agents-test` client exists only for these tests.
const USERS = { alice: 'alice-test-only', bob: 'bob-test-only' };

const { oidcVerifier, oidcCredentials, opaAuthorizer, mockProvider, defineTool, collectSink, run, createRuntime, serve, checkIdentityVerifier, checkAuthorizer, accessRequest } = reinloop;

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
const downstream = () => oidcVerifier({ issuer, audience: toolsAudience });

const tool = (name, risk) => defineTool({ name, description: name, risk, schema: { type: 'object', properties: {} }, run: () => `${name} done` });

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

  it('OPA allows alice and denies bob on a write tool through a reinloop run', async () => {
    const authorizer = opaAuthorizer({ url: opaUrl, path: 'agents/decision' });
    const outcome = async (identity) => {
      const sink = collectSink();
      const agent = {
        name: 'notes',
        model: { provider: mockProvider([{ toolCalls: [{ name: 'save_note', args: {} }, { name: 'run_shell', args: {} }] }, { text: 'done' }]), model: 'mock' },
        tools: [tool('save_note', 'write'), tool('run_shell', 'exec')],
        policy: { risk: { write: 'allow', exec: 'allow' }, pdp: { authorizer } },
      };
      const res = await run(agent, 'save a note', { identity, sinks: [sink] });
      assert.equal(res.status, 'completed');
      assert.ok(!JSON.stringify(sink.events).includes(identity.token), 'no token in events');
      return Object.fromEntries(sink.events.filter((e) => e.type === 'tool_decision').map((e) => [e.data.name, e.data]));
    };
    const a = await outcome(alice);
    assert.equal(a.save_note.allowed, true);
    assert.deepEqual([a.run_shell.allowed, a.run_shell.reason], [false, 'pdp: exec tools are denied to everyone']);
    const b = await outcome(bob);
    assert.equal(b.save_note.allowed, false);
    assert.match(b.save_note.reason, /^pdp: user .* may not call write tools$/);

    const req = (id) => accessRequest({ type: 'tool_call', id: 'c', name: 'save_note', args: {} }, tool('save_note', 'write'), 'notes', id);
    assert.deepEqual(await checkAuthorizer(opaAuthorizer({ url: opaUrl }), { allowCase: req(alice), denyCase: req(bob) }), []);
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
