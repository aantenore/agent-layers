import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter, createPresidioGuard } from '../src/index.ts';

// Live contract test against the reference setup (reference/guardrail, Presidio 2.2.362). Skips when it is not up.
const analyzerUrl = process.env.PRESIDIO_ANALYZER_URL ?? 'http://localhost:5002';
const anonymizerUrl = process.env.PRESIDIO_ANONYMIZER_URL ?? 'http://localhost:5001';
const up = await Promise.all([analyzerUrl, anonymizerUrl].map((u) => fetch(`${u}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false))).then((r) => r.every(Boolean));
const live = { skip: up ? false : 'Presidio is not reachable (make up LAYER=guardrail)' };

// The default entity list includes DATE_TIME, so "today" would be redacted: restrict it to contact data.
const entities = ['EMAIL_ADDRESS', 'PHONE_NUMBER', 'CREDIT_CARD'];

test('live: presidio passes GuardPort conformance', live, async () => {
  const report = await checkAdapter(adapter, {
    options: { analyzerUrl, anonymizerUrl, entities },
    fixtures: { redact: [
      { stage: 'input', text: 'Mail me at jane.doe@example.com please', secret: 'jane.doe@example.com' },
      { stage: 'tool_result', text: 'call +39 333 123 4567 now', secret: '+39 333 123 4567' },
    ] },
  });
  assert.deepEqual(report.failures, []);
});

test('live: operators shape the replacement, block mode refuses', live, async () => {
  const text = 'Write to jane.doe@example.com';
  const redacted = await createPresidioGuard({ analyzerUrl, anonymizerUrl, entities, operators: { DEFAULT: { type: 'replace', new_value: '[PII]' } } })
    .check({ stage: 'input', text, agent: 'a', runId: 'r' });
  assert.deepEqual([redacted.action, redacted.text], ['redact', 'Write to [PII]']);
  const blocked = await createPresidioGuard({ analyzerUrl, entities, action: 'block' }).check({ stage: 'output', text, agent: 'a', runId: 'r' });
  assert.deepEqual(blocked, { action: 'block', reason: 'PII detected: EMAIL_ADDRESS' });
});
