import type { EvalCase, EvalRun, EvaluatorPort, FeedbackPort, TelemetryPort } from '@agent-layers/core';
import { validate } from '@agent-layers/core';
import { Checks } from '../check.ts';
import { conforms, schema } from '../schemas.ts';

export async function checkTelemetry(port: TelemetryPort, _f: unknown = {}, c = new Checks()): Promise<Checks> {
  const attrs = { 'agent.layer': 'telemetry' as const, 'conformance.case': 'span' };
  c.expect(await c.attempt('span', () => port.span('conformance.span', attrs, async (s) => { s.setAttributes({ x: 1 }); s.addEvent('step'); return 42; })) === 42, 'span: must resolve to the value of fn');
  const nested = await c.attempt('nested span', () => port.span('outer', attrs, () => port.span('inner', attrs, async () => 'in')));
  c.expect(nested === 'in', 'span: nesting must work');
  const boom = new Error('conformance failure');
  try {
    await port.span('conformance.error', attrs, async () => { throw boom; });
    c.expect(false, 'span: must rethrow the error of fn');
  } catch (err) {
    c.expect(err === boom, 'span: must rethrow the same error');
  }
  await c.attempt('event', () => port.event('conformance.event', attrs));
  await c.attempt('metric', () => port.metric('conformance.metric', 1, attrs));
  if (port.flush) await c.attempt('flush', () => port.flush!());
  return c;
}

export interface EvaluatorFixtures { cases?: { case: EvalCase; run: EvalRun; expect?: { metric: string; value: number } }[] }

export async function checkEvaluator(port: EvaluatorPort, f: EvaluatorFixtures = {}, c = new Checks()): Promise<Checks> {
  const cases = f.cases ?? [{ case: { id: 'c1', input: 'What is 2+2?', expected: '4' }, run: { runId: 'r1', output: 'The answer is 4.', status: 'completed' } }];
  const scoreSchema = { ...schema('eval-result'), ...(schema('eval-result').$defs as Record<string, Record<string, unknown>>).EvalScore };
  for (const [i, t] of cases.entries()) {
    c.all(conforms('eval-case', t.case), `fixture case[${i}]`);
    const scores = await c.attempt(`score #${i}`, () => port.score(t.case, t.run));
    if (!scores) continue;
    c.expect(Array.isArray(scores), `score #${i}: must resolve to an array`);
    scores.forEach((s, j) => c.all(validate(scoreSchema, s, `score[${j}]`), `score #${i}`));
    if (t.expect) {
      const hit = scores.find((s) => s.metric === t.expect!.metric);
      c.expect(hit?.value === t.expect.value, `score #${i}: ${t.expect.metric} = ${hit?.value}, expected ${t.expect.value}`);
    }
  }
  return c;
}

export async function checkFeedback(port: FeedbackPort, _f: unknown = {}, c = new Checks()): Promise<Checks> {
  const runId = `conformance-${Date.now()}`;
  const fb = { runId, agent: 'conformance', rating: 1, comment: 'good' };
  c.all(conforms('feedback', fb), 'fixture');
  const id = await c.attempt('submit', () => port.submit(fb));
  c.expect(typeof id === 'string' && id.length > 0, 'submit: must resolve to an id');
  const listed = await c.attempt('list', () => port.list({ runId }));
  c.expect(listed?.some((x) => x.runId === runId), 'list: submitted feedback not found');
  return c;
}
