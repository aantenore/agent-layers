import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compose, resolveProfile } from '@agent-layers/core';
import { checkAdapter } from '@agent-layers/conformance';
import { serveStack } from '@agent-layers/gateway';
import { adapter as basicRuntime } from '@agent-layers/adapter-basic-runtime';
import { adapter as functions, functionTools } from '@agent-layers/adapter-functions';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { channelAdapter } from '@agent-layers/adapter-openai-compatible';
import { createOidcCredentials, createOidcIdentity, credentialAdapter, identityAdapter } from '@agent-layers/adapter-oidc';
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
const inboundOptions = { issuer, audience: clientId };
const inbound = () => createOidcIdentity(inboundOptions);
// agent-runtime tokens are `agent` only when their `sub` is its service account (exchanged tokens keep the user's sub).
const downstream = () => createOidcIdentity({ issuer, audience: toolsAudience, keepClaims: true, agentClients: [clientId], agentSubjects: { [clientId]: agentSubject } });
const claimsOf = (caller) => caller.ext?.['oidc.claims'];

describe('l5 identity (Keycloak + OPA)', { skip }, () => {
  let alice;
  let bob;
  before(async () => {
    alice = await inbound().verify(await userToken('alice'));
    bob = await inbound().verify(await userToken('bob'));
  });

  it('verifies a Keycloak user token into an Identity', async () => {
    assert.equal(alice.kind, 'user');
    assert.equal(alice.name, 'alice');
    assert.ok(alice.roles.includes('analyst'));
    assert.ok(bob.roles.includes('viewer') && !bob.roles.includes('analyst'));
    await assert.rejects(downstream().verify(alice.credential), /audience/);
    const report = await checkAdapter(identityAdapter, { options: inboundOptions, fixtures: { valid: alice.credential, expectId: alice.id } });
    assert.deepEqual(report.failures, []);
  });

  it('exchanges the user token on behalf of alice for the tools-api audience (RFC 8693)', async () => {
    const creds = createOidcCredentials({ issuer, clientId, clientSecret, mode: 'on-behalf-of' });
    const token = await creds.token(toolsAudience, { caller: alice });
    const exchanged = await downstream().verify(token);
    assert.equal(exchanged.id, alice.id);
    assert.equal(exchanged.kind, 'user');
    assert.equal(claimsOf(exchanged).azp, clientId);
    assert.ok([claimsOf(exchanged).aud].flat().includes(toolsAudience));
    assert.equal(await creds.token(toolsAudience, { caller: alice }), token, 'cached');
    assert.notEqual(await creds.token(toolsAudience, { caller: bob }), token, 'per caller');
  });

  it('gets the agent its own token with client_credentials (kind agent)', async () => {
    const options = { issuer, clientId, clientSecret, mode: 'self' };
    const self = await downstream().verify(await createOidcCredentials(options).token(toolsAudience));
    assert.equal(self.kind, 'agent');
    assert.equal(self.id, agentSubject);
    assert.equal(claimsOf(self).azp, clientId);
    const report = await checkAdapter(credentialAdapter, { options, fixtures: { audience: toolsAudience } });
    assert.deepEqual(report.failures, []);
  });

  it('OPA decides on AccessQuestions in SDK names: alice writes, bob reads only, exec and anonymous denied', async () => {
    // The question the `opa` adapter sends (adapters/opa): caller and target in SDK names, never a credential.
    const question = (identity, risk) => ({
      caller: identity ? { id: identity.id, kind: identity.kind, roles: identity.roles ?? [], scopes: identity.scopes ?? [] } : { kind: 'anonymous', id: 'anonymous', roles: [], scopes: [] },
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

  it('the gateway answers 401 without a token and the stack runs as the caller with one', async () => {
    // The tool reports the caller of the run it is called in.
    const whoami = { name: 'whoami', description: 'Names the caller of the run.', params: { type: 'object', properties: {} }, risk: 'read', run: (_args, ctx) => ctx.caller?.id ?? 'anonymous' };
    const config = resolveProfile({
      layers: {
        identity: { adapter: 'oidc', options: inboundOptions },
        model: { adapter: 'mock-model', options: { rules: [{ match: 'who', tool: 'whoami', args: {} }] } },
        runtime: { adapter: 'basic-runtime', options: { maxTurns: 3 } },
        tools: { id: { adapter: 'functions' } },
        channels: [{ adapter: 'openai-compatible', options: { models: {}, agents: ['echo'] } }],
      },
      agents: { echo: { instructions: 'Name the caller.', model: 'mock', tools: ['id__*'] } },
    });
    const tools = { ...functions, create: () => functionTools([whoami], 'id') };
    const stack = await compose(config, { adapters: [identityAdapter, mockModel, basicRuntime, tools, channelAdapter] });
    const gw = await serveStack(stack, { port: 0 });
    try {
      const url = `${gw.url}/v1/chat/completions`;
      const body = JSON.stringify({ model: 'agent:echo', messages: [{ role: 'user', content: 'who am I' }] });
      const none = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.equal(none.status, 401);
      assert.match(none.headers.get('www-authenticate'), /^Bearer/);
      const ok = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.credential}` }, body });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).choices[0].message.content, alice.id);
    } finally {
      await gw.close();
      await stack.close();
    }
  });
});
