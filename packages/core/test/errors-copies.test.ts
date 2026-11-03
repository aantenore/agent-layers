import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as here from '../src/errors.ts';

// A second evaluation of the module stands for a second installed copy of the package.
const specifier = '../src/errors.ts?copy=2';
const other = (await import(specifier)) as typeof here;

test('the second copy is a distinct module', () => {
  assert.notEqual(other.GuardrailBlocked, here.GuardrailBlocked);
});

test('instanceof matches instances built by another copy, both ways', () => {
  assert.ok(new other.GuardrailBlocked('g', 'input') instanceof here.GuardrailBlocked);
  assert.ok(new here.BoundsExceeded({ code: 'limit' }) instanceof other.BoundsExceeded);
  assert.ok(new other.ApprovalPending('a-1') instanceof here.ApprovalPending);
  assert.ok(new other.ConfigError(['x']) instanceof here.ConfigError);
  assert.ok(new other.RunRefused('not_found', 'm') instanceof here.RunRefused);
  assert.ok(new other.MissingLayerError('llm', 'model') instanceof here.MissingLayerError);
  assert.ok(new other.AdapterError('llm', 'x', 'm') instanceof here.AdapterError);
});

test('a subclass instance matches its base, a sibling does not', () => {
  assert.ok(new other.GuardrailBlocked('g', 'input') instanceof here.AgentLayersError);
  assert.ok(!(new other.GuardrailBlocked('g', 'input') instanceof here.BoundsExceeded));
  assert.ok(!(new other.RunRefused('forbidden', 'm') instanceof here.InboundRejected));
  assert.ok(!(new here.AgentLayersError('m') instanceof other.GuardrailBlocked));
});

test('non-errors never match', () => {
  for (const v of [undefined, null, 'GuardrailBlocked', 1, {}, new Error('x')]) assert.ok(!(v instanceof here.GuardrailBlocked));
});

test('stopReasonOf and runEndOf work across copies', () => {
  assert.deepEqual(here.stopReasonOf(new other.GuardrailBlocked('g', 'input')), { code: 'guard_block', layer: 'guardrail', by: 'g', stage: 'input' });
  assert.deepEqual(other.stopReasonOf(new here.BoundsExceeded({ code: 'timeout' })), { code: 'timeout' });
  assert.equal(here.runEndOf(new other.ApprovalPending('a-1')).status, 'waiting');
  assert.equal(here.runEndOf(new other.GuardrailBlocked('g', 'input')).status, 'stopped');
  assert.equal(here.runEndOf(new other.MissingLayerError('llm', 'model')).status, 'failed');
  assert.equal(here.runEndOf(new Error('x')).status, 'failed');
});
