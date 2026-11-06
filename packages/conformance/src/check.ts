import { CHECK_LIMITS, extWriteProblems, limitValue, type CallContext } from '@agent-layers/core';

/** Time limits of the probes (`limits.check` in the stack config). */
export interface CheckLimits {
  /** Time limit of one probe (default 30000 ms). */
  timeoutMs?: number;
  /** Time limit of one model or runtime probe, which waits for a model to answer (default 120000 ms). */
  modelTimeoutMs?: number;
  /** Time limit of the deploy probes, which start and stop services (default 300000 ms). */
  deployTimeoutMs?: number;
}

/** The setting a model or runtime probe that times out tells the operator to raise. */
export const MODEL_TIMEOUT_LIMIT = CHECK_LIMITS.modelTimeoutMs.path;
/** The setting a deploy probe that times out tells the operator to raise. */
export const DEPLOY_TIMEOUT_LIMIT = CHECK_LIMITS.deployTimeoutMs.path;

/**
 * What the adapter under test declared about `ext` (its descriptor's name and `ext` block). Without a declaration only
 * the namespace rules apply: keys are namespaced and none is in the core's `sdk` namespace.
 */
export interface ExtDeclarationCheck {
  adapter: string;
  /** Defaults to the adapter name. */
  namespace?: string;
  /** The keys the adapter may write; when set, any other key fails. */
  produces?: readonly string[];
}

/** Collects failures; every check is framework-free. */
export class Checks {
  readonly failures: string[] = [];
  readonly skipped: string[] = [];
  /** Probes that called the instance expecting an answer (`attempt`); a suite that ran none did not exercise it. */
  attempts = 0;
  readonly timeoutMs: number;
  readonly modelTimeoutMs: number;
  readonly deployTimeoutMs: number;
  readonly ext?: ExtDeclarationCheck;

  constructor(limits: CheckLimits = {}, ext?: ExtDeclarationCheck) {
    this.ext = ext;
    this.timeoutMs = limitValue(CHECK_LIMITS.timeoutMs, limits.timeoutMs);
    this.modelTimeoutMs = limitValue(CHECK_LIMITS.modelTimeoutMs, limits.modelTimeoutMs);
    this.deployTimeoutMs = limitValue(CHECK_LIMITS.deployTimeoutMs, limits.deployTimeoutMs);
  }

  /** Records a value the adapter produced: the `ext` keys inside it must follow the adapter's declaration. */
  produced(label: string, value: unknown): void {
    for (const problem of extWriteProblems(value, this.ext)) {
      const message = `${label}: ${problem}`;
      if (!this.failures.includes(message)) this.failures.push(message);
    }
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

  /**
   * Runs `fn`; a throw becomes a failure and resolves to undefined. The signal aborts when `timeoutMs` elapses, and
   * once the probe is over, so a probe that honours it stops instead of running on under the next one. `limit` is the
   * setting the timeout message tells the operator to raise.
   */
  async attempt<T>(label: string, fn: (signal: AbortSignal) => Promise<T> | T, timeoutMs = this.timeoutMs, limit = CHECK_LIMITS.timeoutMs.path): Promise<T | undefined> {
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    this.attempts++;
    try {
      return await Promise.race([
        Promise.resolve().then(() => fn(ac.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const err = new DOMException(`timed out after ${timeoutMs} ms (raise ${limit})`, 'TimeoutError');
            ac.abort(err);
            reject(err);
          }, timeoutMs);
        }),
      ]);
    } catch (err) {
      this.failures.push(`${label}: threw ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    } finally {
      clearTimeout(timer);
      if (!ac.signal.aborted) ac.abort();
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
