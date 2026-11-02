import { delegationProblems, type Delegation } from '@agent-layers/core';

/** A bounds header the gateway refuses: the message names the header and the rule, never the value. */
export class BoundsHeaderError extends Error {
  override name = 'BoundsHeaderError';
}

/** A parsed structured-field item: only the types the bounds headers use. */
type Item = { type: 'integer' | 'decimal'; value: number } | { type: 'string' | 'token'; value: string };

const KEY = /^[a-z*][a-z0-9_\-.*]*/;
const NUMBER = /^-?\d+(?:\.\d+)?/;
const TOKEN = /^[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*/;
const OWS = /^[ \t]*/;

/**
 * Parses an RFC 9651 dictionary of bare items: `key=value` members separated by commas with optional whitespace, keys
 * in lowercase, values integer (up to 15 digits), decimal (up to 12 and 3 digits), string or token. Strict: parameters
 * (`;...`), inner lists, booleans (a key without a value) and repeated keys are refused.
 */
function parseDictionary(input: string, header: string): Map<string, Item> {
  const bad = (rule: string): never => { throw new BoundsHeaderError(`${header}: ${rule}`); };
  const out = new Map<string, Item>();
  let rest = input.replace(/^[ \t]+|[ \t]+$/g, '');
  while (rest.length) {
    const key = KEY.exec(rest)?.[0];
    if (!key) return bad('a member must start with a lowercase key');
    rest = rest.slice(key.length);
    if (!rest.startsWith('=')) return bad('a member needs a value (key=value)');
    if (out.has(key)) return bad(`"${key}" appears twice`);
    rest = rest.slice(1);
    const item = parseItem(rest, bad);
    out.set(key, item.item);
    rest = rest.slice(item.length);
    if (rest.startsWith(';')) return bad('parameters are not accepted');
    rest = rest.replace(OWS, '');
    if (!rest.length) break;
    if (!rest.startsWith(',')) return bad('members must be separated by a comma');
    rest = rest.slice(1).replace(OWS, '');
    if (!rest.length) return bad('a trailing comma is not allowed');
  }
  return out;
}

function parseItem(s: string, bad: (rule: string) => never): { item: Item; length: number } {
  if (s.startsWith('"')) {
    let value = '';
    for (let i = 1; i < s.length; i++) {
      const c = s[i]!;
      const code = c.charCodeAt(0);
      if (c === '"') return { item: { type: 'string', value }, length: i + 1 };
      if (c === '\\') {
        const next = s[++i];
        if (next !== '"' && next !== '\\') return bad('invalid escape in a string');
        value += next;
      } else if (code < 0x20 || code > 0x7e) return bad('a string must be printable ASCII');
      else value += c;
    }
    return bad('unterminated string');
  }
  const num = NUMBER.exec(s)?.[0];
  if (num) {
    const [whole = '', fraction] = num.replace('-', '').split('.');
    if (fraction === undefined) return whole.length <= 15 ? { item: { type: 'integer', value: Number(num) }, length: num.length } : bad('integer longer than 15 digits');
    return whole.length <= 12 && fraction.length <= 3 ? { item: { type: 'decimal', value: Number(num) }, length: num.length } : bad('decimal beyond 12 and 3 digits');
  }
  const token = TOKEN.exec(s)?.[0];
  if (token) return { item: { type: 'token', value: token }, length: token.length };
  return bad('a value must be an integer, decimal, string or token');
}

/** One header value: a repeated header is malformed, and a value longer than `maxChars` is refused. */
function single(value: string | string[] | undefined, header: string, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) throw new BoundsHeaderError(`${header}: the header must not be repeated`);
  if (value.length > maxChars) throw new BoundsHeaderError(`${header}: longer than ${maxChars} characters`);
  return value;
}

const NUMERIC = { 'remaining-ms': 'remainingMs', hops: 'hops', 'max-hops': 'maxHops', tokens: 'tokens', 'cost-usd': 'costUsd' } as const;
const INTEGERS = new Set(['remaining-ms', 'hops', 'max-hops', 'tokens']);

/**
 * The `Agent-Bounds` header: `remaining-ms=45000, hops=2, max-hops=4, tokens=1000, cost-usd=0.5`. `remaining-ms`,
 * `hops` and `max-hops` are required integers; `tokens` is an optional integer; `cost-usd` an optional integer or
 * decimal. Other members are ignored. Undefined when the header is absent; throws `BoundsHeaderError` when it is
 * malformed or the values are not valid bounds.
 */
export function parseAgentBounds(value: string | string[] | undefined, maxChars: number): Delegation | undefined {
  const text = single(value, 'Agent-Bounds', maxChars);
  if (text === undefined) return undefined;
  const members = parseDictionary(text, 'Agent-Bounds');
  const out: Record<string, number> = {};
  for (const [key, field] of Object.entries(NUMERIC)) {
    const item = members.get(key);
    if (!item) continue;
    if (item.type !== 'integer' && !(item.type === 'decimal' && !INTEGERS.has(key))) throw new BoundsHeaderError(`Agent-Bounds: ${key} must be ${INTEGERS.has(key) ? 'an integer' : 'a number'}`);
    out[field] = item.value as number;
  }
  const problems = delegationProblems(out);
  if (problems.length) throw new BoundsHeaderError(`Agent-Bounds: ${problems.join('; ')}`);
  return out as unknown as Delegation;
}

/**
 * The `Agent-Lineage` header: `root="run-a1", parent="run-b7"`, values as strings or tokens. Undefined when absent;
 * throws `BoundsHeaderError` when malformed. Other members are ignored.
 */
export function parseAgentLineage(value: string | string[] | undefined, maxChars: number): { rootRunId?: string; parentRunId?: string } | undefined {
  const text = single(value, 'Agent-Lineage', maxChars);
  if (text === undefined) return undefined;
  const members = parseDictionary(text, 'Agent-Lineage');
  const out: { rootRunId?: string; parentRunId?: string } = {};
  for (const [key, field] of [['root', 'rootRunId'], ['parent', 'parentRunId']] as const) {
    const item = members.get(key);
    if (!item) continue;
    if (item.type !== 'string' && item.type !== 'token') throw new BoundsHeaderError(`Agent-Lineage: ${key} must be a string or token`);
    out[field] = item.value as string;
  }
  return out;
}

/**
 * The delegation a request carries in `Agent-Bounds` and `Agent-Lineage`, or undefined when it carries no bounds
 * (a lineage alone is checked but has nothing to attach to). Throws `BoundsHeaderError` on a malformed or invalid header.
 */
export function delegationOf(headers: Record<string, string | string[] | undefined>, maxChars: number): Delegation | undefined {
  const bounds = parseAgentBounds(headers['agent-bounds'], maxChars);
  const lineage = parseAgentLineage(headers['agent-lineage'], maxChars);
  if (!bounds) return undefined;
  const merged = { ...bounds, ...lineage };
  const problems = delegationProblems(merged);
  if (problems.length) throw new BoundsHeaderError(`Agent-Lineage: ${problems.join('; ')}`);
  return merged;
}
