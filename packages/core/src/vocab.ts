import { LAYERS } from './layers.ts';
import { GUARD_STAGES } from './ports/guard.ts';
import { isPlainObject } from './util.ts';

/**
 * How a vocabulary grows. `no`: closed. `aliases`: config may add other names for existing values. `like`: config may
 * add values, each `like` a core value, and aliases. `namespaced`: adapters use `<namespace>.<name>` values directly.
 */
export type Extensibility = 'no' | 'aliases' | 'like' | 'namespaced';

export interface VocabularyInfo {
  /** Values the core defines and branches on. */
  core: readonly string[];
  extensible: Extensibility;
  /** What uses it. */
  usedBy: string;
}

/** The SDK's closed sets of values, and how config may extend each. See docs/decisions/0001-sdk-language.md. */
export const VOCABULARIES = Object.freeze({
  layer: { core: LAYERS.map((l) => l.layer), extensible: 'no', usedBy: 'everything' },
  role: { core: ['system', 'user', 'assistant', 'tool'], extensible: 'aliases', usedBy: 'Message.role' },
  part: { core: ['text', 'media', 'call', 'result', 'reasoning'], extensible: 'namespaced', usedBy: 'Part.type' },
  finish: { core: ['end', 'limit', 'tools', 'refused', 'other'], extensible: 'like', usedBy: 'ModelReply.finish' },
  risk: { core: ['read', 'write', 'exec'], extensible: 'like', usedBy: 'ToolSpec.risk, policy rules' },
  effect: { core: ['allow', 'ask', 'deny'], extensible: 'no', usedBy: 'policy rules' },
  action: { core: ['call'], extensible: 'like', usedBy: 'AccessQuestion.action' },
  stage: { core: [...GUARD_STAGES], extensible: 'no', usedBy: 'GuardCheck.stage' },
  guardAction: { core: ['allow', 'block', 'redact'], extensible: 'no', usedBy: 'GuardVerdict.action' },
  guardLabel: { core: ['pii', 'secret', 'injection', 'toxicity', 'policy', 'other'], extensible: 'like', usedBy: 'GuardVerdict.labels' },
  runStatus: { core: ['completed', 'failed', 'stopped', 'waiting'], extensible: 'no', usedBy: 'RunResult.status' },
  stopCode: {
    core: ['guard_block', 'denied', 'aborted', 'timeout', 'limit', 'needs_input', 'needs_auth', 'rejected', 'error'],
    extensible: 'like', usedBy: 'RunResult.reason.code',
  },
  event: { core: ['run.start', 'model.reply', 'tool.call', 'tool.result', 'text', 'run.end'], extensible: 'namespaced', usedBy: 'RunEvent.type' },
  callerKind: { core: ['user', 'agent'], extensible: 'no', usedBy: 'Caller.kind' },
  approvalStatus: { core: ['pending', 'approved', 'denied', 'expired'], extensible: 'no', usedBy: 'Approval.status' },
} satisfies Record<string, VocabularyInfo>) as Readonly<Record<VocabularyName, VocabularyInfo>>;

export type VocabularyName =
  | 'layer' | 'role' | 'part' | 'finish' | 'risk' | 'effect' | 'action' | 'stage' | 'guardAction' | 'guardLabel'
  | 'runStatus' | 'stopCode' | 'event' | 'callerKind' | 'approvalStatus';

/** The `vocabularies` block of the stack config (also allowed per profile, and on adapter descriptors). */
export type VocabulariesConfig = Partial<Record<VocabularyName, VocabularyExtension>>;
export interface VocabularyExtension {
  /** New values, each behaving like a core value of the same vocabulary for core logic. */
  add?: Record<string, { like: string }>;
  /** Other names for existing values, resolved by adapters at the edge; they never reach the core. */
  aliases?: Record<string, string>;
}

/** Names of added values and aliases. */
export const VOCAB_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

export const isVocabularyName = (v: unknown): v is VocabularyName => typeof v === 'string' && Object.hasOwn(VOCABULARIES, v);

