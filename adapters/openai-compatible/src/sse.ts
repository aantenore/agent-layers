/**
 * Yields the `data:` payload of each Server-Sent Event in a response body.
 * Buffers partial reads, ignores comments, blank keep-alives and other fields, and stops at `[DONE]`.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];

  /** Feeds one line; returns a payload when the line closes an event. */
  const line = (raw: string): string | undefined => {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (l === '') {
      const payload = data.join('\n');
      const had = data.length > 0;
      data = [];
      return had ? payload : undefined;
    }
    if (l.startsWith(':')) return undefined;
    const sep = l.indexOf(':');
    const field = sep < 0 ? l : l.slice(0, sep);
    if (field !== 'data') return undefined;
    const value = sep < 0 ? '' : l.slice(sep + 1);
    data.push(value.startsWith(' ') ? value.slice(1) : value);
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
      if (done) break;
    }
    if (buffer) line(buffer);
    const last = line('');
    if (last !== undefined && last !== '[DONE]') yield last;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
