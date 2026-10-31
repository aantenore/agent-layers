import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineAdapter, PORT_VERSIONS, recordingTelemetry, sanitizeAttributes, type TelemetryPort, type TelemetryRecord } from '@agent-layers/core';

export interface JsonlTelemetryOptions {
  /** File to append to, relative to the config directory. Parent directories are created. */
  path: string;
  /** Empty the file when the adapter starts (default false: keep appending). */
  truncate?: boolean;
  /** Write W3C trace and span ids on each record and join the caller's trace (default true). */
  traceIds?: boolean;
}

/** Telemetry that appends one JSON record per line to a file. Writes are synchronous, so nothing is buffered. */
export function createJsonlTelemetry(options: JsonlTelemetryOptions, deps: { cwd?: string; name?: string } = {}): TelemetryPort {
  const file = resolve(deps.cwd ?? process.cwd(), options.path);
  mkdirSync(dirname(file), { recursive: true });
  if (options.truncate) writeFileSync(file, '');
  let warned = false;
  const port = recordingTelemetry((record: TelemetryRecord) => {
    try {
      appendFileSync(file, `${JSON.stringify({ ...record, attrs: sanitizeAttributes(record.attrs) })}\n`);
    } catch (err) {
      // Telemetry must never break a run: report the first failure and keep going.
      if (!warned) process.stderr.write(`jsonl-telemetry: cannot write ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
      warned = true;
    }
  }, deps.name ?? 'jsonl-telemetry', { traceIds: options.traceIds !== false });
  return { ...port, native: () => file };
}

export const adapter = defineAdapter<'TelemetryPort', JsonlTelemetryOptions>({
  layer: 'telemetry',
  port: 'TelemetryPort',
  name: 'jsonl-telemetry',
  direction: 'outbound',
  maps: { technology: 'JSON Lines files' },
  portVersion: PORT_VERSIONS.TelemetryPort,
  tiers: ['prototype', 'production'],
  description: 'Appends spans, events and metrics to a JSON Lines file, one record per line.',
  optionsSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1 },
      truncate: { type: 'boolean' },
      traceIds: { type: 'boolean' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  create: (options, ctx) => createJsonlTelemetry(options, { cwd: ctx.cwd, name: ctx.name }),
});

export const adapters = [adapter];
