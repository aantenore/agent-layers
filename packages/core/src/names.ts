/**
 * Telemetry names the core emits. Only `agent.*`: standard names (`gen_ai.*`, `error.type`) are written by the
 * telemetry adapter that speaks the standard. See spec/ports/TelemetryPort.md.
 */
export const SPAN = Object.freeze({
  run: 'agent.run',
  modelCall: 'agent.model.call',
  cacheLookup: 'agent.cache.lookup',
  routerSelect: 'agent.router.select',
  toolCall: 'agent.tool.call',
  accessCheck: 'agent.access.check',
  guardCheck: 'agent.guard.check',
  knowledgeSearch: 'agent.knowledge.search',
});

export const EVENT = Object.freeze({
  knowledgeError: 'agent.knowledge.error',
  extDropped: 'agent.ext.dropped',
  configWarning: 'agent.config.warning',
});

export const METRIC = Object.freeze({
  modelTokens: 'agent.model.tokens',
  toolCalls: 'agent.tool.calls',
  accessDecisions: 'agent.access.decisions',
  guardActions: 'agent.guard.actions',
});

export const ATTR = Object.freeze({
  layer: 'agent.layer',
  name: 'agent.name',
  runId: 'agent.run.id',
  runStatus: 'agent.run.status',
  runReason: 'agent.run.reason',
  modelRequested: 'agent.model.requested',
  modelUsed: 'agent.model.used',
  modelFinish: 'agent.model.finish',
  tokensInput: 'agent.tokens.input',
  tokensOutput: 'agent.tokens.output',
  tokensKind: 'agent.tokens.kind',
  toolName: 'agent.tool.name',
  toolSource: 'agent.tool.source',
  toolOutcome: 'agent.tool.outcome',
  guardName: 'agent.guard.name',
  guardStage: 'agent.guard.stage',
  guardAction: 'agent.guard.action',
  accessDecision: 'agent.access.decision',
  accessReason: 'agent.access.reason',
  cacheHit: 'agent.cache.hit',
  routerModel: 'agent.router.model',
  knowledgeSource: 'agent.knowledge.source',
  knowledgeK: 'agent.knowledge.k',
  knowledgePassages: 'agent.knowledge.passages',
  triggerKind: 'agent.trigger.kind',
  error: 'agent.error',
  extBytes: 'agent.ext.bytes',
  extShape: 'agent.ext.shape',
});
