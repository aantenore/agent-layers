import { defineAdapter, GUARD_STAGES, PORT_VERSIONS, type GuardPort, type GuardStage, type GuardVerdict } from '@agent-layers/core';
import { byPattern, DETECTOR_NAMES, FINDERS, TAGS, type DetectorName, type Finder, type Span } from './detectors.ts';

export type { DetectorName } from './detectors.ts';

export interface CustomRule {
  name: string;
  pattern: string;
  flags?: string;
  action: 'redact' | 'block';
}

/** Options, validated against `optionsSchema` before `create` runs. */
export interface RegexGuardOptions {
  /** Detectors to run (default all). */
  detect?: DetectorName[];
  /** What to do with PII and secrets (default redact). Injection always blocks. */
  piiAction?: 'redact' | 'block';
  /** Stages the guard runs at (default all). */
  stages?: GuardStage[];
  custom?: CustomRule[];
}

/** Order in which detectors claim overlapping text: the most specific first. */
const PRIORITY: readonly DetectorName[] = ['apiKey', 'email', 'iban', 'card', 'phone', 'injection'];

interface Rule { name: string; tag: string; action: 'redact' | 'block'; find: Finder }

function buildRules(options: RegexGuardOptions): Rule[] {
  const piiAction = options.piiAction ?? 'redact';
  const custom: Rule[] = (options.custom ?? []).map((c) => {
    let re: RegExp;
    try {
      re = new RegExp(c.pattern, c.flags ?? '');
    } catch (err) {
      throw new Error(`custom rule "${c.name}": invalid pattern (${err instanceof Error ? err.message : String(err)})`);
    }
    return { name: c.name, tag: `[${c.name.toUpperCase()}]`, action: c.action, find: byPattern(re) };
  });
  const wanted = new Set(options.detect ?? DETECTOR_NAMES);
  const builtin: Rule[] = PRIORITY.filter((n) => wanted.has(n)).map((name) => name === 'injection'
    ? { name, tag: '', action: 'block', find: FINDERS[name] }
    : { name, tag: TAGS[name], action: piiAction, find: FINDERS[name] });
  return [...custom, ...builtin];
}

/** Factory: usable directly from code, without the registry. */
export function createRegexGuard(options: RegexGuardOptions = {}, name = 'regex-guard'): GuardPort {
  const rules = buildRules(options);
  return {
    name,
    ...(options.stages ? { stages: [...options.stages] } : {}),
    async check(input): Promise<GuardVerdict> {
      const blocked: string[] = [];
      const redacted: string[] = [];
      const spans: (Span & { tag: string })[] = [];
      for (const rule of rules) {
        const found = rule.find(input.text);
        if (!found.length) continue;
        if (rule.action === 'block') { blocked.push(rule.name); continue; }
        redacted.push(rule.name);
        // Earlier rules win overlaps.
        for (const s of found) if (s.end > s.start && !spans.some((k) => s.start < k.end && k.start < s.end)) spans.push({ ...s, tag: rule.tag });
      }
      if (blocked.length) return { action: 'block', reason: `blocked: ${blocked.join(', ')}` };
      if (!spans.length) return { action: 'allow' };
      let text = '';
      let at = 0;
      for (const s of spans.sort((a, b) => a.start - b.start)) {
        text += input.text.slice(at, s.start) + s.tag;
        at = s.end;
      }
      return { action: 'redact', text: text + input.text.slice(at), reason: `redacted: ${redacted.join(', ')}` };
    },
  };
}

/** Descriptor: what the registry and the CLI see. */
export const adapter = defineAdapter<'GuardPort', RegexGuardOptions>({
  layer: 'guardrail',
  port: 'GuardPort',
  name: 'regex-guard',
  direction: 'outbound',
  maps: { technology: 'regular expressions' },
  portVersion: PORT_VERSIONS.GuardPort,
  tiers: ['prototype'],
  description: 'Redacts or blocks emails, phone numbers, IBANs, cards, API keys and prompt-injection phrases.',
  optionsSchema: {
    type: 'object',
    properties: {
      detect: { type: 'array', items: { enum: [...DETECTOR_NAMES] } },
      piiAction: { enum: ['redact', 'block'] },
      stages: { type: 'array', minItems: 1, items: { enum: [...GUARD_STAGES] } },
      custom: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]*$' },
            pattern: { type: 'string', minLength: 1 },
            flags: { type: 'string' },
            action: { enum: ['redact', 'block'] },
          },
          required: ['name', 'pattern', 'action'],
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  create: (options, ctx) => createRegexGuard(options, ctx.name),
});

export const adapters = [adapter];
