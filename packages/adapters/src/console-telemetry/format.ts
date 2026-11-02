import { layerLabel, sanitizeAttributes, type Attributes, type TelemetryRecord } from '@agent-layers/core';

const ANSI = { dim: '\u001b[2m', red: '\u001b[31m', green: '\u001b[32m', reset: '\u001b[0m' } as const;

const paint = (color: boolean, code: keyof typeof ANSI, text: string) => (color ? `${ANSI[code]}${text}${ANSI.reset}` : text);

function formatValue(value: unknown): string {
  const text = Array.isArray(value) ? value.join(',') : String(value);
  return /[\s"=]/.test(text) || text === '' ? JSON.stringify(text) : text;
}

/** `key=value` pairs; `agent.layer` is already in the label and undefined values are skipped. */
export function formatAttributes(attrs: Attributes): string {
  return Object.entries(sanitizeAttributes(attrs))
    .filter(([key]) => key !== 'agent.layer')
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ');
}

/** One human-readable line for a record. */
export function formatPretty(record: TelemetryRecord, color: boolean): string {
  const label = paint(color, 'dim', `[${layerLabel(record.layer)}]`);
  let head: string;
  if (record.type === 'span') {
    const status = record.status === 'ok'
      ? paint(color, 'green', 'ok')
      : paint(color, 'red', `error ${(record.error ?? 'failed').replace(/\s+/g, ' ')}`);
    head = `${record.name} ${record.durationMs}ms ${status}`;
  } else if (record.type === 'event') head = `${record.name} event`;
  else head = `${record.name} metric ${record.value}`;
  return [label, head, formatAttributes(record.attrs)].filter(Boolean).join(' ');
}
