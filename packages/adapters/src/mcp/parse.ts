import { createHash } from 'node:crypto';
import { noMappings, type AttrFilter, type Attrs, type MappingRule, type Mappings, type Passage } from '@agent-layers/core';

const ENTRY = /<entry>\s*<content>([\s\S]*?)<\/content>\s*<metadata>([\s\S]*?)<\/metadata>\s*<\/entry>/g;
const JSON_LISTS = ['passages', 'results', 'documents', 'points', 'items', 'data'];

/** Ext key for item metadata that is not a plain attribute (nested objects, mixed lists). */
export const METADATA_EXT = 'mcp.metadata';

/** Default `in` rule on `Passage`: an item's own `source` is kept as an attribute (the passage source is the instance). */
export const PASSAGE_RULES: readonly MappingRule[] = [{ from: '/source', to: '/attrs/source' }];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isAttr = (v: unknown): v is Attrs[string] =>
  typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (Array.isArray(v) && v.every((x) => typeof x === 'string'));

/** Short stable id for passages whose backend does not provide one. */
export const hashId = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 12);

/**
 * A passage from the parts a backend item gave: plain metadata values become `attrs` (a string `title` and `url` become
 * the fields of the same name), other values `ext["mcp.metadata"]`. The `in` mapping rules then run over `native`.
 */
function passageOf(native: unknown, id: string, text: string, source: string, score: unknown, metadata: Record<string, unknown> | undefined, mappings: Mappings): Passage {
  const attrs: Attrs = {};
  const rest: Record<string, unknown> = {};
  let title: string | undefined;
  let url: string | undefined;
  for (const [k, v] of Object.entries(metadata ?? {})) {
    if (k === 'title' && typeof v === 'string') title = v;
    else if (k === 'url' && typeof v === 'string') url = v;
    else if (isAttr(v)) attrs[k] = v;
    else if (v !== undefined) rest[k] = v;
  }
  return mappings.in(native, {
    id, text, source,
    ...(title !== undefined ? { title } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(typeof score === 'number' && Number.isFinite(score) ? { score } : {}),
    ...(Object.keys(attrs).length ? { attrs } : {}),
    ...(Object.keys(rest).length ? { ext: { [METADATA_EXT]: rest } } : {}),
  } as Passage);
}

/** One backend item as a passage; undefined for items without text. `source` is the instance name. */
export function toPassage(raw: unknown, source: string, mappings: Mappings = noMappings()): Passage | undefined {
  if (typeof raw === 'string') return raw.trim() ? passageOf({ text: raw }, hashId(raw), raw, source, undefined, undefined, mappings) : undefined;
  if (!isRecord(raw)) return undefined;
  const text = [raw.text, raw.content, raw.document, raw.page_content, raw.passage].find((t): t is string => typeof t === 'string');
  if (!text?.trim()) return undefined;
  const id = [raw.id, raw._id, raw.uuid].find((v) => typeof v === 'string' || typeof v === 'number');
  const metadata = isRecord(raw.attrs) ? raw.attrs : isRecord(raw.metadata) ? raw.metadata : isRecord(raw.payload) ? raw.payload : undefined;
  return passageOf(raw, id === undefined ? hashId(text) : String(id), text, source, raw.score, metadata, mappings);
}

/** True when the attributes satisfy the filter: every key present and equal; a list in the filter means any of. */
export function matchesFilter(attrs: Attrs | undefined, filter: AttrFilter | undefined): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([k, wanted]) => {
    const have = attrs?.[k];
    if (have === undefined) return false;
    const values = Array.isArray(have) ? have : [have];
    return (Array.isArray(wanted) ? wanted : [wanted]).some((w) => values.some((v) => v === w));
  });
}

function fromJson(value: unknown, source: string, mappings: Mappings): Passage[] | undefined {
  const list = Array.isArray(value) ? value : isRecord(value) ? JSON_LISTS.map((k) => value[k]).find(Array.isArray) : undefined;
  return list?.flatMap((item: unknown) => toPassage(item, source, mappings) ?? []);
}

/**
 * Default parser for MCP retrieval tools. Understands, in order: a JSON array or `{ passages | results | ... }` object,
 * the `<entry><content>..</content><metadata>{json}</metadata></entry>` output of mcp-server-qdrant (the metadata `id`,
 * when present, becomes the passage id), and otherwise treats the text as one passage. The source document of the `in`
 * mapping rules is the JSON item, `{ content, metadata }` for an entry, or `{ text }` for plain text.
 */
export function parseMcpResult(result: { text: string }, source: string, mappings: Mappings = noMappings()): Passage[] {
  let text = result.text.trim();
  if (!text) return [];
  if (text[0] === '[' || text[0] === '{') {
    try {
      const json: unknown = JSON.parse(text);
      // mcp-server-qdrant 0.8 returns its formatted entries as one JSON array of strings.
      if (Array.isArray(json) && json.every((x) => typeof x === 'string') && json.some((x) => x.includes('<entry>'))) text = json.join('\n');
      else {
        const found = fromJson(json, source, mappings);
        if (found) return found;
      }
    } catch {
      // not JSON: fall through
    }
  }
  const entries = [...text.matchAll(ENTRY)];
  if (entries.length) {
    return entries.map(([, content, meta]) => {
      let metadata: Record<string, unknown> | undefined;
      try {
        const parsed: unknown = meta!.trim() ? JSON.parse(meta!) : undefined;
        if (isRecord(parsed)) metadata = parsed;
      } catch {
        // metadata is informative only
      }
      const body = content!.trim();
      const id = metadata?.id;
      return passageOf({ content: body, ...(metadata ? { metadata } : {}) }, typeof id === 'string' || typeof id === 'number' ? String(id) : hashId(body), body, source, undefined, metadata, mappings);
    });
  }
  if (/^no (information|results?) found/i.test(text)) return [];
  return [passageOf({ text }, hashId(text), text, source, undefined, undefined, mappings)];
}
