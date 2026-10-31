import { defineAdapter, PORT_VERSIONS, type JsonSchema } from '@agent-layers/core';
import { serverProblem } from './client.ts';
import { createMcpKnowledge, type McpKnowledgeOptions } from './knowledge.ts';
import { createMcpTools, type McpToolsOptions } from './tools.ts';

export { createMcpKnowledge, createMcpTools, type McpKnowledgeOptions, type McpToolsOptions };
export { McpClient, McpSession, MCP_PROTOCOL_VERSION, type McpCallResult, type McpToolInfo } from './client.ts';
export { hashId, matchesFilter, parseMcpResult, toPassage } from './parse.ts';
export { riskOf } from './tools.ts';
export { McpHttpError, McpRpcError, type McpServerOptions } from './transport.ts';

const strings = { type: 'array', items: { type: 'string', minLength: 1 } };

/** Connection options shared by both descriptors. */
const serverProperties: Record<string, JsonSchema> = {
  command: { type: 'string', minLength: 1 },
  args: { type: 'array', items: { type: 'string' } },
  env: { type: 'object', additionalProperties: { type: 'string' } },
  cwd: { type: 'string', minLength: 1 },
  url: { type: 'string', minLength: 1 },
  headers: { type: 'object', additionalProperties: { type: 'string' } },
  auth: {
    type: 'object',
    properties: { audience: { type: 'string', minLength: 1 }, scopes: strings },
    required: ['audience'],
    additionalProperties: false,
  },
  timeoutMs: { type: 'integer', minimum: 1 },
};

function checked<O extends { command?: string; url?: string; auth?: unknown }>(options: O): O {
  const problem = serverProblem(options as never);
  if (problem) throw new Error(problem);
  return options;
}

/** Tools of one MCP server (stdio or streamable HTTP). */
export const toolAdapter = defineAdapter<'ToolPort', McpToolsOptions>({
  layer: 'tool',
  port: 'ToolPort',
  name: 'mcp',
  direction: 'outbound',
  maps: { standard: 'Model Context Protocol' },
  portVersion: PORT_VERSIONS.ToolPort,
  tiers: ['prototype', 'production'],
  description: 'Lists and calls the tools of an MCP server over stdio or streamable HTTP.',
  optionsSchema: {
    type: 'object',
    properties: {
      ...serverProperties,
      risk: { enum: ['read', 'write', 'exec'] },
      readOnly: strings,
      include: strings,
      exclude: strings,
      toolsTtlMs: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  create: (options, ctx) => createMcpTools(checked(options), { name: ctx.name, env: ctx.env }),
});

/** A retrieval tool of an MCP server as a knowledge source. */
export const knowledgeAdapter = defineAdapter<'KnowledgePort', McpKnowledgeOptions>({
  layer: 'knowledge',
  port: 'KnowledgePort',
  name: 'mcp',
  direction: 'outbound',
  maps: { standard: 'Model Context Protocol' },
  portVersion: PORT_VERSIONS.KnowledgePort,
  tiers: ['prototype', 'production'],
  description: 'Searches through a retrieval tool of an MCP server (for example mcp-server-qdrant) and returns passages.',
  optionsSchema: {
    type: 'object',
    properties: {
      ...serverProperties,
      tool: { type: 'string', minLength: 1 },
      queryArg: { type: 'string', minLength: 1 },
      kArg: { type: 'string', minLength: 1 },
      filterArg: { type: 'string', minLength: 1 },
      toolArgs: { type: 'object' },
      k: { type: 'integer', minimum: 1 },
    },
    required: ['tool'],
    additionalProperties: false,
  },
  create: (options, ctx) => createMcpKnowledge(checked(options), { name: ctx.name, env: ctx.env }),
});

export const adapters = [toolAdapter, knowledgeAdapter];
