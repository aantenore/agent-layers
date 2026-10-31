const REDACTED = '[redacted]';

/**
 * Every form a secret may take when a server echoes it: raw, JSON-escaped, URL-encoded; longest first. Values shorter
 * than `minChars` (option `minSecretChars`) are not worth masking and would mangle ordinary text.
 */
export function secretForms(values: Iterable<string>, minChars: number): string[] {
  const forms = new Set<string>();
  for (const v of values) {
    if (v.length < minChars) continue;
    forms.add(v);
    forms.add(JSON.stringify(v).slice(1, -1));
    forms.add(encodeURIComponent(v));
  }
  return [...forms].filter((f) => f.length >= minChars).sort((x, y) => y.length - x.length);
}

export const redact = (text: string, forms: readonly string[]): string => forms.reduce((t, f) => t.split(f).join(REDACTED), text);

/** Values of every static header, plus the credential part of an Authorization value ("Bearer abc" also yields "abc"). */
export function staticSecrets(headers: Record<string, string> | undefined): string[] {
  return Object.entries(headers ?? {}).flatMap(([k, v]) => (k.toLowerCase() === 'authorization' ? [v, v.replace(/^\s*\w+\s+/, '').trim()] : [v]));
}

/**
 * Redacts a structured value: serialize, redact, parse. When the redacted text no longer parses, the value is dropped
 * (`dropped: true`) rather than returned with a secret in it.
 */
export function redactStructured(value: unknown, forms: readonly string[]): { value?: unknown; dropped: boolean } {
  const text = JSON.stringify(value);
  const clean = redact(text, forms);
  if (clean === text) return { value, dropped: false };
  try { return { value: JSON.parse(clean), dropped: false }; } catch { return { dropped: true }; }
}

/** Masks secrets in an error's message and stack, keeping its class and properties. */
export function scrubError(err: unknown, forms: readonly string[]): unknown {
  if (!(err instanceof Error) || !forms.length) return err;
  err.message = redact(err.message, forms);
  if (err.stack) err.stack = redact(err.stack, forms);
  return err;
}
