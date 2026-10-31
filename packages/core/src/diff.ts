import { configuredAdapters, type ResolvedConfig } from './config.ts';
import type { Layer } from './layers.ts';
import { SLOTS } from './slots.ts';
import { stableStringify } from './util.ts';

export type DiffStatus = 'same' | 'changed' | 'added' | 'removed';
export interface DiffRow { slot: string; layer: Layer; status: DiffStatus; from?: string; to?: string; note?: string }

/** Adapter names of one slot, e.g. `openai-compatible` or `docs=markdown-knowledge`. */
function summary(config: ResolvedConfig, slot: string): string | undefined {
  const entries = configuredAdapters(config.layers).filter((a) => a.slot === slot);
  if (!entries.length) return undefined;
  const shape = SLOTS.find((s) => s.slot === slot)!.shape;
  return entries.map((e) => (shape === 'map' ? `${e.key}=${e.ref.adapter}` : e.ref.adapter)).join(', ');
}

/** Slot by slot comparison of two resolved profiles. */
export function diffProfiles(a: ResolvedConfig, b: ResolvedConfig): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const s of SLOTS) {
    const from = summary(a, s.slot);
    const to = summary(b, s.slot);
    if (!from && !to) continue;
    const base = { slot: s.slot, layer: s.layer };
    if (!from) rows.push({ ...base, status: 'added', to: to! });
    else if (!to) rows.push({ ...base, status: 'removed', from });
    else if (from !== to) rows.push({ ...base, status: 'changed', from, to });
    else {
      const same = stableStringify((a.layers as Record<string, unknown>)[s.slot]) === stableStringify((b.layers as Record<string, unknown>)[s.slot]);
      rows.push(same ? { ...base, status: 'same', from, to } : { ...base, status: 'changed', from, to, note: 'options' });
    }
  }
  return rows;
}

export function formatDiff(rows: readonly DiffRow[], a: string, b: string): string {
  const lines = [`${a} → ${b}`];
  for (const r of rows) {
    const what = r.status === 'same' ? r.from
      : r.status === 'changed' ? `${r.from} → ${r.to}${r.note ? ` (${r.note})` : ''}`
        : r.status === 'added' ? r.to : r.from;
    lines.push(`  ${r.slot.padEnd(14)} ${r.status.padEnd(8)} ${what}`);
  }
  return lines.join('\n');
}
