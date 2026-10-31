import { shapeProblems, stableStringify, type ShapeName } from '@agent-layers/core';

export interface RoundTripOptions<N> {
  /** The language shape `toLanguage` must produce; each result is checked with `shapeProblems`. */
  shape?: ShapeName;
  /** Equality of two standard values (default: deep equality of their JSON, keys sorted). */
  equal?: (a: N, b: N) => boolean;
}

/** JSON path of the first difference between two values, for the failure message. */
function firstDifference(a: unknown, b: unknown, path = '$'): string | undefined {
  if (stableStringify(a) === stableStringify(b)) return undefined;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const d = firstDifference(x[k], y[k], Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`);
      if (d) return d;
    }
  }
  return path;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Checks an adapter's two translations against each other: every standard sample goes to the language and back and
 * must come out equal. Returns the failures (empty when the translation is lossless for the samples). For an adapter's
 * own tests; a translation that drops data into `ext` round-trips, one that drops it silently does not.
 */
export function roundTrip<N, L>(samples: N[], toLanguage: (native: N) => L, toStandard: (language: L) => N, opts: RoundTripOptions<N> = {}): string[] {
  const out: string[] = [];
  samples.forEach((sample, i) => {
    const label = `sample[${i}]`;
    let language: L;
    try { language = toLanguage(sample); } catch (err) { out.push(`${label}: toLanguage threw ${message(err)}`); return; }
    if (opts.shape) for (const p of shapeProblems(opts.shape, language)) out.push(`${label}: ${opts.shape} ${p}`);
    let back: N;
    try { back = toStandard(language); } catch (err) { out.push(`${label}: toStandard threw ${message(err)}`); return; }
    if (opts.equal) {
      if (!opts.equal(sample, back)) out.push(`${label}: standard -> language -> standard is not equal`);
    } else {
      const at = firstDifference(sample, back);
      if (at) out.push(`${label}: standard -> language -> standard changed ${at}`);
    }
  });
  return out;
}
