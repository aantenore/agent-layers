import { extNamespace } from './ext.ts';
import { isPlainObject } from './util.ts';
import { CORE_VOCABULARIES, type Vocabularies, type VocabularyName } from './vocab.ts';

/**
 * Field tables of the language shapes, compact enough for the core to check mapping pointers and mapped values
 * without loading spec/schemas. The JSON Schemas in spec/schemas are the full definition.
 */
export type Field =
  | 'string' | 'number' | 'boolean' | 'any' | 'attrs' | 'ext'
  | { vocab: VocabularyName }
  | { list: Field }
  | { map: Field }
  | { object: Record<string, Field>; required?: readonly string[] };

const S = 'string' as const;
const N = 'number' as const;
const B = 'boolean' as const;
const obj = (fields: Record<string, Field>, required: readonly string[] = []): Field => ({ object: { ...fields, ext: 'ext' }, required });
const list = (f: Field): Field => ({ list: f });
const vocab = (v: VocabularyName): Field => ({ vocab: v });

const usage = obj({ inputTokens: N, outputTokens: N }, ['inputTokens', 'outputTokens']);
const part: Field = 'any';
const message = obj({ role: vocab('role'), parts: list(part) }, ['role', 'parts']);
const caller = obj({ id: S, kind: vocab('callerKind'), roles: list(S), scopes: list(S), name: S }, ['id', 'kind', 'roles', 'scopes']);
const question = obj({
  caller: { object: { id: S, kind: S, roles: list(S), scopes: list(S), name: S, ext: 'ext' }, required: ['id', 'kind'] },
  action: vocab('action'),
  target: { object: { kind: S, id: S, layer: vocab('layer'), risk: vocab('risk'), agent: S, attrs: 'attrs' }, required: ['kind', 'id', 'layer', 'risk', 'agent'] },
  args: 'any',
}, ['caller', 'action', 'target']);
const reason: Field = { object: { code: vocab('stopCode'), layer: vocab('layer'), by: S, stage: vocab('stage'), detail: S }, required: ['code'] };

export const SHAPES = Object.freeze({
  ModelRequest: obj({
    model: S, messages: list(message),
    tools: list({ object: { name: S, description: S, params: 'any' }, required: ['name', 'params'] }),
    toolMode: 'any', settings: { object: { temperature: N, maxOutputTokens: N, stop: list(S) } },
  }, ['model', 'messages']),
  ModelReply: obj({ model: S, message, finish: vocab('finish'), usage, id: S }, ['model', 'message', 'finish']),
  Message: message,
  ToolSpec: obj({ name: S, description: S, params: 'any', risk: vocab('risk'), layer: vocab('layer'), audience: S, attrs: 'attrs' }, ['name', 'description', 'params']),
  ToolResult: obj({ ok: B, text: S, data: 'any' }, ['ok', 'text']),
  KnowledgeQuery: obj({ text: S, k: N, filter: { map: 'any' }, caller }, ['text']),
  Passage: obj({ id: S, text: S, source: S, title: S, url: S, score: N, attrs: 'attrs' }, ['id', 'text', 'source']),
  Document: obj({ id: S, text: S, source: S, title: S, url: S, attrs: 'attrs' }, ['id', 'text']),
  MemoryItem: obj({ id: S, text: S, attrs: 'attrs' }, ['text']),
  Caller: caller,
  AccessQuestion: question,
  AccessDecision: obj({ allowed: B, reason: S }, ['allowed']),
  Approval: obj({ id: S, status: vocab('approvalStatus'), request: 'any', decidedBy: S, reason: S }, ['id', 'status', 'request']),
  GuardCheck: obj({ stage: vocab('stage'), text: S, agent: S, runId: S, tool: S, caller }, ['stage', 'text', 'agent', 'runId']),
  GuardVerdict: obj({ action: vocab('guardAction'), text: S, labels: list(vocab('guardLabel')), reason: S }, ['action']),
  AgentSpec: obj({ name: S, instructions: S, model: S, tools: list(S), knowledge: list(S), settings: 'any' }, ['name', 'instructions', 'model', 'tools']),
  RunResult: obj({ runId: S, status: vocab('runStatus'), output: S, reason, usage, costUsd: N, events: list('any') }, ['runId', 'status', 'output']),
  Trigger: obj({ id: S, kind: S, source: S, at: S, agent: S, data: 'any' }, ['id', 'kind', 'source']),
  EvalCase: obj({ id: S, input: 'any', expected: 'any', tags: list(S), layer: vocab('layer') }, ['id', 'input']),
  EvalScore: obj({ metric: S, value: N, layer: vocab('layer'), reason: S }, ['metric', 'value']),
  Feedback: obj({ id: S, runId: S, agent: S, rating: N, label: S, comment: S, by: S, at: S }, ['runId']),
} satisfies Record<string, Field>);

