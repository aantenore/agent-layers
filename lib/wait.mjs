const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when the URL answers with any HTTP response within `timeoutMs`. */
export async function reachable(url, { timeoutMs = 2000 } = {}) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Polls `url` until `accept(response)` is true (default: any 2xx/3xx/4xx, i.e. the server is up and answering).
 * Rejects after `timeoutMs`.
 */
export async function waitFor(url, { timeoutMs = 60_000, intervalMs = 1000, accept = (res) => res.status < 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(intervalMs * 3, 5000)) });
      if (accept(res)) return res;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${url} (${last})`);
}
