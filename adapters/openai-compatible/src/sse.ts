/** A stream event (or a line still without its end) is longer than the configured cap. */
export class SseLimitError extends Error {
  override name = 'SseLimitError';
  constructor(maxChars: number) { super(`stream event longer than ${maxChars} characters (maxEventChars)`); }
}

/**
 * Yields the `data:` payload of each Server-Sent Event in a response body.
 * Buffers partial reads, ignores comments, blank keep-alives and other fields, and stops at `[DONE]`. A line still
 * waiting for its end, or the data of one event, longer than `maxChars` rejects with SseLimitError: a backend that never
 * ends a line or an event cannot grow the buffer without bound.
 */
export async function* sseData(body: ReadableStream<Uint8Array>, maxChars = Infinity): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let dataChars = 0;

  /** Feeds one line; returns a payload when the line closes an event. */
  const line = (raw: string): string | undefined => {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (l === '') {
      const payload = data.join('\n');
      const had = data.length > 0;
      data = [];
      dataChars = 0;
      return had ? payload : undefined;
    }
    if (l.startsWith(':')) return undefined;
    const sep = l.indexOf(':');
    const field = sep < 0 ? l : l.slice(0, sep);
    if (field !== 'data') return undefined;
    const value = sep < 0 ? '' : l.slice(sep + 1);
    const piece = value.startsWith(' ') ? value.slice(1) : value;
    dataChars += piece.length + (data.length ? 1 : 0);
    if (dataChars > maxChars) throw new SseLimitError(maxChars);
    data.push(piece);
    return undefined;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const payload = line(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (payload === '[DONE]') return;
        if (payload !== undefined) yield payload;
      }
      if (buffer.length > maxChars) throw new SseLimitError(maxChars);
      if (done) break;
    }
    if (buffer) line(buffer);
    const last = line('');
    if (last !== undefined && last !== '[DONE]') yield last;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