export type ShapeName = keyof typeof SHAPES;
export const isShapeName = (v: unknown): v is ShapeName => typeof v === 'string' && Object.hasOwn(SHAPES, v);

/** RFC 6901 JSON Pointer to segments; undefined when it does not parse. */
export function parsePointer(pointer: unknown): string[] | undefined {
  if (typeof pointer !== 'string') return undefined;
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) return undefined;
  const parts = pointer.slice(1).split('/');
  if (parts.some((p) => /~[^01]|~$/.test(p))) return undefined;
  return parts.map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** The field a pointer addresses inside a shape, or a problem. `/ext/<key>` needs a key of `namespace`. */
export function fieldAt(shape: ShapeName, pointer: string, namespace?: string): { field?: Field; problem?: string } {
  const segs = parsePointer(pointer);
  if (!segs) return { problem: `"${pointer}" is not a JSON Pointer` };
  let f: Field = SHAPES[shape];
  for (const [i, seg] of segs.entries()) {
    if (f === 'any' || f === 'attrs') return { field: 'any' };
    if (f === 'ext') {
      const ns = extNamespace(seg);
      if (!ns) return { problem: `ext key "${seg}" is not namespaced` };
      if (namespace && ns !== namespace) return { problem: `ext key "${seg}" is outside the adapter's namespace "${namespace}"` };
      return { field: 'any' };
    }
    if (typeof f === 'string' || 'vocab' in f) return { problem: `"${pointer}" goes below a ${typeof f === 'string' ? f : 'vocabulary'} field at /${segs.slice(0, i).join('/')}` };
    if ('list' in f) {
      if (!/^(\d+|-)$/.test(seg)) return { problem: `"${pointer}": "${seg}" is not a list index` };
      f = f.list;
    } else if ('map' in f) f = f.map;
    else {
      const next: Field | undefined = f.object[seg];
      if (!next) return { problem: `${shape} has no field "${seg}" (at ${pointer})` };
      f = next;
    }
  }
  return { field: f };
}

/** The vocabulary of a field, or of the items of a list field. */
export function vocabOf(f: Field | undefined): VocabularyName | undefined {
  if (!f || typeof f === 'string') return undefined;
  if ('vocab' in f) return f.vocab;
  if ('list' in f) return vocabOf(f.list);
  return undefined;
}

/** Problems of a value against a shape's field table: types, required fields, vocabulary values, unknown fields. */
export function shapeProblems(shape: ShapeName, value: unknown, vocab: Vocabularies = CORE_VOCABULARIES, path = '$'): string[] {
  const out: string[] = [];
  check(SHAPES[shape], value, path, out, vocab);
  return out;
}

function check(f: Field, v: unknown, path: string, out: string[], vocab: Vocabularies): void {
  if (v === undefined) return;
  if (f === 'any') return;
  if (f === 'string' || f === 'number' || f === 'boolean') {
    if (typeof v !== f || (f === 'number' && !Number.isFinite(v))) out.push(`${path}: expected ${f}`);
    return;
  }
  if (f === 'ext') {
    if (!isPlainObject(v)) out.push(`${path}: expected an object`);
    else for (const k of Object.keys(v)) if (!extNamespace(k)) out.push(`${path}.${k}: ext key is not namespaced`);
    return;
  }
  if (f === 'attrs') {
    if (!isPlainObject(v)) { out.push(`${path}: expected an object`); return; }
    for (const [k, x] of Object.entries(v)) {
      const ok = ['string', 'number', 'boolean'].includes(typeof x) || (Array.isArray(x) && x.every((s) => typeof s === 'string'));
      if (!ok) out.push(`${path}.${k}: attribute values are strings, numbers, booleans or lists of strings`);
    }
    return;
  }
  if ('vocab' in f) {
    if (!vocab.has(f.vocab, v)) out.push(`${path}: "${String(v)}" is not a ${f.vocab} value`);
    return;
  }
  if ('list' in f) {
    if (!Array.isArray(v)) { out.push(`${path}: expected a list`); return; }
    v.forEach((x, i) => check(f.list, x, `${path}[${i}]`, out, vocab));
    return;
  }
  if (!isPlainObject(v)) { out.push(`${path}: expected an object`); return; }
  if ('map' in f) { for (const [k, x] of Object.entries(v)) check(f.map, x, `${path}.${k}`, out, vocab); return; }
  for (const r of f.required ?? []) if (v[r] === undefined) out.push(`${path}.${r}: required`);
  for (const [k, x] of Object.entries(v)) {
    const sub = f.object[k];
    if (!sub) out.push(`${path}.${k}: unknown field`);
    else check(sub, x, `${path}.${k}`, out, vocab);
  }
}
