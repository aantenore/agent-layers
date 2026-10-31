import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reinloop } from '../../../lib/reinloop.mjs';
import { reachable } from '../../../lib/wait.mjs';

const here = dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(resolve(here, '../../../.env')); } catch { /* .env is optional */ }

const httpbin = (process.env.HTTPBIN_URL ?? 'http://localhost:8085').replace(/\/$/, '');
const mcpUrl = process.env.OPENAPI_MCP_URL ?? 'http://localhost:8090/mcp';
const llmBase = (process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/$/, '');
const llmModel = process.env.LLM_MODEL ?? 'qwen3:4b';
const specFile = resolve(here, '../openapi.json');

const ctx = (extra = {}) => ({ signal: AbortSignal.timeout(30_000), ...extra });
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]));

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
const needHttpbin = httpbinUp ? false : `httpbin not reachable at ${httpbin}; run "make up LAYER=l4-tools"`;
const needMcp = mcpUp ? false : `OpenAPI MCP bridge is not answering at ${mcpUrl}; run "make up LAYER=l4-tools"`;
const skip = (reason) => (reason ? { skip: `SKIPPED: ${reason}` } : {});

test('L4.1: a JS function is a tool (defineTool)', async () => {
  const add = reinloop.defineTool({
    name: 'add',
    description: 'Add two integers',
    risk: 'read',
    schema: schema({ a: { type: 'integer' }, b: { type: 'integer' } }, ['a', 'b']),
    run: ({ a, b }) => String(a + b),
  });
  const provider = reinloop.mockProvider([{ toolCalls: [{ name: 'add', args: { a: 2, b: 40 } }] }, { text: 'done' }]);
  const res = await reinloop.run({ name: 't', model: { provider, model: 'mock' }, tools: [add] }, 'add');
  const result = res.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result');
  assert.deepEqual([res.status, result.content, result.isError], ['completed', '42', false]);
});

test('L4.2: declarative http tool against httpbin', { ...skip(needHttpbin) }, async () => {
  const decode = reinloop.httpTool({
    name: 'decode_b64', description: 'Decode base64url text', method: 'GET', url: `${httpbin}/base64/decode/{value}`,
    schema: schema({ value: { type: 'string' } }, ['value']),
  });
  assert.equal(decode.risk, 'read');
  assert.equal(await decode.run({ value: 'cmVpbmxvb3A=' }, ctx()), 'reinloop');

  const post = reinloop.httpTool({
    name: 'echo_json', description: 'Echo JSON', method: 'POST', url: `${httpbin}/post`, query: ['dry'], body: 'json',
    schema: schema({ title: { type: 'string' }, dry: { type: 'boolean' } }, ['title']),
  });
  const echoed = JSON.parse(await post.run({ title: 'hi', dry: true }, ctx()));
  assert.deepEqual(echoed.json, { title: 'hi' });
  assert.deepEqual(echoed.args, { dry: ['true'] });

  const status = reinloop.httpTool({ name: 'status', description: 'Status', method: 'GET', url: `${httpbin}/status/{code}`, schema: schema({ code: { type: 'integer' } }, ['code']) });
  const err = await status.run({ code: 418 }, ctx());
  assert.equal(err.isError, true);
  assert.match(err.content, /^HTTP 418/);

  // auth: a token from the run's credentials becomes a bearer header; without credentials nothing is sent.
  const bearer = reinloop.httpTool({ name: 'bearer', description: 'Needs a bearer token', method: 'GET', url: `${httpbin}/bearer`, auth: { audience: 'tools-api' }, schema: schema({}) });
  const credentials = { token: async (audience) => `token-for-${audience}` };
  const ok = await bearer.run({}, ctx({ credentials }));
  assert.doesNotMatch(String(ok.content ?? ok), /token-for-tools-api/);
  assert.match(String(ok.content ?? ok), /authenticated/);
  assert.equal((await bearer.run({}, ctx())).isError, true);
});

