// tool_result guards cover the structured data the MCP server returns as structuredContent, not only the text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inboundFetch } from '@agent-layers/conformance';
import { governedTools, type CallContext, type ChannelHost, type GuardPort, type ToolPort } from '@agent-layers/core';
import { createMcpServerChannel } from '../src/index.ts';

const seen: CallContext[] = [];
const records: Record<string, unknown> = {
  person: { name: 'Mara', ssn: '123-45-6789' },
  secret: { note: 'TOPSECRET plan' },
  quoted: { note: 'say "hi"' },
  clean: { n: 1 },
};
const db: ToolPort = {
  listTools: async () => Object.keys(records).map((name) => ({ name, description: name, params: { type: 'object' }, risk: 'read' as const })),
  async callTool(name, _args, ctx) {
    seen.push(ctx);
    return { ok: true, text: `record ${name}`, data: records[name] };
  },
};
/** Redacts SSNs and quotes, blocks TOPSECRET: on results only. */
const guard: GuardPort = {
  name: 'pii',
  stages: ['tool_result'],
  async check(i) {
    if (i.text.includes('TOPSECRET')) return { action: 'block' };
    if (/\d{3}-\d{2}-\d{4}|"hi\\"/.test(i.text)) return { action: 'redact', text: i.text.replace(/\d{3}-\d{2}-\d{4}/g, '[SSN]').replace('\\"hi\\"', '"hi"') };
    return { action: 'allow' };
  },
};
const host: ChannelHost = { agents: () => [], run: async () => { throw new Error('unused'); }, tools: () => governedTools({ db }, { guards: [guard] }) };

test('structuredContent is guarded: redacted, withheld on block, dropped when the redaction is not JSON', async () => {
  const mount = await createMcpServerChannel().mount!(host);
  const caller = { id: 'u-1', kind: 'user' as const, roles: [], scopes: [] };
  const post = async (body: object, session?: string) => {
    const res = await inboundFetch(mount, new Request('http://gw.test/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify(body),
    }), { caller });
    return { res, body: await res.json() as any };
  };
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const session = init.res.headers.get('mcp-session-id')!;
  const call = async (name: string) => (await post({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name: `db__${name}`, arguments: {} } }, session)).body.result;

  const person = await call('person');
  assert.deepEqual(person, { content: [{ type: 'text', text: 'record person' }], isError: false, structuredContent: { name: 'Mara', ssn: '[SSN]' } });
  assert.ok(!JSON.stringify(person).includes('123-45-6789'));

  const secret = await call('secret');
  assert.deepEqual(secret, { content: [{ type: 'text', text: 'Result withheld by guardrail pii' }], isError: true });

  const quoted = await call('quoted');
  assert.deepEqual(quoted, { content: [{ type: 'text', text: 'record quoted' }], isError: false }, 'a redaction that breaks the JSON drops the data');

  assert.deepEqual(await call('clean'), { content: [{ type: 'text', text: 'record clean' }], isError: false, structuredContent: { n: 1 } });
  assert.equal(seen.at(-1)!.sessionId, `mcp-${session}`, 'calls carry the MCP session');
  await mount.close?.();
});

test('the governed result notes dropped data in ext', async () => {
  const out = await governedTools({ db }, { guards: [guard] }).callTool('db__quoted', {}, { runId: 'r', agent: 'a' });
  assert.equal(out.data, undefined);
  assert.equal(out.ext?.['sdk.data_dropped'], true);
  assert.equal(out.ext?.['sdk.outcome'], 'redacted');
});
