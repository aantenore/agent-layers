import { appendFileSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineAdapter, defineLimits, limitProperties, limitValue, PORT_VERSIONS, recordingTelemetry, sanitizeAttributes, type LimitValue, type TelemetryPort, type TelemetryRecord } from '@agent-layers/core';
import { w3cCodec } from './w3c.ts';

export interface JsonlTelemetryOptions {
  /** File to append to, relative to the config directory. Parent directories are created. */
  path: string;
  /** Empty the file when the adapter starts (default false: keep appending). */
  truncate?: boolean;
  /** Write W3C trace and span ids on each record and join the caller's trace (default true). */
  traceIds?: boolean;
  /** Size at which the file is rotated, in bytes (default 104857600). A single record larger than this is still written, to a fresh file. */
  maxFileBytes?: LimitValue;
  /** Rotated files kept: `<path>.1` (newest) to `<path>.<maxFiles>`; older ones are deleted (default 5). */
  maxFiles?: number;
}

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  maxFileBytes: { path: 'options.maxFileBytes', default: 104_857_600, unit: 'bytes', min: 1024, unbounded: 'warn', safe: { max: 1_073_741_824 } },
  maxFiles: { path: 'options.maxFiles', default: 5, unit: 'count', min: 1, max: 100 },
});

/**
 * Moves `file` to `file.1`, `file.1` to `file.2` and so on; the one that would become `file.<keep + 1>` is deleted.
 * Synchronous, so a record is never written while the files are being shifted.
 */
function rotate(file: string, keep: number): void {
  rmSync(`${file}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    try { renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }
  renameSync(file, `${file}.1`);
}

/**
 * Telemetry that appends one JSON record per line to a file, rotating it at `maxFileBytes`. Writes are synchronous,
 * so nothing is buffered. One process should own a file: the size is tracked in memory, not re-read.
 */
export function createJsonlTelemetry(options: JsonlTelemetryOptions, deps: { cwd?: string; name?: string } = {}): TelemetryPort {
  const file = resolve(deps.cwd ?? process.cwd(), options.path);
  const maxBytes = limitValue(LIMITS.maxFileBytes, options.maxFileBytes);
  const keep = limitValue(LIMITS.maxFiles, options.maxFiles);
  mkdirSync(dirname(file), { recursive: true });
  if (options.truncate) writeFileSync(file, '');
  let size = 0;
  try { size = statSync(file).size; } catch { /* a new file */ }
  let warned = false;
  const warn = (what: string, err: unknown) => {
    // Telemetry must never break a run: report the first failure and keep going.
    if (!warned) process.stderr.write(`jsonl-telemetry: cannot ${what} ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
    warned = true;
  };
  const port = recordingTelemetry((record: TelemetryRecord) => {
    const line = `${JSON.stringify({ ...record, attrs: sanitizeAttributes(record.attrs) })}\n`;
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > maxBytes) {
      // If the files cannot be shifted the record is still written (the cap is exceeded rather than data lost).
      try { rotate(file, keep); } catch (err) { warn('rotate', err); }
      size = 0;
    }
    try {
      appendFileSync(file, line);
      size += bytes;
    } catch (err) {
      warn('write', err);
    }
  }, deps.name ?? 'jsonl-telemetry', options.traceIds !== false ? { trace: w3cCodec } : {});
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
      ...limitProperties(LIMITS, {
        maxFileBytes: 'Size at which the file is rotated; a single record larger than this is still written, to a fresh file',
        maxFiles: 'Rotated files kept (<path>.1 is the newest); older ones are deleted',
      }),
    },
    required: ['path'],
    additionalProperties: false,
  },
  limits: LIMITS,
  create: (options, ctx) => createJsonlTelemetry(options, { cwd: ctx.cwd, name: ctx.name }),
});

export const adapters = [adapter];