test('L4.3: native OpenAPI import against httpbin', { ...skip(needHttpbin) }, async () => {
  const spec = JSON.parse(await readFile(specFile, 'utf8'));
  const tools = byName(reinloop.openapiTools(spec, { baseUrl: httpbin, prefix: 'httpbin' }));
  assert.deepEqual(Object.keys(tools).sort(), ['httpbin__checkBearer', 'httpbin__decodeBase64', 'httpbin__echoJson', 'httpbin__echoQuery', 'httpbin__getStatus']);
  assert.equal(tools.httpbin__echoJson.risk, 'write');
  assert.deepEqual(tools.httpbin__echoJson.schema.required, ['title']); // $ref Note, flattened

  assert.equal(await tools.httpbin__decodeBase64.run({ value: 'cmVpbmxvb3A=' }, ctx()), 'reinloop');
  assert.equal(JSON.parse(await tools.httpbin__echoQuery.run({ message: 'a b' }, ctx())).args.message[0], 'a b');
  assert.deepEqual(JSON.parse(await tools.httpbin__echoJson.run({ title: 't', tags: ['x'] }, ctx())).json, { tags: ['x'], title: 't' });
  assert.match((await tools.httpbin__getStatus.run({ code: 503 }, ctx())).content, /^HTTP 503/);
});

test('L4.4: the same API through the OpenAPI to MCP bridge (streamable HTTP)', { ...skip(needMcp) }, async () => {
  const { client, tools } = await reinloop.mcpTools('httpbin', { url: mcpUrl, timeoutMs: 30_000 });
  try {
    const t = byName(tools);
    assert.deepEqual(Object.keys(t).sort(), ['httpbin__checkBearer', 'httpbin__decodeBase64', 'httpbin__echoJson', 'httpbin__echoQuery', 'httpbin__getStatus']);
    assert.deepEqual(await t.httpbin__decodeBase64.run({ value: 'cmVpbmxvb3A=' }, ctx()), { content: 'reinloop', isError: false });
    assert.equal(JSON.parse((await t.httpbin__echoJson.run({ title: 'x' }, ctx())).content).json.title, 'x');
    assert.equal((await t.httpbin__getStatus.run({ code: 404 }, ctx())).isError, true);
  } finally {
    await client.close();
  }
});

test('L4.5: MCP reference server over stdio (server-everything)', { timeout: 180_000 }, async (t) => {
  let connected;
  try {
    connected = await reinloop.mcpTools('everything', {
      command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything@2.1.0', 'stdio'], timeoutMs: 150_000,
    });
  } catch (err) {
    return t.skip(`SKIPPED: cannot start the stdio reference server through npx (${err.message.slice(0, 120)})`);
  }
  try {
    const echo = byName(connected.tools).everything__echo;
    assert.ok(echo, 'echo tool missing');
    assert.equal(echo.risk, 'read'); // from the server's annotations
    assert.deepEqual(await echo.run({ message: 'hi' }, ctx()), { content: 'Echo: hi', isError: false });
  } finally {
    await connected.client.close();
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

test('L4.6: end-to-end agent run calls an httpbin tool', { timeout: 420_000, ...skip(needHttpbin) }, async (t) => {
  const reason = await llmSkip();
  if (reason) return t.skip(`SKIPPED: ${reason}`);
  const spec = JSON.parse(await readFile(specFile, 'utf8'));
  const tools = reinloop.openapiTools(spec, { baseUrl: httpbin, include: ['decodeBase64'] });
  const provider = reinloop.openaiCompatible({ name: 'local', baseUrl: llmBase, apiKey: process.env.LLM_API_KEY ?? 'ollama', structuredOutput: 'without-tools' });
  const agent = {
    name: 'decoder',
    model: { provider, model: llmModel, params: { temperature: 0, maxTokens: 4096 } },
    instructions: 'You decode base64 text. You cannot decode in your head: always call the tool decodeBase64 with the value, then answer with the decoded text only.',
    tools,
    budget: { maxTurns: 4 },
  };
  // A random payload: only the tool's answer can contain it. "/no_think" is the qwen3 switch that skips long reasoning.
  const secret = `reinloop-${Math.random().toString(36).slice(2, 8)}`;
  const value = Buffer.from(secret).toString('base64url');
  const res = await reinloop.run(agent, `/no_think Decode this base64 value with the tool: ${value}`);
  assert.equal(res.status, 'completed', `status ${res.status}: ${res.reason ?? ''}`);
  const parts = res.messages.flatMap((m) => m.parts);
  assert.ok(parts.some((p) => p.type === 'tool_call' && p.name === 'decodeBase64'), 'the model did not call decodeBase64');
  const result = parts.find((p) => p.type === 'tool_result' && p.name === 'decodeBase64');
  assert.deepEqual([result.content, result.isError], [secret, false]);
  assert.ok(res.output.includes(secret), `answer does not contain the decoded text: ${res.output}`);
});
