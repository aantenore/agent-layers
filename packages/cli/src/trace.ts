import { ATTR, layerLabel, recordingTelemetry, type TelemetryPort } from '@agent-layers/core';

const SHOWN: Record<string, string> = {
  [ATTR.toolName]: 'tool', [ATTR.guardStage]: 'stage', [ATTR.guardAction]: 'action', [ATTR.cacheHit]: 'hit', [ATTR.routerModel]: 'model',
  [ATTR.knowledgePassages]: 'passages', [ATTR.accessDecision]: 'decision', [ATTR.toolOutcome]: 'outcome', [ATTR.runStatus]: 'status',
  [ATTR.runReason]: 'reason',
};

/** One line per finished span: `[L5 tool] agent.tool.call 3ms ok`. Used by `dev` when no telemetry is configured. */
export function traceTelemetry(write: (line: string) => void): TelemetryPort {
  return recordingTelemetry((r) => {
    if (r.type !== 'span') return;
    const extra = Object.entries(SHOWN).filter(([k]) => r.attrs[k] !== undefined).map(([k, label]) => `${label}=${String(r.attrs[k])}`).join(' ');
    write(`  [${layerLabel(r.layer)}] ${r.name} ${r.durationMs}ms ${r.status}${extra ? ` ${extra}` : ''}`);
  }, 'trace');
}
