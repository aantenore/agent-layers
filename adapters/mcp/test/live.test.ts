// Live contract tests against the reference setups. Each one skips with a reason when its service is not there:
//   make up LAYER=tool        (OpenAPI bridge: OPENAPI_MCP_URL, default http://localhost:8090/mcp)
//   make up LAYER=knowledge   (Qdrant: QDRANT_URL; needs uvx; the first start downloads an embedding model)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { CallContext } from '@agent-layers/core';
import { checkAdapter } from '@agent-layers/conformance';
import { createMcpTools, knowledgeAdapter, McpSession, toolAdapter, type McpServerOptions } from '../src/index.ts';

const ctx = (over: Partial<CallContext> = {}): CallContext => ({ runId: 'run-1', agent: 'agent-1', ...over });
const reference = (path: string) => fileURLToPath(new URL(`../../../reference/${path}`, import.meta.url));
const has = (cmd: string) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };

const bridgeUrl = process.env.OPENAPI_MCP_URL ?? 'http://localhost:8090/mcp';
const qdrantUrl = process.env.QDRANT_URL ?? 'http://localhost:6333';
const collection = process.env.QDRANT_COLLECTION ?? 'docs';

/** True when the URL answers an MCP initialize request (another service on the port does not count). */
async function mcpAnswers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok && /"jsonrpc"/.test(await res.text());
  } catch {
    return false;
  }
}

test('live: the OpenAPI bridge over streamable HTTP', { timeout: 60_000 }, async (t) => {
  if (!(await mcpAnswers(bridgeUrl))) return t.skip(`no MCP server at ${bridgeUrl}; run "make up LAYER=tool"`);
  const options = { url: bridgeUrl, readOnly: ['echoQuery', 'decodeBase64', 'checkBearer'] };
  const report = await checkAdapter(toolAdapter, {
    options,
    fixtures: {
      calls: [
        { name: 'decodeBase64', args: { value: 'cmVpbmxvb3A=' }, expect: 'reinloop', isError: false },
        { name: 'getStatus', args: { code: 418 }, isError: true },
      ],
    },
  });
  assert.deepEqual(report.failures, []);

  const tools = createMcpTools(options);
  try {
    const specs = await tools.listTools(ctx());
    assert.deepEqual(specs.map((s) => s.name).sort(), ['checkBearer', 'decodeBase64', 'echoJson', 'echoQuery', 'getStatus']);
    assert.deepEqual(Object.fromEntries(specs.map((s) => [s.name, s.risk])), { checkBearer: 'read', decodeBase64: 'read', echoJson: 'exec', echoQuery: 'read', getStatus: 'exec' });
    const echoed = await tools.callTool('echoJson', { title: 'hi', tags: ['a'] }, ctx());
    assert.match(echoed.content, /"title": ?"hi"/);
  } finally {
    await tools.close?.();
  }
});

test('live: @modelcontextprotocol/server-everything@2.1.0 over stdio', { timeout: 180_000 }, async (t) => {
  if (!has('npx')) return t.skip('npx is not installed');
  const cfg: McpServerOptions = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything@2.1.0', 'stdio'], timeoutMs: 120_000 };
  const tools = createMcpTools(cfg);
  try {
    const specs = await tools.listTools(ctx());
    const names = specs.map((s) => s.name);
    assert.ok(names.includes('echo'), `echo not in ${names.join(', ')}`);
    assert.ok(specs.every((s) => /^[A-Za-z0-9_.-]+$/.test(s.name)));
    const out = await tools.callTool('echo', { message: 'ping' }, ctx());
    assert.equal(out.isError, undefined);
    assert.match(out.content, /ping/);
  } finally {
    await tools.close?.();
  }
});

async function qdrantReady(): Promise<string | undefined> {
  try {
    const res = await fetch(`${qdrantUrl}/readyz`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? undefined : `Qdrant answered HTTP ${res.status} at ${qdrantUrl}`;
  } catch {
    return `Qdrant is not reachable at ${qdrantUrl}; run "make up LAYER=knowledge"`;
  }
}

/** Loads the sample documents (one point per `##` section) when the collection is empty. */
async function ensureIngested(server: McpServerOptions): Promise<void> {
  const info = await fetch(`${qdrantUrl}/collections/${collection}`).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined) as { result?: { points_count?: number } } | undefined;
  if (info?.result?.points_count) return;
  const dir = reference('knowledge/docs');
  const session = new McpSession(server);
  try {
    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()) {
      const text = await readFile(`${dir}/${file}`, 'utf8');
      const title = /^# (.*)$/m.exec(text)?.[1] ?? file;
      for (const section of text.split(/^## /m).slice(1)) {
        const [heading = '', ...body] = section.split('\n');
        const res = await session.run((c) => c.callTool('qdrant-store', { information: `${title} > ${heading}\n${body.join('\n').trim()}`, metadata: { id: `${file}#${heading.toLowerCase().replace(/\W+/g, '-')}`, path: file } }));
        assert.equal(res.isError, false, res.content);
      }
    }
  } finally {
    await session.close();
  }
}

test('live: Qdrant through mcp-server-qdrant@0.8.1', { timeout: 700_000 }, async (t) => {
  const down = await qdrantReady();
  if (down) return t.skip(down);
  if (!has('uvx')) return t.skip('uvx is not installed');
  // The server settings come from the reference setup, so ingestion and search use the same embedding model.
  const { qdrantServer } = await import(reference('knowledge/scripts/qdrant-server.mjs')) as { qdrantServer: McpServerOptions };
  await ensureIngested(qdrantServer);
  const report = await checkAdapter(knowledgeAdapter, {
    options: { ...qdrantServer, tool: 'qdrant-find' },
    fixtures: { query: 'How often does the Aurelian Archive rotate its vault code?', expectText: '13 days', filter: { path: 'vault-protocol.md' }, timeoutMs: 120_000 },
  });
  assert.deepEqual(report.failures, []);
});
