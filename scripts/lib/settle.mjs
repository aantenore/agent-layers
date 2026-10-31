// Waiting for a count that grows in steps, such as the spans of a trace reaching a tracing backend. Zero dependencies.

/**
 * Reads a count until it reaches `expected`, stays the same for `quietMs`, or `deadlineMs` passes; returns the
 * largest count read. `quietMs` must be longer than the slowest gap between two steps (for exported spans: the
 * exporter's interval plus the collector's batch timeout), or a pause between steps reads as the end.
 */
export async function settledCount(read, { expected, quietMs, deadlineMs, pollMs = 500, sleep, now = Date.now }) {
  const until = now() + deadlineMs;
  let best = 0;
  let changedAt = now();
  for (;;) {
    let count = 0;
    try { count = await read(); } catch { /* not there yet */ }
    if (count >= expected) return count;
    if (count > best) { best = count; changedAt = now(); }
    if (best > 0 && now() - changedAt >= quietMs) return best;
    if (now() >= until) return best;
    await sleep(pollMs);
  }
}
