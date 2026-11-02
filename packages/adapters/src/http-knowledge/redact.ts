const REDACTED = '[redacted]';

/**
 * Every form a secret may take when a server echoes it: raw, JSON-escaped, URL-encoded; longest first. Values shorter
 * than `minChars` (option `minSecretChars`, default 4) are not worth masking and would mangle ordinary text.
 */
export function secretForms(values: Iterable<string>, minChars = 4): string[] {
  const forms = new Set<string>();
  for (const v of values) {
    if (v.length < minChars) continue;
    forms.add(v);
    forms.add(JSON.stringify(v).slice(1, -1));
    forms.add(encodeURIComponent(v));
  }
  return [...forms].filter((f) => f.length >= minChars).sort((a, b) => b.length - a.length);
}

export const redact = (text: string, forms: readonly string[]): string => forms.reduce((t, f) => t.split(f).join(REDACTED), text);

/** Values of every header, plus the credential part of an Authorization value ("Bearer abc" also yields "abc"). */
export function headerSecrets(headers: Record<string, string>): string[] {
  return Object.entries(headers).flatMap(([k, v]) => (k.toLowerCase() === 'authorization' ? [v, v.replace(/^\s*\w+\s+/, '').trim()] : [v]));
}
