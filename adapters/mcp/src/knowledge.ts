import type { BoundCredentials, KnowledgePort, KnowledgeQuery, Passage } from '@agent-layers/core';
import { McpSession } from './client.ts';
import { interpolate } from './env.ts';
import { matchesFilter, parseMcpResult } from './parse.ts';
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
  /** Argument that receives the metadata filter; without it the filter is applied to the returned passages. */
  filterArg?: string;
  /** Fixed arguments sent with every query. */
  toolArgs?: Record<string, unknown>;
  /** Passages returned when the query has no `k` (default 4). */
  k?: number;
  /** Turns the tool result into passages (default: {@link parseMcpResult}). Code only. */
  parse?: (result: { content: string; isError: boolean }, q: KnowledgeQuery) => Passage[];
}

export interface McpKnowledgeDeps {
  name?: string;
  env?: Record<string, string | undefined>;
  credentials?: BoundCredentials;
}

/** KnowledgePort over an MCP retrieval tool. The default parser covers mcp-server-qdrant. */
export function createMcpKnowledge(options: McpKnowledgeOptions, deps: McpKnowledgeDeps = {}): KnowledgePort {
  const env = deps.env ?? process.env;
  const { parse, ...rest } = options;
  const cfg = interpolate(rest, env, 'mcp');
  const name = deps.name ?? 'mcp';
  const forms = secretForms(staticSecrets(cfg.headers));
  const session = new McpSession(cfg, { env, ...(deps.credentials ? { credentials: deps.credentials } : {}) });

  return {
    name,
    async search(q) {
      const k = q.k ?? cfg.k ?? 4;
      const args: Record<string, unknown> = {
        ...cfg.toolArgs,
        [cfg.queryArg ?? 'query']: q.query,
        ...(cfg.kArg ? { [cfg.kArg]: k } : {}),
        ...(cfg.filterArg && q.filter ? { [cfg.filterArg]: q.filter } : {}),
      };
      let res;
      try {
        res = await session.run((c) => c.callTool(cfg.tool, args, q.signal));
      } catch (err) {
        throw scrubError(err, forms);
      }
      if (res.isError) throw new Error(`MCP tool ${cfg.tool} failed: ${redact(res.content, forms).slice(0, 300)}`);
      const passages = parse ? parse(res, q) : parseMcpResult(res, name);
      const kept = cfg.filterArg ? passages : passages.filter((p) => matchesFilter(p.metadata, q.filter));
      return kept.slice(0, Math.max(0, k));
    },
    native: () => session,
    close: () => session.close(),
  };
}
