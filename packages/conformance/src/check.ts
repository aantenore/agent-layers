import { CHECK_LIMITS, limitValue, type CallContext } from '@agent-layers/core';

/** Time limits of the probes (`limits.check` in the stack config). */
export interface CheckLimits {
  /** Time limit of one probe (default 30000 ms). */
  timeoutMs?: number;
  /** Time limit of the deploy probes, which start and stop services (default 300000 ms). */
  deployTimeoutMs?: number;
}

/** Collects failures; every check is framework-free. */
export class Checks {
  readonly failures: string[] = [];
  readonly skipped: string[] = [];
  readonly timeoutMs: number;
  readonly deployTimeoutMs: number;

  constructor(limits: CheckLimits = {}) {
    this.timeoutMs = limitValue(CHECK_LIMITS.timeoutMs, limits.timeoutMs);
    this.deployTimeoutMs = limitValue(CHECK_LIMITS.deployTimeoutMs, limits.deployTimeoutMs);
  }

  expect(ok: unknown, message: string): boolean {
    if (!ok) this.failures.push(message);
    return !!ok;
  }

  all(errors: string[], context: string): boolean {
    for (const e of errors) this.failures.push(`${context}: ${e}`);
    return errors.length === 0;
  }

  skip(message: string): void {
    this.skipped.push(message);
  }

  /** Runs `fn`; a throw becomes a failure and resolves to undefined. */
  async attempt<T>(label: string, fn: () => Promise<T> | T, timeoutMs = this.timeoutMs): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(fn),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs); }),
      ]);
    } catch (err) {
      this.failures.push(`${label}: threw ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs `fn` and expects it to reject. */
  async rejects(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
      this.failures.push(`${label}: expected a rejection`);
    } catch { /* expected */ }
  }
}

export const testContext = (over: Partial<CallContext> = {}): CallContext => ({ runId: 'conformance-run', agent: 'conformance', ...over });
