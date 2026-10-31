import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';
import { collector, type Collector } from './collector.ts';

let sink: Collector;
before(async () => { sink = await collector(); });
after(() => sink.close());

test('otlp passes TelemetryPort conformance', async () => {
  const report = await checkAdapter(adapter, { options: { endpoint: sink.url } });
  assert.deepEqual(report.failures, []);
  assert.ok(sink.spans().some((s) => s.name === 'conformance.span'), 'close() exported the spans');
});
