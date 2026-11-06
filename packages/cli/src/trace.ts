import { ATTR, EVENT, layerLabel, recordingTelemetry, SPAN, type TelemetryPort } from '@agent-layers/core';

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

/**
 * One line per failure a developer has to see, whatever telemetry the profile configures: a knowledge source that
 * failed (the run goes on without its passages), a tool call that failed, a span that threw, a run that did not
 * complete. Used by `dev` unless `--quiet`; the configured telemetry still receives every record.
 */
export function errorTelemetry(write: (line: string) => void): TelemetryPort {
  return recordingTelemetry((r) => {
    if (r.type === 'event' && r.name === EVENT.knowledgeError) {
      write(`  [${layerLabel(r.layer)}] knowledge source ${String(r.attrs[ATTR.knowledgeSource] ?? '?')} failed: ${String(r.attrs[ATTR.error] ?? 'error')}`);
      return;
    }
    if (r.type !== 'span') return;
    const adapter = r.attrs[ATTR.adapter] === undefined ? '' : ` (${String(r.attrs[ATTR.adapter])})`;
    if (r.status === 'error') write(`  [${layerLabel(r.layer)}] ${r.name}${adapter} failed: ${r.error ?? 'error'}`);
    else if (r.name === SPAN.toolCall && r.attrs[ATTR.toolOutcome] === 'error') write(`  [${layerLabel(r.layer)}] tool ${String(r.attrs[ATTR.toolName])}${adapter} failed`);
    else if (r.name === SPAN.run && r.attrs[ATTR.runStatus] === 'failed') write(`  [${layerLabel(r.layer)}] run of ${String(r.attrs[ATTR.name])} failed: ${String(r.attrs[ATTR.runReason] ?? 'error')}`);
  }, 'errors');
}
