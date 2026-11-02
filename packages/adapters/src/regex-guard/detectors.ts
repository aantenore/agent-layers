import { iban97, luhn } from './checks.ts';

export type DetectorName = 'email' | 'phone' | 'iban' | 'card' | 'apiKey' | 'injection';
export const DETECTOR_NAMES: readonly DetectorName[] = ['email', 'phone', 'iban', 'card', 'apiKey', 'injection'];

/** Replacement tag per PII detector. */
export const TAGS: Record<Exclude<DetectorName, 'injection'>, string> = {
  email: '[EMAIL]', phone: '[PHONE]', iban: '[IBAN]', card: '[CARD]', apiKey: '[SECRET]',
};

export interface Span { start: number; end: number }

/** Finds the spans of one kind of sensitive text. */
export type Finder = (text: string) => Span[];

const digitsOf = (s: string) => s.replace(/\D/g, '');

/** Spans of every regex match that passes `accept`; `group` narrows the span to a capture group. */
export function byPattern(re: RegExp, accept: (m: string) => boolean = () => true, group = 0): Finder {
  const global = new RegExp(re.source, re.flags.replace(/[gd]/g, '') + 'gd');
  return (text) => {
    const spans: Span[] = [];
    for (const m of text.matchAll(global)) {
      const range = (m as RegExpMatchArray & { indices: ([number, number] | undefined)[] }).indices[group];
      if (range && m[group] !== undefined && accept(m[group])) spans.push({ start: range[0], end: range[1] });
    }
    return spans;
  };
}

const email = byPattern(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/);

/** Digit runs of 8..15 that are written as a phone number: `+CC ...` or three separated groups. */
const phoneInternational = byPattern(
  /(?<![\w+])\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}(?:[\s.-]?\d{2,4}){1,4}(?!\d)/,
  (m) => { const n = digitsOf(m).length; return n >= 8 && n <= 15; },
);
const phoneGrouped = byPattern(
  /(?<![\w+]|\d[\s.-])\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}(?!\w|[\s.-]\d)/,
  (m) => {
    const n = digitsOf(m).length;
    if (n < 8 || n > 15) return false;
    // "10 000 000" is a formatted integer, not a phone number.
    return !/^\d{1,3}( \d{3})+$/.test(m);
  },
);
const phone: Finder = (text) => [...phoneInternational(text), ...phoneGrouped(text)];

const cardRun = byPattern(/(?<![\d-])\d(?:[ -]?\d){12,18}(?!\d)/, (m) => {
  const d = digitsOf(m);
  return d.length >= 13 && d.length <= 19 && luhn(d);
});

/** IBAN candidates are validated from the longest reading down, so trailing capitals do not hide a valid one. */
const ibanCandidate = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}/g;
const iban: Finder = (text) => {
  const spans: Span[] = [];
  for (const m of text.matchAll(ibanCandidate)) {
    const ends: number[] = [];
    for (let i = 0; i < m[0].length; i++) if (m[0][i] !== ' ') ends.push(i + 1);
    for (let n = Math.min(ends.length, 34); n >= 15; n--) {
      const end = ends[n - 1]!;
      const next = m[0][end];
      if (next !== undefined && next !== ' ') continue;
      if (iban97(m[0].slice(0, end).replace(/ /g, ''))) { spans.push({ start: m.index!, end: m.index! + end }); break; }
    }
  }
  return spans;
};

const secretPatterns: Finder[] = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /\b(?:ghp|gho)_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /AIza[0-9A-Za-z_-]{35}/,
].map((re) => byPattern(re));

const bearer = byPattern(/\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/i, () => true, 1);
const assigned = byPattern(/(?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["']?([^\s"',;]{8,})/i, () => true, 1);
const apiKey: Finder = (text) => [...secretPatterns.flatMap((f) => f(text)), ...bearer(text), ...assigned(text)];

const injection = byPattern(new RegExp([
  String.raw`\bignore\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules|messages)`,
  String.raw`\bdisregard\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:(?:previous|prior|above|earlier)\s+)?(?:instructions?|prompts?|rules|guidelines)`,
  String.raw`\byou\s+are\s+now\s+(?:an?|the|in|free|no\s+longer|dan|unrestricted|unfiltered|jailbroken)\b`,
  String.raw`\b(?:reveal|show|print|repeat|leak)\s+(?:me\s+)?(?:your|the)\s+(?:system|initial|hidden)\s+(?:prompt|instructions?)`,
  String.raw`\bdeveloper\s+mode\b`,
].join('|'), 'i'));

export const FINDERS: Record<DetectorName, Finder> = { email, phone, iban, card: cardRun, apiKey, injection };