/** Problems of one `vocabularies` block, as `<path>: <problem>`. Checks names, collisions, `like` targets. */
export function vocabularyProblems(block: unknown, path = 'vocabularies', base?: Vocabularies): string[] {
  if (block === undefined || block === null) return [];
  if (!isPlainObject(block)) return [`${path}: must be an object`];
  const errors: string[] = [];
  for (const [name, ext] of Object.entries(block)) {
    const at = `${path}.${name}`;
    if (!isVocabularyName(name)) { errors.push(`${at}: unknown vocabulary (known: ${Object.keys(VOCABULARIES).join(', ')})`); continue; }
    if (!isPlainObject(ext)) { errors.push(`${at}: must be an object`); continue; }
    const info = VOCABULARIES[name];
    const add = isPlainObject(ext.add) ? ext.add : {};
    const aliases = isPlainObject(ext.aliases) ? ext.aliases : {};
    if (info.extensible === 'no' || info.extensible === 'namespaced') {
      if (Object.keys(add).length || Object.keys(aliases).length) {
        errors.push(`${at}: ${info.extensible === 'no' ? 'is closed' : 'grows through namespaced values (<namespace>.<name>), not config'}`);
      }
      continue;
    }
    if (info.extensible === 'aliases' && Object.keys(add).length) errors.push(`${at}.add: only aliases are allowed for ${name}`);
    const known = new Set([...info.core, ...(base?.added(name) ?? [])]);
    const taken = new Set<string>([...known, ...(base?.aliasNames(name) ?? [])]);
    for (const [value, def] of Object.entries(add)) {
      const where = `${at}.add.${value}`;
      if (!VOCAB_NAME.test(value)) errors.push(`${where}: name must match ${VOCAB_NAME.source}`);
      else if (taken.has(value)) errors.push(`${where}: collides with an existing value or alias`);
      const like = isPlainObject(def) ? def.like : undefined;
      if (typeof like !== 'string' || !info.core.includes(like)) errors.push(`${where}.like: must be a core value of ${name} (${info.core.join(', ')})`);
      taken.add(value);
      known.add(value);
    }
    for (const [alias, target] of Object.entries(aliases)) {
      const where = `${at}.aliases.${alias}`;
      if (!VOCAB_NAME.test(alias)) errors.push(`${where}: name must match ${VOCAB_NAME.source}`);
      else if (taken.has(alias)) errors.push(`${where}: collides with an existing value or alias`);
      if (typeof target !== 'string' || !known.has(target)) errors.push(`${where}: must name an existing value of ${name}`);
      taken.add(alias);
    }
  }
  return errors;
}

/**
 * The effective vocabularies of a stack: core values plus what adapters declare and the config adds (config wins on
 * conflict). Core logic reads `core()`; adapters and telemetry keep the added value itself.
 */
export class Vocabularies {
  #added = new Map<VocabularyName, Map<string, string>>();
  #aliases = new Map<VocabularyName, Map<string, string>>();

  /** Builds from blocks in order (adapter declarations first, then config). Invalid entries are skipped; validate first. */
  constructor(blocks: readonly (VocabulariesConfig | undefined)[] = []) {
    for (const block of blocks) {
      for (const [name, ext] of Object.entries(block ?? {})) {
        if (!isVocabularyName(name) || !ext) continue;
        const info = VOCABULARIES[name];
        for (const [value, def] of Object.entries(ext.add ?? {})) {
          if (info.extensible === 'like' && info.core.includes(def?.like) && !info.core.includes(value)) this.#map(this.#added, name).set(value, def.like);
        }
        for (const [alias, target] of Object.entries(ext.aliases ?? {})) {
          if ((info.extensible === 'like' || info.extensible === 'aliases') && !info.core.includes(alias)) this.#map(this.#aliases, name).set(alias, target);
        }
      }
    }
  }

  #map(m: Map<VocabularyName, Map<string, string>>, name: VocabularyName): Map<string, string> {
    let v = m.get(name);
    if (!v) m.set(name, (v = new Map()));
    return v;
  }

  /** Values added by config or adapters. */
  added(name: VocabularyName): string[] { return [...(this.#added.get(name)?.keys() ?? [])]; }
  aliasNames(name: VocabularyName): string[] { return [...(this.#aliases.get(name)?.keys() ?? [])]; }

  /** Every accepted value: core and added (aliases excluded). */
  values(name: VocabularyName): string[] { return [...VOCABULARIES[name].core, ...this.added(name)]; }

  /** The value an alias stands for; the value itself when it is not an alias. Adapters call it at the edge. */
  resolve(name: VocabularyName, value: string): string {
    return this.#aliases.get(name)?.get(value) ?? value;
  }

  /** True for a core or added value (after alias resolution); namespaced values count for namespaced vocabularies. */
  has(name: VocabularyName, value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const v = this.resolve(name, value);
    if (VOCABULARIES[name].core.includes(v) || this.#added.get(name)?.has(v)) return true;
    return VOCABULARIES[name].extensible === 'namespaced' && isNamespaced(v);
  }

  /** The core value core logic sees: the value, its `like`, or undefined when unknown. */
  core(name: VocabularyName, value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const v = this.resolve(name, value);
    if (VOCABULARIES[name].core.includes(v)) return v;
    return this.#added.get(name)?.get(v);
  }

  /**
   * The value to keep for an incoming one: itself when known, else `other` where the vocabulary has it (the native
   * value then belongs in `ext`), else undefined (the caller fails; identity and authorization fail closed).
   */
  accept(name: VocabularyName, value: unknown): string | undefined {
    if (this.has(name, value)) return this.resolve(name, value as string);
    return VOCABULARIES[name].core.includes('other') ? 'other' : undefined;
  }
}

/** `<namespace>.<name>` with a lowercase namespace. */
export const isNamespaced = (value: string) => /^[a-z][a-z0-9-]*\.[A-Za-z0-9_.-]+$/.test(value);

/** Core vocabularies only. */
export const CORE_VOCABULARIES = new Vocabularies();
