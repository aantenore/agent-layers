import { defineLimits, limitValue, type ServiceSpec } from '@agent-layers/core';

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Health check timing of the generated services. */
export interface HealthOptions {
  /** Seconds between health checks (default 5). */
  healthIntervalS?: number;
  /** Seconds a health check may take (default 3). */
  healthTimeoutS?: number;
  /** Failed checks before a service counts as unhealthy (default 12). */
  healthRetries?: number;
}

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  healthIntervalS: { path: 'options.healthIntervalS', default: 5, unit: 's', min: 1, max: 3600, safe: { max: 60 } },
  healthTimeoutS: { path: 'options.healthTimeoutS', default: 3, unit: 's', min: 1, max: 3600, safe: { max: 30 } },
  healthRetries: { path: 'options.healthRetries', default: 12, unit: 'count', min: 1, max: 1000, safe: { max: 60 } },
  errorOutputChars: { path: 'options.errorOutputChars', default: 500, unit: 'chars', min: 0, max: 100_000, safe: { max: 2000 } },
});

/** A double-quoted YAML scalar (JSON strings are valid YAML). `$` is doubled so Compose keeps it literal. */
const str = (s: string) => JSON.stringify(s.replace(/\$/g, '$$$$'));
const list = (items: readonly string[]) => `[${items.map((i) => JSON.stringify(i)).join(', ')}]`;

/**
 * Compose file for services that bring their own image. Secret references become `NAME: ${NAME}`,
 * so the value comes from the environment or the env file at run time and never appears in the file.
 */
export function composeFor(services: readonly ServiceSpec[], health: HealthOptions = {}): string {
  const interval = limitValue(LIMITS.healthIntervalS, health.healthIntervalS);
  const timeout = limitValue(LIMITS.healthTimeoutS, health.healthTimeoutS);
  const retries = limitValue(LIMITS.healthRetries, health.healthRetries);
  const out = ['services:'];
  for (const s of services) {
    if (!NAME.test(s.name)) throw new Error(`service "${s.name}": invalid name`);
    out.push(`  ${s.name}:`, `    image: ${JSON.stringify(s.image)}`);
    const env = Object.entries(s.env ?? {});
    if (env.length || s.secretRefs?.length) {
      out.push('    environment:');
      for (const [k, v] of env) {
        if (!VAR.test(k)) throw new Error(`service "${s.name}": invalid variable name "${k}"`);
        out.push(`      ${k}: ${str(v)}`);
      }
      for (const ref of s.secretRefs ?? []) {
        if (!VAR.test(ref)) throw new Error(`service "${s.name}": invalid secret reference "${ref}"`);
        out.push(`      ${ref}: "\${${ref}}"`);
      }
    }
    if (s.ports?.length) out.push('    ports:', ...s.ports.map((p) => `      - "127.0.0.1:${p}:${p}"`));
    if (s.health?.command?.length) {
      out.push('    healthcheck:', `      test: ${list(['CMD', ...s.health.command])}`);
      out.push(`      interval: ${interval}s`, `      timeout: ${timeout}s`, `      retries: ${retries}`);
    }
  }
  return `${out.join('\n')}\n`;
}
