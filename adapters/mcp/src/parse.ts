import { createHash } from 'node:crypto';
import type { Passage } from '@agent-layers/core';

const ENTRY = /<entry>\s*<content>([\s\S]*?)<\/content>\s*<metadata>([\s\S]*?)<\/metadata>\s*<\/entry>/g;
const JSON_LISTS = ['passages', 'results', 'documents', 'points', 'items', 'data'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Short stable id for passages whose backend does not provide one. */
export const hashId = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 12);

/** Keeps only the Passage fields; returns undefined for items without text. */
export function toPassage(raw: unknown, source?: string): Passage | undefined {
  if (typeof raw === 'string') return raw.trim() ? { id: hashId(raw), text: raw, ...(source ? { source } : {}) } : undefined;
  if (!isRecord(raw)) return undefined;
  const text = [raw.text, raw.content, raw.document, raw.page_content, raw.passage].find((t): t is string => typeof t === 'string');
  if (!text?.trim()) return undefined;
  const id = [raw.id, raw._id, raw.uuid].find((v) => typeof v === 'string' || typeof v === 'number');
  const src = typeof raw.source === 'string' ? raw.source : source;
  return {
    id: id === undefined ? hashId(text) : String(id),
    text,
    ...(src ? { source: src } : {}),
    ...(typeof raw.score === 'number' ? { score: raw.score } : {}),
    ...(isRecord(raw.metadata) ? { metadata: raw.metadata } : {}),
  };
}

/** True when every `filter` key equals the same key in `metadata`. */
export function matchesFilter(metadata: Record<string, unknown> | undefined, filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([k, v]) => metadata?.[k] === v);
}

function fromJson(value: unknown, source: string): Passage[] | undefined {
  const list = Array.isArray(value) ? value : isRecord(value) ? JSON_LISTS.map((k) => value[k]).find(Array.isArray) : undefined;
  return list?.flatMap((item: unknown) => toPassage(item, source) ?? []);
}

/**
 * Default parser for MCP retrieval tools. Understands, in order: a JSON array or `{ passages | results | ... }` object,
 * the `<entry><content>..</content><metadata>{json}</metadata></entry>` output of mcp-server-qdrant (the metadata `id`,
 * when present, becomes the passage id), and otherwise treats the text as one passage.
 */
export function parseMcpResult(result: { content: string }, source: string): Passage[] {
  let text = result.content.trim();
  if (!text) return [];
  if (text[0] === '[' || text[0] === '{') {
    try {
      const json: unknown = JSON.parse(text);
      // mcp-server-qdrant 0.8 returns its formatted entries as one JSON array of strings.
      if (Array.isArray(json) && json.every((x) => typeof x === 'string') && json.some((x) => x.includes('<entry>'))) text = json.join('\n');
      else {
        const found = fromJson(json, source);
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
      return { id: typeof id === 'string' || typeof id === 'number' ? String(id) : hashId(body), text: body, source, ...(metadata ? { metadata } : {}) };
    });
  }
  if (/^no (information|results?) found/i.test(text)) return [];
  return [{ id: hashId(text), text, source }];
}
