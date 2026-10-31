import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testContext } from '@agent-layers/conformance';
import { createStaticRouter } from '../src/index.ts';

const req = (model: string) => ({ model, messages: [{ role: 'user' as const, content: 'hi' }] });

test('agent mapping wins over alias and default', async () => {
  const router = createStaticRouter({ model: 'd', agents: { support: 'a' }, aliases: { fast: 'b' } });
  assert.equal(await router.select(req('fast'), testContext({ agent: 'support' })), 'a');
});

test('alias wins over default', async () => {
  const router = createStaticRouter({ model: 'd', aliases: { fast: 'b' } });
  assert.equal(await router.select(req('fast'), testContext()), 'b');
});

test('default applies, then the requested model', async () => {
  assert.equal(await createStaticRouter({ model: 'd' }).select(req('x'), testContext()), 'd');
  assert.equal(await createStaticRouter().select(req('x'), testContext()), 'x');
});

test('prototype keys are not treated as mappings', async () => {
  const router = createStaticRouter({});
  assert.equal(await router.select(req('toString'), testContext({ agent: 'constructor' })), 'toString');
});
