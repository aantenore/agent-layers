import type { ServiceSpec } from '@agent-layers/core';

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

const HEALTH = { interval: '5s', timeout: '3s', retries: 12 };

/** A double-quoted YAML scalar (JSON strings are valid YAML). `$` is doubled so Compose keeps it literal. */
const str = (s: string) => JSON.stringify(s.replace(/\$/g, '$$$$'));
const list = (items: readonly string[]) => `[${items.map((i) => JSON.stringify(i)).join(', ')}]`;

/**
 * Compose file for services that bring their own image. Secret references become `NAME: ${NAME}`,
 * so the value comes from the environment or the env file at run time and never appears in the file.
 */
export function composeFor(services: readonly ServiceSpec[]): string {
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
      out.push(`      interval: ${HEALTH.interval}`, `      timeout: ${HEALTH.timeout}`, `      retries: ${HEALTH.retries}`);
    }
  }
  return `${out.join('\n')}\n`;
}
