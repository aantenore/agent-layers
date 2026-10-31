import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compose, resolveProfile } from '@agent-layers/core';
import { adapter as basicRuntime } from '@agent-layers/adapter-basic-runtime';
import { adapter as functions, createFunctionTools, defineTool } from '@agent-layers/adapter-functions';
import { createHttpTools } from '@agent-layers/adapter-http-tools';
import { createMcpTools } from '@agent-layers/adapter-mcp';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { adapter as openaiCompatible } from '@agent-layers/adapter-openai-compatible';
import { adapter as openapi, createOpenApiTools } from '@agent-layers/adapter-openapi';
import { reachable } from '../../../lib/wait.mjs';

const here = dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(resolve(here, '../../../.env')); } catch { /* .env is optional */ }

const httpbin = (process.env.HTTPBIN_URL ?? 'http://localhost:8085').replace(/\/$/, '');
const mcpUrl = process.env.OPENAPI_MCP_URL ?? 'http://localhost:8090/mcp';
const llmBase = (process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/$/, '');
const llmModel = process.env.LLM_MODEL ?? 'qwen3:4b';
const specFile = resolve(here, '../openapi.json');
const BRIDGE_TOOLS = ['checkBearer', 'decodeBase64', 'echoJson', 'echoQuery', 'getStatus'];

