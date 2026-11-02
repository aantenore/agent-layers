const STOPWORDS = new Set((
  'a an and are as at be but by for from has have how if in into is it its of on or that the their then there these ' +
  'they this to was were what when where which who why will with you your about can do does did not no so than'
).split(' '));

/** Lowercase unicode word tokens without stopwords. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOPWORDS.has(t));
}

const K1 = 1.2;
const B = 0.75;
/** Extra weight of a query term found in the heading, as a multiple of its idf. */
const HEADING_BOOST = 1;

export interface IndexedDoc { terms: Map<string, number>; length: number; headingTerms: Set<string> }

/** `heading` is the full path, which is searchable; only `name`, the innermost heading, earns the boost. */
export function indexDoc(heading: string, name: string, body: string): IndexedDoc {
  const tokens = tokenize(`${heading}\n${body}`);
  const terms = new Map<string, number>();
  for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1);
  return { terms, length: tokens.length, headingTerms: new Set(tokenize(name)) };
}

/** BM25 statistics over a corpus of chunks. */
export class Bm25 {
  readonly #docs: readonly IndexedDoc[];
  readonly #df = new Map<string, number>();
  readonly #avg: number;

  constructor(docs: readonly IndexedDoc[]) {
    this.#docs = docs;
    for (const d of docs) for (const t of d.terms.keys()) this.#df.set(t, (this.#df.get(t) ?? 0) + 1);
    this.#avg = docs.reduce((n, d) => n + d.length, 0) / (docs.length || 1) || 1;
  }

  #idf(term: string): number {
    const n = this.#df.get(term) ?? 0;
    return Math.log(1 + (this.#docs.length - n + 0.5) / (n + 0.5));
  }

  /** Score of document `i` for the query terms. */
  score(i: number, query: readonly string[]): number {
    const d = this.#docs[i]!;
    let s = 0;
    for (const t of query) {
      const f = d.terms.get(t) ?? 0;
      if (!f) continue;
      const idf = this.#idf(t);
      s += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / this.#avg)));
      if (d.headingTerms.has(t)) s += HEADING_BOOST * idf;
    }
    return s;
  }
}
