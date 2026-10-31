import { defineAdapter, limitProperties, PORT_VERSIONS, type JsonSchema } from '@agent-layers/core';
import { serverProblem } from './client.ts';
import { createMcpKnowledge, type McpKnowledgeOptions } from './knowledge.ts';
import { CONNECTION_LIMITS, KNOWLEDGE_LIMITS, SERVER_LIMITS, TOOLS_LIMITS } from './limits.ts';
import { PASSAGE_RULES, METADATA_EXT } from './parse.ts';
import { coreRisk, createMcpServerChannel, type McpServerChannelOptions } from './server.ts';
import { createMcpTools, TOOL_EXT, TOOL_RULES, type McpToolsOptions } from './tools.ts';

export { createMcpKnowledge, createMcpServerChannel, createMcpTools, type McpKnowledgeOptions, type McpServerChannelOptions, type McpToolsOptions };
export { McpClient, McpSession, MCP_PROTOCOL_VERSION, type McpCallResult, type McpToolInfo } from './client.ts';
export { hashId, matchesFilter, METADATA_EXT, PASSAGE_RULES, parseMcpResult, toPassage } from './parse.ts';
export { TOOL_EXT, TOOL_RULES } from './tools.ts';
export { CONNECTION_LIMITS, KNOWLEDGE_LIMITS, SERVER_LIMITS, TOOLS_LIMITS };
export { McpHttpError, McpRpcError, type McpServerOptions } from './transport.ts';

const strings = { type: 'array', items: { type: 'string', minLength: 1 } };

const connectionDescriptions = {
  timeoutMs: 'Time limit per request', errorBodyChars: 'Characters of an error body kept in the error message',
  minSecretChars: 'Shortest header or token value masked in errors', stderrChars: 'Characters of a stdio server\'s stderr kept for error messages',
};

/** Connection options shared by both outbound descriptors. */
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
  ...limitProperties(CONNECTION_LIMITS, connectionDescriptions),
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
      risk: { type: 'string', minLength: 1, description: 'read, write, exec, or a value added to the risk vocabulary' },
      readOnly: strings,
      include: strings,
      exclude: strings,
      ...limitProperties(TOOLS_LIMITS, { toolsTtlMs: 'How long the tool list is cached', maxToolPages: 'Pages of tools/list read before the server is refused' }),
    },
    additionalProperties: false,
  },
  limits: TOOLS_LIMITS,
  ext: { produces: Object.values(TOOL_EXT) },
  mappingDefaults: { in: { shape: 'ToolSpec', rules: TOOL_RULES } },
  create: (options, ctx) => createMcpTools(checked(options), { name: ctx.name, env: ctx.env, telemetry: ctx.telemetry, mappings: ctx.mappings }),
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
      ...limitProperties(KNOWLEDGE_LIMITS, { k: 'Passages returned when the query has no k' }),
    },
    required: ['tool'],
    additionalProperties: false,
  },
  limits: KNOWLEDGE_LIMITS,
  ext: { produces: [METADATA_EXT] },
  mappingDefaults: { in: { shape: 'Passage', rules: PASSAGE_RULES } },
  create: (options, ctx) => createMcpKnowledge(checked(options), { name: ctx.name, env: ctx.env, telemetry: ctx.telemetry, mappings: ctx.mappings }),
});

/** Inbound: the stack's governed tools and knowledge sources served as an MCP server, mounted by the gateway. */
export const channelAdapter = defineAdapter<'ChannelPort', McpServerChannelOptions>({
  layer: 'interface',
  port: 'ChannelPort',
  name: 'mcp',
  direction: 'inbound',
  maps: { standard: 'Model Context Protocol' },
  portVersion: PORT_VERSIONS.ChannelPort,
  tiers: ['prototype', 'production'],
  description: 'Serves the governed tools and knowledge sources as an MCP server over streamable HTTP at /mcp.',
  optionsSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', pattern: '^/' },
      include: strings,
      exclude: strings,
      serverName: { type: 'string', minLength: 1 },
      sse: { type: 'boolean' },
      ...limitProperties(SERVER_LIMITS, {
        sessionTtlMs: 'Idle time after which a session is forgotten', maxSessionAgeMs: 'Absolute lifetime of a session',
        maxSessions: 'Sessions in total', maxSessionsPerCaller: 'Sessions per authenticated caller and for the anonymous pool',
      }),
    },
    additionalProperties: false,
  },
  limits: SERVER_LIMITS,
  ext: { produces: [] },
  // Risk values added to the vocabulary are served as the core value they are `like` (unknown ones as exec); read when
  // the channel lists tools, after composition.
  create: (options, ctx) => createMcpServerChannel(options, ctx.name, (risk) => {
    try { return ctx.stack ? ctx.stack().vocabularies.core('risk', risk) ?? 'exec' : coreRisk(risk); } catch { return coreRisk(risk); }
  }),
});

export const adapters = [toolAdapter, knowledgeAdapter, channelAdapter];
