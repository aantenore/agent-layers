import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePolicy, Vocabularies, VOCABULARIES, vocabularyProblems } from '../src/index.ts';

test('core vocabularies match the language: closed sets, waiting, reasoning', () => {
  assert.deepEqual(VOCABULARIES.runStatus.core, ['completed', 'failed', 'stopped', 'waiting']);
  assert.ok(VOCABULARIES.part.core.includes('reasoning'));
  assert.equal(VOCABULARIES.layer.core.length, 11);
  assert.equal(VOCABULARIES.risk.extensible, 'like');
});

test('config extensions are validated: like targets, names, collisions, closed vocabularies', () => {
  assert.deepEqual(vocabularyProblems({
    risk: { add: { admin: { like: 'exec' } } },
    guardLabel: { add: { 'pii.health': { like: 'pii' } } },
    finish: { aliases: { pause: 'other' } },
    role: { aliases: { developer: 'system' } },
  }), []);
  const problems = vocabularyProblems({
    risk: { add: { Admin: { like: 'exec' }, read: { like: 'read' }, root: { like: 'admin' } } },
    role: { add: { robot: { like: 'user' } } },
    runStatus: { add: { paused: { like: 'stopped' } } },
    event: { aliases: { start: 'run.start' } },
    finish: { aliases: { pause: 'nowhere' } },
    colour: {},
  });
  assert.deepEqual(problems, [
    'vocabularies.risk.add.Admin: name must match ^[a-z][a-z0-9_.-]{0,63}$',
    'vocabularies.risk.add.read: collides with an existing value or alias',
    'vocabularies.risk.add.root.like: must be a core value of risk (read, write, exec)',
    'vocabularies.role.add: only aliases are allowed for role',
    'vocabularies.runStatus: is closed',
    'vocabularies.event: grows through namespaced values (<namespace>.<name>), not config',
    'vocabularies.finish.aliases.pause: must name an existing value of finish',
    'vocabularies.colour: unknown vocabulary (known: layer, role, part, finish, risk, effect, action, stage, guardAction, guardLabel, runStatus, stopCode, event, callerKind, approvalStatus)',
  ]);
});

test('core logic sees the like value; aliases resolve; unknown values become other or fail', () => {
  const v = new Vocabularies([{ risk: { add: { admin: { like: 'exec' } } }, finish: { aliases: { pause: 'other' } } }, { role: { aliases: { developer: 'system' } } }]);
  assert.equal(v.core('risk', 'admin'), 'exec');
  assert.equal(v.core('risk', 'read'), 'read');
  assert.equal(v.core('risk', 'root'), undefined);
  assert.equal(v.resolve('role', 'developer'), 'system');
  assert.ok(v.has('role', 'developer') && v.has('event', 'reinloop.compaction') && !v.has('event', 'nope'));
  assert.equal(v.accept('finish', 'pause'), 'other');
  assert.equal(v.accept('finish', 'weird_native'), 'other', 'outside the vocabulary: other, native value goes in ext');
  assert.equal(v.accept('callerKind', 'service'), undefined, 'no other: the call fails (identity fails closed)');
  assert.deepEqual(v.values('risk'), ['read', 'write', 'exec', 'admin']);
});

test('a policy rule on a core risk also matches the values added like it', () => {
  const v = new Vocabularies([{ risk: { add: { admin: { like: 'exec' } } } }]);
  const rules = [{ effect: 'deny' as const, risk: ['exec'] }, { effect: 'allow' as const }];
  assert.equal(evaluatePolicy(rules, { tool: 't', risk: 'admin' }, v), 'deny');
  assert.equal(evaluatePolicy([{ effect: 'ask', risk: ['admin'] }], { tool: 't', risk: 'admin' }, v), 'ask');
  assert.equal(evaluatePolicy(rules, { tool: 't', risk: 'read' }, v), 'allow');
});
