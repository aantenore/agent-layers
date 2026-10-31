import { layerLabel, recordingTelemetry, type TelemetryPort } from '@agent-layers/core';

const SHOWN: Record<string, string> = {
  'gen_ai.tool.name': 'tool', 'guard.stage': 'stage', 'guard.action': 'action', 'cache.hit': 'hit', 'router.model': 'model',
  'knowledge.passages': 'passages', 'policy.decision': 'decision', 'tool.outcome': 'outcome', 'run.status': 'status',
};

/** One line per finished span: `[L5 tool] execute_tool 3ms ok`. Used by `dev` when no telemetry is configured. */
export function traceTelemetry(write: (line: string) => void): TelemetryPort {
  return recordingTelemetry((r) => {
    if (r.type !== 'span') return;
    const extra = Object.entries(SHOWN).filter(([k]) => r.attrs[k] !== undefined).map(([k, label]) => `${label}=${String(r.attrs[k])}`).join(' ');
    write(`  [${layerLabel(r.layer)}] ${r.name} ${r.durationMs}ms ${r.status}${extra ? ` ${extra}` : ''}`);
  }, 'trace');
}
