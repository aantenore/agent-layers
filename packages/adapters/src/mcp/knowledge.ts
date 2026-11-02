import { createMappings, limitValue, type BoundCredentials, type KnowledgePort, type KnowledgeQuery, type Mappings, type Passage, type TelemetryPort } from '@agent-layers/core';
import { McpSession } from './client.ts';
import { interpolate } from './env.ts';
import { KNOWLEDGE_LIMITS } from './limits.ts';
import { matchesFilter, PASSAGE_RULES, parseMcpResult } from './parse.ts';
import { redact, scrubError, secretForms, staticSecrets } from './redact.ts';
import type { McpServerOptions } from './transport.ts';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface McpKnowledgeOptions extends McpServerOptions {
  /** MCP tool that retrieves passages, for example `qdrant-find`. */
  tool: string;
  /** Argument that receives the query text (default `query`). */
  queryArg?: string;
  /** Argument that receives `k`, when the tool takes a limit (default: not sent). */
  kArg?: string;
  /** Argument that receives the attribute filter; without it the filter is applied to the returned passages' `attrs`. */
  filterArg?: string;
  /** Fixed arguments sent with every query. */
  toolArgs?: Record<string, unknown>;
  /** Passages returned when the query has no `k` (default 4). */
  k?: number;
  /** Turns the tool result into passages (default: {@link parseMcpResult}). Code only. */
  parse?: (result: { text: string; isError: boolean }, q: KnowledgeQuery) => Passage[];
}

export interface McpKnowledgeDeps {
  name?: string;
  env?: Record<string, string | undefined>;
  credentials?: BoundCredentials;
  /** The stack's telemetry: its active span's trace context goes with each HTTP request. */
  telemetry?: TelemetryPort;
  /** `in` rules on `Passage`, run over each item the default parser reads (default: {@link PASSAGE_RULES}). */
  mappings?: Mappings;
}

/** KnowledgePort over an MCP retrieval tool. The default parser covers mcp-server-qdrant. */
export function createMcpKnowledge(options: McpKnowledgeOptions, deps: McpKnowledgeDeps = {}): KnowledgePort {
  const env = deps.env ?? process.env;
  const { parse, ...rest } = options;
  const cfg = interpolate(rest, env, 'mcp');
  const name = deps.name ?? 'mcp';
  const mappings = deps.mappings ?? createMappings(name, { in: PASSAGE_RULES });
  const errorBodyChars = limitValue(KNOWLEDGE_LIMITS.errorBodyChars, cfg.errorBodyChars);
  const forms = secretForms(staticSecrets(cfg.headers), limitValue(KNOWLEDGE_LIMITS.minSecretChars, cfg.minSecretChars));
  const session = new McpSession(cfg, { env, ...(deps.credentials ? { credentials: deps.credentials } : {}), ...(deps.telemetry ? { telemetry: deps.telemetry } : {}) });

  return {
    name,
    async search(q) {
      const k = q.k ?? limitValue(KNOWLEDGE_LIMITS.k, cfg.k);
      const args: Record<string, unknown> = {
        ...cfg.toolArgs,
        [cfg.queryArg ?? 'query']: q.text,
        ...(cfg.kArg ? { [cfg.kArg]: k } : {}),
        ...(cfg.filterArg && q.filter ? { [cfg.filterArg]: q.filter } : {}),
      };
      let res;
      try {
        res = await session.run((c) => c.callTool(cfg.tool, args, q.signal));
      } catch (err) {
        throw scrubError(err, forms);
      }
      if (res.isError) throw new Error(`MCP tool ${cfg.tool} failed: ${redact(res.text, forms).slice(0, errorBodyChars)}`);
      const passages = parse ? parse(res, q) : parseMcpResult(res, name, mappings);
      const kept = cfg.filterArg ? passages : passages.filter((p) => matchesFilter(p.attrs, q.filter));
      return kept.slice(0, Math.max(0, k));
    },
    native: () => session,
    close: () => session.close(),
  };
}
