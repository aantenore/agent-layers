import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStaticCredentials, createStaticIdentity } from '../src/index.ts';

const identity = createStaticIdentity({
  tokens: {
    'user-tok': { subject: 'alice', roles: ['staff'], scopes: ['docs:read'], name: 'Alice', claims: { team: 'a' } },
    'bot-tok': { subject: 'bot', kind: 'agent' },
  },
});

test('verify maps a known credential to a caller carrying the credential', async () => {
  assert.deepEqual(await identity.verify('user-tok'), {
    id: 'alice', kind: 'user', roles: ['staff'], scopes: ['docs:read'], name: 'Alice', ext: { 'static-identity.claims': { team: 'a' } }, credential: 'user-tok',
  });
  assert.deepEqual(await identity.verify('bot-tok'), { id: 'bot', kind: 'agent', roles: [], scopes: [], credential: 'bot-tok' }, 'lists always present');
});

test('verify rejects unknown and empty credentials without echoing them', async () => {
  for (const bad of ['secret-guess', '', 'toString']) {
    await assert.rejects(identity.verify(bad), (err: Error) => err.message === 'invalid credential' && !err.message.includes(bad || 'x'));
  }
});

test('credentials resolve by audience, then default, else reject', async () => {
  const port = createStaticCredentials({ tokens: { api: 'tok-api' }, default: 'tok-any' });
  assert.equal(await port.token('api'), 'tok-api');
  assert.equal(await port.token('other'), 'tok-any');
  await assert.rejects(createStaticCredentials({ tokens: { api: 'x' } }).token('other'), /^Error: no token for audience other$/);
});
