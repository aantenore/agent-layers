import { defineAdapter, PORT_VERSIONS, recordingTelemetry, sanitizeAttributes, type TelemetryPort, type TelemetryRecord } from '@agent-layers/core';
import { formatPretty } from './format.ts';

export interface ConsoleTelemetryOptions {
  format?: 'pretty' | 'json';
  stream?: 'stdout' | 'stderr';
  /** Print spans (default true). */
  spans?: boolean;
  /** Print events (default true). */
  events?: boolean;
  /** Print metrics (default false). */
  metrics?: boolean;
  /** ANSI colors in pretty output; defaults to whether the stream is a terminal. */
  color?: boolean;
}

export interface ConsoleTelemetryDeps {
  /** Receives each line without its newline. Defaults to the configured stream. */
  write?: (line: string) => void;
  name?: string;
}

/** Telemetry that prints finished spans, events and metrics, one line each. */
export function createConsoleTelemetry(options: ConsoleTelemetryOptions = {}, deps: ConsoleTelemetryDeps = {}): TelemetryPort {
  const out = process[options.stream ?? 'stderr'];
  const write = deps.write ?? ((line: string) => { out.write(`${line}\n`); });
  const color = options.color ?? !!out.isTTY;
  const json = options.format === 'json';
  const enabled = { span: options.spans ?? true, event: options.events ?? true, metric: options.metrics ?? false };
  return recordingTelemetry((record: TelemetryRecord) => {
    if (!enabled[record.type]) return;
    write(json ? JSON.stringify({ ...record, attrs: sanitizeAttributes(record.attrs) }) : formatPretty(record, color));
  }, deps.name ?? 'console-telemetry');
}

export const adapter = defineAdapter<'TelemetryPort', ConsoleTelemetryOptions>({
  layer: 'telemetry',
  port: 'TelemetryPort',
  name: 'console-telemetry',
  direction: 'outbound',
  maps: { technology: 'terminal output' },
  portVersion: PORT_VERSIONS.TelemetryPort,
  tiers: ['prototype'],
  description: 'Prints spans, events and metrics to the terminal as readable lines or JSON. For development and demos.',
  optionsSchema: {
    type: 'object',
    properties: {
      format: { enum: ['pretty', 'json'] },
      stream: { enum: ['stdout', 'stderr'] },
      spans: { type: 'boolean' },
      events: { type: 'boolean' },
      metrics: { type: 'boolean' },
      color: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  create: (options, ctx) => createConsoleTelemetry(options, { name: ctx.name }),
});

export const adapters = [adapter];