const ctx = (extra = {}) => ({ runId: 'run-1', agent: 'tool-test', signal: AbortSignal.timeout(30_000), ...extra });
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const httpbinUp = await reachable(`${httpbin}/get`);
/** True when `url` answers an MCP initialize request (another service on the port does not count). */
async function mcpAnswers(url) {
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
const mcpUp = await mcpAnswers(mcpUrl);
const needHttpbin = httpbinUp ? false : `httpbin not reachable at ${httpbin}; run "make up LAYER=tool"`;
const needMcp = mcpUp ? false : `OpenAPI MCP bridge is not answering at ${mcpUrl}; run "make up LAYER=tool"`;
const skip = (reason) => (reason ? { skip: `SKIPPED: ${reason}` } : {});

test('tool 1: a JS function is a tool (defineTool)', async () => {
  const add = defineTool({
    name: 'add',
    description: 'Add two integers',
    risk: 'read',
    params: schema({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b']),
    run: ({ a, b }) => String(Number(a) + Number(b)),
  });
  const math = { ...functions, create: () => createFunctionTools({ tools: [add] }) };
  const stack = await compose(resolveProfile({
    layers: {
      model: { adapter: 'mock-model', options: { rules: [{ match: 'add (\\d+) and (\\d+)', tool: 'add', args: { a: '{{1}}', b: '{{2}}' } }] } },
      runtime: { adapter: 'basic-runtime', options: { maxTurns: 3 } },
      tools: { math: { adapter: 'functions' } },
    },
    agents: { calc: { instructions: 'Use the tool.', model: 'mock', tools: ['math__*'] } },
  }), { adapters: [mockModel, basicRuntime, math] });
  try {
    const res = await (await stack.agent('calc')).run('add 2 and 40');
    const result = res.events.find((e) => e.type === 'tool.result');
    assert.deepEqual([res.status, result.tool, result.ok], ['completed', 'math__add', true]);
    assert.match(res.output, /42/);
  } finally {
    await stack.close();
  }
});

test('tool 2: declarative http tool against httpbin (createHttpTools)', { ...skip(needHttpbin) }, async () => {
  const tools = createHttpTools({
    tools: {
      decode_b64: { description: 'Decode base64url text', method: 'GET', url: `${httpbin}/base64/decode/{value}`, schema: schema({ value: { type: 'string' } }, ['value']) },
      echo_json: { description: 'Echo JSON', method: 'POST', url: `${httpbin}/post`, query: ['dry'], body: 'json', schema: schema({ title: { type: 'string' }, dry: { type: 'boolean' } }, ['title']) },
      status: { description: 'Status', method: 'GET', url: `${httpbin}/status/{code}`, schema: schema({ code: { type: 'integer' } }, ['code']) },
      bearer: { description: 'Needs a bearer token', method: 'GET', url: `${httpbin}/bearer`, auth: { audience: 'tools-api' }, schema: schema({}) },
    },
  });
  const specs = Object.fromEntries((await tools.listTools(ctx())).map((s) => [s.name, s]));
  assert.equal(specs.decode_b64.risk, 'read');
  assert.equal(specs.echo_json.risk, 'write');
  assert.equal((await tools.callTool('decode_b64', { value: 'cmVpbmxvb3A=' }, ctx())).text, 'reinloop');

  const echoed = await tools.callTool('echo_json', { title: 'hi', dry: true }, ctx());
  assert.deepEqual(echoed.data.json, { title: 'hi' });
  assert.deepEqual(echoed.data.args, { dry: ['true'] });

  const err = await tools.callTool('status', { code: 418 }, ctx());
  assert.equal(err.ok, false);
  assert.match(err.text, /^HTTP 418/);

  // auth: a token from the run's credentials becomes a bearer header; without credentials nothing is sent.
  const credentials = { token: async (audience) => `token-for-${audience}` };
  const ok = await tools.callTool('bearer', {}, ctx({ credentials }));
  assert.equal(ok.ok, true);
  assert.doesNotMatch(ok.text, /token-for-tools-api/);
  assert.match(ok.text, /authenticated/);
  assert.equal((await tools.callTool('bearer', {}, ctx())).ok, false);
});

test('tool 3: native OpenAPI import against httpbin (createOpenApiTools)', { ...skip(needHttpbin) }, async () => {
  const tools = await createOpenApiTools({ spec: specFile, baseUrl: httpbin });
  const specs = Object.fromEntries((await tools.listTools(ctx())).map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(specs).sort(), BRIDGE_TOOLS);
  assert.equal(specs.echoJson.risk, 'write');
  assert.deepEqual(specs.echoJson.params.required, ['title']); // $ref Note, flattened

  assert.equal((await tools.callTool('decodeBase64', { value: 'cmVpbmxvb3A=' }, ctx())).text, 'reinloop');
  assert.equal((await tools.callTool('echoQuery', { message: 'a b' }, ctx())).data.args.message[0], 'a b');
  assert.deepEqual((await tools.callTool('echoJson', { title: 't', tags: ['x'] }, ctx())).data.json, { tags: ['x'], title: 't' });
  const status = await tools.callTool('getStatus', { code: 503 }, ctx());
  assert.equal(status.ok, false);
  assert.match(status.text, /^HTTP 503/);
});

test('tool 4: the same API through the OpenAPI to MCP bridge (streamable HTTP)', { ...skip(needMcp) }, async () => {
  const tools = createMcpTools({ url: mcpUrl, timeoutMs: 30_000 });
  try {
    assert.deepEqual((await tools.listTools(ctx())).map((s) => s.name).sort(), BRIDGE_TOOLS);
    const decoded = await tools.callTool('decodeBase64', { value: 'cmVpbmxvb3A=' }, ctx());
    assert.deepEqual([decoded.ok, decoded.text], [true, 'reinloop']);
    assert.match((await tools.callTool('echoJson', { title: 'x' }, ctx())).text, /"title": ?"x"/);
    assert.equal((await tools.callTool('getStatus', { code: 404 }, ctx())).ok, false);
  } finally {
    await tools.close?.();
  }
});

test('tool 5: MCP reference server over stdio (server-everything)', { timeout: 180_000 }, async (t) => {
  const tools = createMcpTools({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything@2.1.0', 'stdio'], timeoutMs: 150_000 });
  try {
    let specs;
    try {
      specs = await tools.listTools(ctx());
    } catch (err) {
      return t.skip(`SKIPPED: cannot start the stdio reference server through npx (${err.message.slice(0, 120)})`);
    }
    const echo = specs.find((s) => s.name === 'echo');
    assert.ok(echo, 'echo tool missing');
    assert.equal(echo.risk, 'read'); // from the server's annotations
    const out = await tools.callTool('echo', { message: 'hi' }, ctx());
    assert.deepEqual([out.ok, out.text], [true, 'Echo: hi']);
  } finally {
    await tools.close?.();
  }
});

async function llmSkip() {
  try {
    const res = await fetch(`${llmBase}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return `LLM endpoint ${llmBase} answered HTTP ${res.status}`;
    const ids = ((await res.json()).data ?? []).map((m) => m.id);
    if (!ids.includes(llmModel)) return `model "${llmModel}" is not available at ${llmBase}`;
  } catch {
    return `LLM not reachable at ${llmBase}`;
  }
  return false;
}

test('tool 6: end-to-end agent run calls an httpbin tool', { timeout: 420_000, ...skip(needHttpbin) }, async (t) => {
  const reason = await llmSkip();
  if (reason) return t.skip(`SKIPPED: ${reason}`);
  const stack = await compose(resolveProfile({
    layers: {
      model: { adapter: 'openai-compatible', options: { baseUrl: llmBase, ...(process.env.LLM_API_KEY ? { apiKey: process.env.LLM_API_KEY } : {}) } },
      runtime: { adapter: 'basic-runtime', options: { maxTurns: 4 } },
      tools: { httpbin: { adapter: 'openapi', options: { spec: specFile, baseUrl: httpbin, include: ['decodeBase64'] } } },
    },
    agents: {
      decoder: {
        instructions: 'You decode base64 text. You cannot decode in your head: always call the tool httpbin__decodeBase64 with the value, then answer with the decoded text only.',
        model: llmModel, tools: ['httpbin__*'], settings: { temperature: 0, maxOutputTokens: 4096 },
      },
    },
  }), { adapters: [openaiCompatible, basicRuntime, openapi] });
  try {
    // A random payload: only the tool's answer can contain it. "/no_think" is the qwen3 switch that skips long reasoning.
    const secret = `agent-layers-${Math.random().toString(36).slice(2, 8)}`;
    const value = Buffer.from(secret).toString('base64url');
    const res = await (await stack.agent('decoder')).run(`/no_think Decode this base64 value with the tool: ${value}`);
    assert.equal(res.status, 'completed', `status ${res.status}: ${res.reason?.code ?? ''}`);
    assert.ok(res.events.some((e) => e.type === 'tool.call' && e.tool === 'httpbin__decodeBase64'), 'the model did not call decodeBase64');
    assert.ok(res.events.some((e) => e.type === 'tool.result' && e.tool === 'httpbin__decodeBase64' && e.ok), 'the tool call failed');
    assert.ok(res.output.includes(secret), `answer does not contain the decoded text: ${res.output}`);
  } finally {
    await stack.close();
  }
});
