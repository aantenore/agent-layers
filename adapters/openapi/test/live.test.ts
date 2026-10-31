// Live contract test against the tool reference setup (httpbin 2.26.0): make up LAYER=tool. Skips when httpbin is down.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { CallContext } from '@agent-layers/core';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter, createOpenApiTools } from '../src/index.ts';

const httpbin = (process.env.HTTPBIN_URL ?? 'http://localhost:8085').replace(/\/$/, '');
const spec = fileURLToPath(new URL('../../../reference/tool/openapi.json', import.meta.url));
const ctx = (over: Partial<CallContext> = {}): CallContext => ({ runId: 'run-1', agent: 'agent-1', ...over });

test('live: the reference OpenAPI document against httpbin', { timeout: 60_000 }, async (t) => {
  try {
    if (!(await fetch(`${httpbin}/get`, { signal: AbortSignal.timeout(3000) })).ok) return t.skip(`httpbin answered an error at ${httpbin}`);
  } catch {
    return t.skip(`httpbin is not reachable at ${httpbin}; run "make up LAYER=tool"`);
  }
  const options = { spec, baseUrl: httpbin };
  const report = await checkAdapter(adapter, {
    options,
    fixtures: {
      calls: [
        { name: 'decodeBase64', args: { value: 'cmVpbmxvb3A=' }, expect: 'reinloop', ok: true },
        { name: 'getStatus', args: { code: 418 }, ok: false },
        { name: 'echoQuery', args: { message: 'hello' }, expect: 'hello', ok: true },
      ],
    },
  });
  assert.deepEqual(report.failures, []);

  const tools = await createOpenApiTools({ ...options, auth: { audience: 'tools-api' } });
  assert.deepEqual((await tools.listTools(ctx())).map((s) => [s.name, s.risk]), [
    ['echoQuery', 'read'], ['echoJson', 'write'], ['getStatus', 'read'], ['decodeBase64', 'read'], ['checkBearer', 'read'],
  ]);
  const post = await tools.callTool('echoJson', { title: 'hi', tags: ['a'] }, ctx({ credentials: { token: async () => 'tok' } }));
  assert.deepEqual((post.data as { json: unknown }).json, { title: 'hi', tags: ['a'] });
  // go-httpbin echoes request headers: the bearer token must be redacted in what comes back.
  assert.equal(post.text.includes('tok"'), false);
  assert.equal((await tools.callTool('checkBearer', {}, ctx())).ok, false); // no credentials: not sent
  const bearer = await tools.callTool('checkBearer', {}, ctx({ credentials: { token: async () => 'tok' } }));
  assert.equal(bearer.ok, true);
});
