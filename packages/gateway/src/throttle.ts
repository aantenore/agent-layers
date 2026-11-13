/** Most keys a counter remembers; past it the oldest are dropped, so a client cannot grow the table without bound. */
const MAX_KEYS = 100_000;

/**
 * Fixed-window counter per key (a subject or a client address): at most `limit` hits in each window of `windowMs`.
 * State lives in this process; several gateway instances each count on their own.
 */
export class FixedWindow {
  readonly #windows = new Map<string, { count: number; resetAt: number }>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #maxKeys: number;
  #sweepAt = 0;

  constructor(limit: number, windowMs: number, now: () => number = Date.now, maxKeys = MAX_KEYS) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
    this.#maxKeys = maxKeys;
  }

  /** Seconds until the key may try again when its window is used up; undefined while it has room. Counts nothing. */
  blocked(key: string): number | undefined {
    const w = this.#windows.get(key);
    const now = this.#now();
    if (!w || now >= w.resetAt || w.count < this.#limit) return undefined;
    return Math.max(1, Math.ceil((w.resetAt - now) / 1000));
  }

  /** Counts one hit. Returns the seconds to wait when the window is already used up (the hit is then not counted). */
  take(key: string): number | undefined {
    if (!Number.isFinite(this.#limit)) return undefined;
    const wait = this.blocked(key);
    if (wait !== undefined) return wait;
    const now = this.#now();
    const w = this.#windows.get(key);
    if (w && now < w.resetAt) { w.count++; return undefined; }
    if (now >= this.#sweepAt) {
      for (const [k, v] of this.#windows) if (now >= v.resetAt) this.#windows.delete(k);
      this.#sweepAt = now + this.#windowMs;
    }
    this.#windows.delete(key);
    while (this.#windows.size >= this.#maxKeys) this.#windows.delete(this.#windows.keys().next().value!);
    this.#windows.set(key, { count: 1, resetAt: now + this.#windowMs });
    return undefined;
  }

  get size(): number { return this.#windows.size; }
}

/** Counts work in flight, in total or per key; `enter` returns the release function, or undefined at the cap. */
export class Concurrency {
  readonly #held = new Map<string, number>();
  readonly #max: number;

  constructor(max: number) { this.#max = max; }

  enter(key = ''): (() => void) | undefined {
    const n = this.#held.get(key) ?? 0;
    if (n >= this.#max) return undefined;
    this.#held.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.#held.get(key) ?? 1) - 1;
      if (left > 0) this.#held.set(key, left); else this.#held.delete(key);
    };
  }
}

/**
 * The address a request is counted under: the socket's, or with `trustProxy` = n the n-th `X-Forwarded-For` entry from
 * the right (the one the n-th trusted proxy in front of the gateway appended). Fewer entries than n: the socket's.
 */
export function clientAddress(socketAddress: string | undefined, forwardedFor: string | string[] | undefined, trustProxy: number): string {
  const socket = socketAddress ?? 'unknown';
  if (!trustProxy) return socket;
  const hops = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  return hops[hops.length - trustProxy] ?? socket;
}
