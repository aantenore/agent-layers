// A composed stack: scripted model + basic runtime + three tool sources (declarative HTTP, OpenAPI, MCP bridge).
// The agent's tool call reaches an API: offline a local fixture, live httpbin (make up LAYER=tool; HTTPBIN_URL, OPENAPI_MCP_URL).
// The sibling adapters are imported from their sources until the workspace links them as packages.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { compose, resolveProfile, type StackConfig } from '@agent-layers/core';
import { adapter as basicRuntime } from '@agent-layers/adapter-basic-runtime';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { toolAdapter as mcp } from '../../mcp/src/index.ts';
import { adapter as openapi } from '../../openapi/src/index.ts';
import { adapter as httpTools } from '../src/index.ts';
import { startApi } from './mock.ts';

const httpbin = (process.env.HTTPBIN_URL ?? 'http://localhost:8085').replace(/\/$/, '');
const bridgeUrl = process.env.OPENAPI_MCP_URL ?? 'http://localhost:8090/mcp';
const specFile = fileURLToPath(new URL('../../../reference/tool/openapi.json', import.meta.url));

async function reaches(url: string): Promise<boolean> {
  try { return (await fetch(`${url}/get`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}

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

interface Target {
  /** API base URL and the path that answers with the decoded text. */
  base: string;
  decodePath: string;
  spec: string | Record<string, unknown>;
  /** MCP bridge in front of the same API, when there is one. */
  bridge?: string;
  input: string;
  expected: string;
}

/** Each agent asks for a decode with its own tool source and must get the decoded text back. */
async function runStack(target: Target) {
  const rule = (word: string, tool: string) => ({ match: `${word} (\\S+)`, tool, args: { value: '{{1}}' } });
  const config: StackConfig = {
    layers: {
      model: { adapter: 'mock-model', options: { rules: [rule('declared', 'decode'), rule('described', 'decodeBase64'), rule('bridged', 'decodeBase64')] } },
      runtime: { adapter: 'basic-runtime', options: { maxTurns: 3 } },
      tools: {
        api: { adapter: 'http-tools', options: { tools: { decode: { description: 'Decode text', method: 'GET', url: `${target.base}${target.decodePath}/{value}` } } } },
        spec: { adapter: 'openapi', options: { spec: target.spec, baseUrl: target.base } },
        ...(target.bridge ? { bridge: { adapter: 'mcp', options: { url: target.bridge, readOnly: ['decodeBase64'] } } } : {}),
      },
    },
    agents: {
      declared: { instructions: 'Decode.', model: 'mock', tools: ['api__*'] },
      described: { instructions: 'Decode.', model: 'mock', tools: ['spec__*'] },
      bridged: { instructions: 'Decode.', model: 'mock', tools: ['bridge__*'] },
    },
  };
  const stack = await compose(resolveProfile(config), { adapters: [mockModel, basicRuntime, httpTools, openapi, mcp] });
  try {
    for (const agent of target.bridge ? ['declared', 'described', 'bridged'] : ['declared', 'described']) {
      const result = await (await stack.agent(agent)).run(`${agent} ${target.input}`);
      assert.equal(result.status, 'completed', agent);
      assert.equal(result.output, target.expected, agent);
      assert.deepEqual(result.events?.map((e) => e.type).slice(0, 4), ['run_start', 'model_response', 'tool_call', 'tool_result'], agent);
    }
    const names = (await stack.tools.listTools(stack.context({ agent: 'described' }))).map((t) => t.name);
    assert.ok(names.includes('api__decode') && names.includes('spec__decodeBase64'));
  } finally {
    await stack.close();
  }
}

test('stack: the agent tool call reaches a local API', async () => {
  const api = await startApi();
  const spec = {
    openapi: '3.0.3', info: { title: 'fixture', version: '1' },
    paths: { '/text/{value}': { get: { operationId: 'decodeBase64', parameters: [{ name: 'value', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'text' } } } } },
  };
  try {
    await runStack({ base: api.url, decodePath: '/text', spec, input: 'hello', expected: 'hello' });
    assert.deepEqual(api.requests.map((r) => r.path), ['/text/hello', '/text/hello']);
  } finally {
    await api.close();
  }
});

test('live: the agent tool call reaches httpbin', { timeout: 60_000 }, async (t) => {
  if (!(await reaches(httpbin))) return t.skip(`httpbin is not reachable at ${httpbin}; run "make up LAYER=tool"`);
  const bridge = (await mcpAnswers(bridgeUrl)) ? bridgeUrl : undefined;
  await runStack({ base: httpbin, decodePath: '/base64/decode', spec: specFile, ...(bridge ? { bridge } : {}), input: 'cmVpbmxvb3A=', expected: 'reinloop' });
});
