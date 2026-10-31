// Live contract test against the tool reference setup (httpbin 2.26.0): make up LAYER=tool. Skips when httpbin is down.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallContext } from '@agent-layers/core';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter, createHttpTools } from '../src/index.ts';

const httpbin = (process.env.HTTPBIN_URL ?? 'http://localhost:8085').replace(/\/$/, '');
const ctx = (over: Partial<CallContext> = {}): CallContext => ({ runId: 'run-1', agent: 'agent-1', ...over });

test('live: declarative tools against httpbin', { timeout: 60_000 }, async (t) => {
  try {
    if (!(await fetch(`${httpbin}/get`, { signal: AbortSignal.timeout(3000) })).ok) return t.skip(`httpbin answered an error at ${httpbin}`);
  } catch {
    return t.skip(`httpbin is not reachable at ${httpbin}; run "make up LAYER=tool"`);
  }
  const options = {
    tools: {
      decode: { description: 'Decode base64url text', method: 'GET' as const, url: `${httpbin}/base64/decode/{value}` },
      echo_json: { description: 'Echo JSON', method: 'POST' as const, url: `${httpbin}/post`, query: ['dry'], body: 'json' as const },
      status: { description: 'Answer with a status', method: 'GET' as const, url: `${httpbin}/status/{code}` },
      bearer: { description: 'Needs a bearer token', method: 'GET' as const, url: `${httpbin}/bearer`, auth: { audience: 'tools-api' } },
    },
  };
  const report = await checkAdapter(adapter, {
    options,
    fixtures: {
      calls: [
        { name: 'decode', args: { value: 'cmVpbmxvb3A=' }, expect: 'reinloop', isError: false },
        { name: 'status', args: { code: 418 }, expect: 'HTTP 418', isError: true },
        { name: 'bearer', args: {}, isError: true }, // no credentials: nothing is sent
      ],
    },
  });
  assert.deepEqual(report.failures, []);

  const tools = createHttpTools(options);
  const echoed = await tools.callTool('echo_json', { title: 'hi', dry: true }, ctx());
  const body = echoed.data as { json: unknown; args: unknown };
  assert.deepEqual(body.json, { title: 'hi' });
  assert.deepEqual(body.args, { dry: ['true'] });
  const ok = await tools.callTool('bearer', {}, ctx({ credentials: { token: async (audience) => `token-for-${audience}` } }));
  assert.equal(ok.isError, undefined);
  assert.equal(ok.content.includes('token-for-tools-api'), false);
});
