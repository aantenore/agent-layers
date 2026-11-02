import { defineLimits } from '@agent-layers/core';

/** Limits of the connection to an MCP server, shared by the tool and knowledge descriptors; see docs/limits.md. */
export const CONNECTION_LIMITS = defineLimits({
  timeoutMs: { path: 'options.timeoutMs', default: 60_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 300_000 } },
  errorBodyChars: { path: 'options.errorBodyChars', default: 300, unit: 'chars', min: 0, max: 100_000, safe: { max: 2000 } },
  minSecretChars: { path: 'options.minSecretChars', default: 4, unit: 'chars', min: 1, max: 64, safe: { max: 8 } },
  stderrChars: { path: 'options.stderrChars', default: 2000, unit: 'chars', min: 0, max: 1_000_000, safe: { max: 20_000 } },
});

/** Limits of the `mcp` ToolPort. */
export const TOOLS_LIMITS = defineLimits({
  ...CONNECTION_LIMITS,
  toolsTtlMs: { path: 'options.toolsTtlMs', default: 60_000, unit: 'ms', min: 0, safe: { max: 3_600_000 } },
  maxToolPages: { path: 'options.maxToolPages', default: 100, unit: 'count', min: 1, unbounded: 'fail', safe: { max: 1000 } },
});

/** Limits of the `mcp` KnowledgePort. */
export const KNOWLEDGE_LIMITS = defineLimits({
  ...CONNECTION_LIMITS,
  k: { path: 'options.k', default: 4, unit: 'count', min: 1, safe: { max: 50 } },
});

/** Limits of the `mcp` ChannelPort (the MCP server the stack exposes). */
export const SERVER_LIMITS = defineLimits({
  sessionTtlMs: { path: 'options.sessionTtlMs', default: 1_800_000, unit: 'ms', min: 1000, unbounded: 'fail', safe: { max: 86_400_000 } },
  maxSessionAgeMs: { path: 'options.maxSessionAgeMs', default: 3_600_000, unit: 'ms', min: 1000, unbounded: 'fail', safe: { max: 86_400_000 } },
  maxSessions: { path: 'options.maxSessions', default: 1000, unit: 'count', min: 1, unbounded: 'fail', safe: { max: 100_000 } },
  maxSessionsPerCaller: { path: 'options.maxSessionsPerCaller', default: 10, unit: 'count', min: 1, unbounded: 'fail', safe: { max: 1000 } },
});
