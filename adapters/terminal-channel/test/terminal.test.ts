import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { ChannelHost, RunResult } from '@agent-layers/core';
import { createTerminalChannel, type TerminalChannelOptions } from '../src/index.ts';

const result = (over: Partial<RunResult> = {}): RunResult => ({ runId: 'r', status: 'completed', output: '', ...over });

function setup(run: ChannelHost['run'], options: TerminalChannelOptions = { prompt: '' }, agents = ['alpha', 'beta']) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding('utf8');
  let text = '';
  output.on('data', (d: string) => { text += d; });
  const host: ChannelHost = { agents: () => agents, run };
  const serve = () => createTerminalChannel(options, { input, output }).serve(host);
  return { input, serve, text: () => text, lines: () => text.split('\n').filter(Boolean) };
}

test('prints the banner, runs lines in order and prints the output', async () => {
  const calls: string[] = [];
  const t = setup(async (agent, input) => { calls.push(`${agent}:${String(input)}`); return result({ output: `echo ${String(input)}` }); });
  const handle = await t.serve();
  t.input.write('one\n\ntwo\n');
  t.input.end();
  await handle.done;
  assert.deepEqual(calls, ['alpha:one', 'alpha:two']);
  assert.deepEqual(t.lines(), ['Talking to alpha. /agents, /agent <name>, /exit.', 'echo one', 'echo two']);
});

test('the banner can be turned off and the agent chosen', async () => {
  const calls: string[] = [];
  const t = setup(async (agent) => { calls.push(agent); return result({ output: 'ok' }); }, { prompt: '', banner: false, agent: 'beta' });
  const handle = await t.serve();
  t.input.end('hi\n');
  await handle.done;
  assert.deepEqual(calls, ['beta']);
  assert.deepEqual(t.lines(), ['ok']);
});

test('one session id per serve, passed on every run', async () => {
  const ids: unknown[] = [];
  const t = setup(async (_a, _i, ctx) => { ids.push(ctx?.sessionId); return result(); });
  const handle = await t.serve();
  t.input.end('a\nb\n');
  await handle.done;
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(typeof ids[0], 'string');
});

test('stopped and failed runs are printed with their reason', async () => {
  const t = setup(async (_a, input) => (input === 'x'
    ? result({ status: 'stopped', reason: 'guardrail:pii:input' })
    : result({ status: 'failed', reason: 'model unavailable' })));
  const handle = await t.serve();
  t.input.end('x\ny\n');
  await handle.done;
  assert.deepEqual(t.lines().slice(1), ['[stopped] guardrail:pii:input', '[failed] model unavailable']);
});

test('a host error is printed and the loop keeps going', async () => {
  const t = setup(async (_a, input) => { if (input === 'bad') throw new Error('boom'); return result({ output: 'fine' }); });
  const handle = await t.serve();
  t.input.end('bad\ngood\n');
  await handle.done;
  assert.deepEqual(t.lines().slice(1), ['[error] boom', 'fine']);
});

test('/exit ends the session without running later lines', async () => {
  const calls: string[] = [];
  const t = setup(async (_a, input) => { calls.push(String(input)); return result({ output: 'ok' }); });
  const handle = await t.serve();
  t.input.write('first\n/exit\nnever\n');
  await handle.done;
  assert.deepEqual(calls, ['first']);
});

test('/agents lists and /agent switches', async () => {
  const calls: string[] = [];
  const t = setup(async (agent) => { calls.push(agent); return result({ output: 'ok' }); });
  const handle = await t.serve();
  t.input.end('/agents\n/agent beta\n/agent nobody\nhi\n');
  await handle.done;
  assert.deepEqual(calls, ['beta']);
  assert.deepEqual(t.lines().slice(1, 5), ['alpha, beta', 'Talking to beta.', '[error] unknown agent "nobody"', 'ok']);
});

test('lines are processed one at a time', async () => {
  const log: string[] = [];
  const t = setup(async (_a, input) => {
    log.push(`start ${String(input)}`);
    await new Promise((r) => setTimeout(r, input === 'slow' ? 40 : 0));
    log.push(`end ${String(input)}`);
    return result({ output: String(input) });
  });
  const handle = await t.serve();
  t.input.end('slow\nfast\n');
  await handle.done;
  assert.deepEqual(log, ['start slow', 'end slow', 'start fast', 'end fast']);
});

test('close() ends the session and resolves done', async () => {
  const t = setup(async () => result());
  const handle = await t.serve();
  await handle.close();
  await handle.done;
});

test('the prompt is printed before each line', async () => {
  const t = setup(async () => result({ output: 'ok' }), { prompt: '> ', banner: false });
  const handle = await t.serve();
  t.input.end('hi\n');
  await handle.done;
  assert.ok(t.text().startsWith('> ok\n'));
});

test('serve rejects when the stack has no agents', async () => {
  const t = setup(async () => result(), { prompt: '' }, []);
  await assert.rejects(t.serve(), /no agents/);
});
