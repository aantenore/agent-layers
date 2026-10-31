import type { LayerAttributes, Span, TelemetryPort } from '../ports/telemetry.ts';

/** Wraps an async iterable in a span that ends when iteration ends (normally, by error, or early return). */
export async function* spanStream<T>(
  telemetry: TelemetryPort, name: string, attrs: LayerAttributes, source: () => AsyncIterable<T>, onEnd?: (span: Span) => void,
): AsyncGenerator<T> {
  let span: Span | undefined;
  let settle!: (err?: unknown) => void;
  let ready!: () => void;
  const done = new Promise<void>((resolve, reject) => { settle = (err) => (err === undefined ? resolve() : reject(err)); });
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const ended = telemetry.span(name, attrs, async (s) => { span = s; ready(); await done; });
  ended.catch(() => {});
  await Promise.race([started, ended]);
  try {
    for await (const item of source()) yield item;
    if (span) onEnd?.(span);
    settle();
  } catch (err) {
    settle(err);
    throw err;
  } finally {
    settle();
    await ended.catch(() => {});
  }
}
