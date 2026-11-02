import type { LimitsConfig, ModelPrice } from './config.ts';
import { BoundsExceeded } from './errors.ts';
import { limitValue } from './limits.ts';
import type { Bounds, CallContext, Delegation, Lineage } from './ports/base.ts';
import type { Caller } from './ports/identity.ts';
import type { Usage } from './ports/model.ts';
import type { StopReason } from './ports/runtime.ts';
import { DELEGATION_LIMITS, RUN_LIMITS } from './stack-limits.ts';

/** Largest delay a timer accepts; a deadline further away is checked but not armed as a timer. */
export const MAX_TIMER_MS = 2_147_483_647;

/** The stop reasons of the run bounds. `by` names the core check; consumers branch on `code` only. */
export const BOUNDS_STOP = Object.freeze({
  deadline: { code: 'timeout', layer: 'harness', by: 'sdk.deadline' },
  budget: { code: 'limit', layer: 'harness', by: 'sdk.budget' },
  hops: { code: 'hop_limit', layer: 'harness', by: 'sdk.hops' },
} satisfies Record<string, StopReason>);

/** The effective run limits of a stack (`limits.run`, `limits.delegation`); `Infinity` where unbounded. */
export interface RunLimits {
  timeoutMs: number;
  maxHops: number;
  maxTokens: number;
  maxCostUsd: number;
  marginMs: number;
  minRemainingMs: number;
  inbound: 'tighten' | 'ignore';
}

/** The run limits of a stack config, defaults applied. */
export function runLimits(limits: LimitsConfig = {}): RunLimits {
  return {
    timeoutMs: limitValue(RUN_LIMITS.timeoutMs, limits.run?.timeoutMs),
    maxHops: limitValue(RUN_LIMITS.maxHops, limits.run?.maxHops),
    maxTokens: limitValue(RUN_LIMITS.maxTokens, limits.run?.maxTokens),
    maxCostUsd: limitValue(RUN_LIMITS.maxCostUsd, limits.run?.maxCostUsd),
    marginMs: limitValue(DELEGATION_LIMITS.marginMs, limits.delegation?.marginMs),
    minRemainingMs: limitValue(DELEGATION_LIMITS.minRemainingMs, limits.delegation?.minRemainingMs),
    inbound: limits.delegation?.inbound ?? 'tighten',
  };
}

const finite = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
const optional = (n: number): number | undefined => (Number.isFinite(n) ? n : undefined);
/** A figure a ledger accepts: a finite number >= 0. Anything else is an unknown figure. */
const amount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const validUsage = (u: Usage | undefined): u is Usage => !!u && amount(u.inputTokens) && amount(u.outputTokens);

/** What a call to another agent took from the run: settled once with what the remote run reports. */
export interface Reservation {
  tokens?: number;
  costUsd?: number;
  /**
   * Debits what the remote run reports and releases the rest. A figure it does not report (or reports as anything but a
   * finite number >= 0) keeps its whole reservation spent, the safe side, and makes the run's figure unknown: a
   * reservation is never reported as a spend. Only the first call counts.
   */
  settle(report?: { usage?: Usage; costUsd?: number }): void;
}

/**
 * The ledger of one run: deadline, hop count, budget, what is spent and what calls in flight have reserved. Every copy
 * of the run's context points to the same ledger through `ctx.bounds`, a read view; a debit is one synchronous update,
 * so concurrent calls in one process cannot lose one.
 */
export class RunLedger {
  readonly view: Bounds;
  readonly runId: string;
  readonly hops: number;
  readonly maxHops: number;
  readonly lineage: Lineage | undefined;
  /** Epoch milliseconds; undefined when the run has no deadline. */
  readonly deadline: number | undefined;
  /** Remaining time when the run started; Infinity without a deadline. */
  readonly startMs: number;
  readonly tokenLimit: number;
  readonly costLimit: number;
  readonly marginMs: number;
  /** Least time a run or an outbound call starts with. */
  readonly minStartMs: number;
  spentTokens = 0;
  spentCost = 0;
  reservedTokens = 0;
  reservedCost = 0;
  /** Input and output tokens reported (model replies, settled delegated runs), for the run's result. */
  readonly usage: Usage = { inputTokens: 0, outputTokens: 0 };
  /** False once a spend had no valid token count (a reply without usage, a remote run that reported none). */
  usageKnown = true;
  /** False once a spend had no valid cost (a model without a price, a remote run that reported none): a partial sum would look like a real total. */
  costKnown = true;
  /** A model call without a price is refused (`limit`): the stack's own `limits.run.maxCostUsd` is set. */
  readonly priceRequired: boolean;
  /** The first stop the bounds caused, for the run's result. */
  stop: StopReason | undefined;

  constructor(init: {
    runId: string; hops: number; maxHops: number; lineage?: Lineage; remainingMs: number; tokens: number; costUsd: number;
    marginMs: number; minStartMs: number; now?: number; priceRequired?: boolean;
  }) {
    const now = init.now ?? Date.now();
    this.runId = init.runId;
    this.hops = init.hops;
    this.maxHops = init.maxHops;
    this.lineage = init.lineage;
    this.startMs = init.remainingMs;
    this.deadline = finite(init.remainingMs) ? now + init.remainingMs : undefined;
    this.tokenLimit = init.tokens;
    this.costLimit = init.costUsd;
    this.marginMs = init.marginMs;
    this.minStartMs = init.minStartMs;
    this.priceRequired = init.priceRequired ?? false;
    const ledger = this;
    this.view = Object.defineProperties({} as Bounds, {
      deadlineAt: { enumerable: ledger.deadline !== undefined, get: () => (ledger.deadline !== undefined ? new Date(ledger.deadline).toISOString() : undefined) },
      hops: { enumerable: true, get: () => ledger.hops },
      maxHops: { enumerable: true, get: () => ledger.maxHops },
      tokens: { enumerable: finite(ledger.tokenLimit), get: () => optional(Math.max(0, ledger.tokenLimit - ledger.spentTokens)) },
      costUsd: { enumerable: finite(ledger.costLimit), get: () => optional(Math.max(0, ledger.costLimit - ledger.spentCost)) },
      reserved: {
        enumerable: true,
        get: () => (ledger.reservedTokens || ledger.reservedCost
          ? { ...(ledger.reservedTokens ? { tokens: ledger.reservedTokens } : {}), ...(ledger.reservedCost ? { costUsd: ledger.reservedCost } : {}) }
          : undefined),
      },
    });
    LEDGERS.set(this.view, this);
  }

  /** Time left; Infinity without a deadline. */
  remainingMs(now = Date.now()): number {
    return this.deadline === undefined ? Infinity : this.deadline - now;
  }

  /** What is left after spending and reservations; Infinity without a budget. */
  available(): { tokens: number; costUsd: number } {
    return { tokens: this.tokenLimit - this.spentTokens - this.reservedTokens, costUsd: this.costLimit - this.spentCost - this.reservedCost };
  }

  /** The bound a new model call would break (deadline passed, budget spent), recorded as the run's stop; else undefined. */
  check(now = Date.now()): StopReason | undefined {
    let reason: StopReason | undefined;
    if (this.remainingMs(now) <= 0) reason = BOUNDS_STOP.deadline;
    else {
      const left = this.available();
      if (left.tokens <= 0 || left.costUsd <= 0) reason = BOUNDS_STOP.budget;
    }
    if (reason) this.stop ??= reason;
    return reason;
  }

  /** Debits a spend: tokens and cost, each only when it is a finite number >= 0; any other figure is unknown. */
  debit(usage: Usage | undefined, costUsd: number | undefined): void {
    if (validUsage(usage)) {
      this.usage.inputTokens += usage.inputTokens;
      this.usage.outputTokens += usage.outputTokens;
      this.spentTokens += usage.inputTokens + usage.outputTokens;
    } else this.usageKnown = false;
    if (amount(costUsd)) this.spentCost += costUsd;
    else this.costKnown = false;
  }

  /**
   * Reserves part of what is left for a call to another agent: everything not yet spent or reserved, or `share` (a
   * fraction) of it, as an orchestrator does for parallel branches. Throws `BoundsExceeded` when nothing is left.
   */
  reserve(share = 1): Reservation {
    const left = this.available();
    if (left.tokens <= 0 || left.costUsd <= 0) throw new BoundsExceeded(BOUNDS_STOP.budget);
    const part = Math.min(Math.max(share, 0), 1);
    const tokens = finite(left.tokens) ? Math.floor(left.tokens * part) : undefined;
    const costUsd = finite(left.costUsd) ? left.costUsd * part : undefined;
    this.reservedTokens += tokens ?? 0;
    this.reservedCost += costUsd ?? 0;
    let settled = false;
    return {
      ...(tokens !== undefined ? { tokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      settle: (report) => {
        if (settled) return;
        settled = true;
        this.reservedTokens -= tokens ?? 0;
        this.reservedCost -= costUsd ?? 0;
        const usage = report?.usage;
        if (validUsage(usage)) {
          this.usage.inputTokens += usage.inputTokens;
          this.usage.outputTokens += usage.outputTokens;
          this.spentTokens += usage.inputTokens + usage.outputTokens;
        } else {
          this.spentTokens += tokens ?? 0;
          this.usageKnown = false;
        }
        if (amount(report?.costUsd)) this.spentCost += report.costUsd;
        else {
          this.spentCost += costUsd ?? 0;
          this.costKnown = false;
        }
      },
    };
  }

}

const LEDGERS = new WeakMap<Bounds, RunLedger>();

/** The ledger behind a context's bounds; undefined outside a run or for bounds the core did not create. */
export const ledgerOf = (ctx: Pick<CallContext, 'bounds'> | undefined): RunLedger | undefined => (ctx?.bounds ? LEDGERS.get(ctx.bounds) : undefined);

/** Hops the verified caller stands for: its actor chain, plus one when the principal is an agent itself. */
export const verifiedHops = (caller: Caller | undefined): number => (caller?.actors?.length ?? 0) + (caller?.kind === 'agent' ? 1 : 0);

const nonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const RUN_ID = /^[\x21-\x7e]{1,128}$/;

/**
 * Problems of bounds a caller sent, as a channel received them; empty when they may be used. Channels validate before
 * passing them on, and reject a request whose bounds are malformed (fail closed).
 */
export function delegationProblems(d: unknown): string[] {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return ['must be an object'];
  const v = d as Record<string, unknown>;
  const out: string[] = [];
  if (!nonNegative(v.remainingMs) || !Number.isInteger(v.remainingMs)) out.push('remainingMs must be an integer >= 0');
  for (const k of ['hops', 'maxHops'] as const) if (!nonNegative(v[k]) || !Number.isInteger(v[k])) out.push(`${k} must be an integer >= 0`);
  for (const k of ['tokens', 'costUsd'] as const) if (v[k] !== undefined && !nonNegative(v[k])) out.push(`${k} must be a number >= 0`);
  for (const k of ['rootRunId', 'parentRunId'] as const) if (v[k] !== undefined && (typeof v[k] !== 'string' || !RUN_ID.test(v[k] as string))) out.push(`${k} must be 1 to 128 printable characters`);
  return out;
}

/** The tighter of two delegations a request carried (a protocol's own carrier and the host's), field by field. */
export function tighterDelegation(a: Delegation | undefined, b: Delegation | undefined): Delegation | undefined {
  if (!a || !b) return a ?? b;
  const min = (x: number | undefined, y: number | undefined) => (x === undefined ? y : y === undefined ? x : Math.min(x, y));
  const tokens = min(a.tokens, b.tokens);
  const costUsd = min(a.costUsd, b.costUsd);
  return {
    remainingMs: Math.min(a.remainingMs, b.remainingMs),
    hops: Math.max(a.hops, b.hops),
    maxHops: Math.min(a.maxHops, b.maxHops),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(a.rootRunId ?? b.rootRunId ? { rootRunId: (a.rootRunId ?? b.rootRunId)! } : {}),
    ...(a.parentRunId ?? b.parentRunId ? { parentRunId: (a.parentRunId ?? b.parentRunId)! } : {}),
  };
}

/** The run's ledger, or the stop that refuses the run before it starts. */
export type RunStart = { ledger: RunLedger; refused?: undefined } | { ledger: RunLedger; refused: StopReason };

/**
 * Bounds of a run starting now, from the stack's limits and what the caller sent (`ctx.delegation`, which can only
 * tighten them): deadline `now + min(timeoutMs, remainingMs)`, budget `min(maxTokens, tokens)` and
 * `min(maxCostUsd, costUsd)`, hops `max(sent hops, verified actor chain)`, max hops `min(maxHops, sent maxHops)`.
 * Refused (`hop_limit`) when hops exceed max hops, and (`timeout`) when less time is left than `minRemainingMs`.
 */
export function startRun(ctx: Pick<CallContext, 'runId' | 'caller' | 'delegation'>, limits: RunLimits, now = Date.now()): RunStart {
  const sent = limits.inbound === 'tighten' ? ctx.delegation : undefined;
  const remainingMs = Math.min(limits.timeoutMs, sent?.remainingMs ?? Infinity);
  const hops = Math.max(sent?.hops ?? 0, verifiedHops(ctx.caller));
  const maxHops = Math.min(limits.maxHops, sent?.maxHops ?? Infinity);
  // `ignore` drops everything the caller sent, its lineage included.
  const lineage = sent?.rootRunId && sent.parentRunId ? { rootRunId: sent.rootRunId, parentRunId: sent.parentRunId } : undefined;
  const minStartMs = Math.min(limits.minRemainingMs, limits.timeoutMs);
  const ledger = new RunLedger({
    runId: ctx.runId, hops, maxHops: Number.isFinite(maxHops) ? maxHops : Number.MAX_SAFE_INTEGER, remainingMs,
    tokens: Math.min(limits.maxTokens, sent?.tokens ?? Infinity), costUsd: Math.min(limits.maxCostUsd, sent?.costUsd ?? Infinity),
    marginMs: limits.marginMs, minStartMs, now, priceRequired: Number.isFinite(limits.maxCostUsd), ...(lineage ? { lineage } : {}),
  });
  if (hops > maxHops) return { ledger, refused: (ledger.stop = BOUNDS_STOP.hops) };
  if (remainingMs < minStartMs) return { ledger, refused: (ledger.stop = BOUNDS_STOP.deadline) };
  return { ledger };
}

/** The abort of a run at its deadline: `signal` aborts with a `TimeoutError`; `clear` disarms it once the run settles. */
export interface DeadlineTimer {
  signal: AbortSignal;
  clear(): void;
}

/**
 * The signal that aborts the run at its deadline (reason `TimeoutError`), merged by the host with the caller's. The
 * timer does not keep the process alive and is cleared when the run settles; undefined without a deadline, or with one
 * too far away for a timer.
 */
export function deadlineSignal(ledger: RunLedger, now = Date.now()): DeadlineTimer | undefined {
  const left = ledger.remainingMs(now);
  if (!Number.isFinite(left) || left > MAX_TIMER_MS) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The run reached its deadline', 'TimeoutError')), Math.max(0, left));
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** A model call refused by the run's bounds, or undefined; recorded as the run's stop. */
export function boundsStop(ctx: CallContext): StopReason | undefined {
  return ledgerOf(ctx)?.check();
}

/** The price of a model in the price table: an own entry only (never an inherited property such as `constructor`). */
export function priceFor(pricing: Readonly<Record<string, ModelPrice>> | undefined, model: string): ModelPrice | undefined {
  return pricing && Object.hasOwn(pricing, model) ? pricing[model] : undefined;
}

/**
 * Cost of a model reply from the price table, or undefined when the model has no price or the reply no valid usage.
 * Prices and token counts that are not finite numbers >= 0 count as 0, so a cost is never negative or NaN.
 */
export function priceOf(pricing: Readonly<Record<string, ModelPrice>> | undefined, model: string, requested: string, usage: Usage | undefined): number | undefined {
  const price = priceFor(pricing, model) ?? priceFor(pricing, requested);
  if (!price || !validUsage(usage)) return undefined;
  const n = (v: unknown) => (amount(v) ? v : 0);
  return (usage.inputTokens * n(price.inputPerMTok) + usage.outputTokens * n(price.outputPerMTok)) / 1e6;
}

/** What a call to another agent sends, and the reservation it settles when the call returns. */
export interface OutboundCall {
  bounds: Delegation;
  reservation: Reservation;
}

export interface OutboundOptions {
  /** Fraction of what is left to reserve for this call (default 1: everything not yet spent or reserved). */
  share?: number;
  /** Pass a budget on (default true). False sends time and hops only and reserves nothing. */
  budget?: boolean;
  /** Largest time the caller waits for this call (the adapter's own time limit): the sent time is never longer. */
  timeoutMs?: number;
  /**
   * Refuse the call locally when a bound is reached (default true). False for a carrier that may not reach an agent at
   * all (a tool protocol): the bounds are sent as they are, and an agent that receives them refuses on its side.
   */
  refuse?: boolean;
}

const NOTHING: Reservation = { settle() {} };

/**
 * What to send to the next agent: the time left (never more than `opts.timeoutMs`) minus
 * `limits.delegation.marginMs`, hops plus one, the run's max hops, a reservation of the budget, and the lineage.
 * Inside a run it reads the run's bounds; in a context with no run of its own but the bounds a caller sent
 * (`ctx.delegation`), it passes those on, so a chain keeps counting. Undefined when the context has neither. Throws
 * `BoundsExceeded` without any network call when the call would exceed the hop limit (`hop_limit`), would start with
 * less than `limits.delegation.minRemainingMs` (`timeout`), or no budget is left (`limit`). A retry of the same call
 * keeps the same reservation and sends what is left of the same deadline: it never gets a fresh allowance.
 */
export function outboundBounds(ctx: CallContext, opts: OutboundOptions = {}): OutboundCall | undefined {
  const now = Date.now();
  const sent = ctx.delegation;
  const b: Bounds | undefined = ctx.bounds ?? (sent ? {
    deadlineAt: new Date(now + sent.remainingMs).toISOString(), hops: sent.hops, maxHops: sent.maxHops,
    ...(sent.tokens !== undefined ? { tokens: sent.tokens } : {}), ...(sent.costUsd !== undefined ? { costUsd: sent.costUsd } : {}),
  } : undefined);
  if (!b) return undefined;
  const ledger = LEDGERS.get(b);
  const lineage = { rootRunId: ctx.lineage?.rootRunId ?? (ctx.bounds ? undefined : sent?.rootRunId) ?? ctx.runId, parentRunId: ctx.runId };
  // A refused outbound call is the adapter's result (an error result, a stopped run), not a stop of this run.
  const refuse = opts.refuse !== false;
  const fail = (reason: StopReason) => new BoundsExceeded(reason);
  if (refuse && b.hops + 1 > b.maxHops) throw fail(BOUNDS_STOP.hops);
  const deadline = b.deadlineAt ? Date.parse(b.deadlineAt) : undefined;
  const margin = ledger?.marginMs ?? 0;
  const left = deadline === undefined ? Infinity : deadline - now;
  // The margin comes off whatever bounds the call: the run's deadline or the adapter's own time limit.
  const remainingMs = Math.min(left, opts.timeoutMs ?? Infinity) - margin;
  if (refuse && deadline !== undefined && left - margin < (ledger?.minStartMs ?? 0)) throw fail(BOUNDS_STOP.deadline);
  const reservation = opts.budget === false ? NOTHING
    : ledger ? ledger.reserve(opts.share)
      : { ...(b.tokens !== undefined ? { tokens: b.tokens } : {}), ...(b.costUsd !== undefined ? { costUsd: b.costUsd } : {}), settle() {} };
  return {
    bounds: {
      remainingMs: Math.max(0, Math.floor(Math.min(remainingMs, MAX_TIMER_MS))),
      hops: b.hops + 1,
      maxHops: b.maxHops,
      ...(reservation.tokens !== undefined ? { tokens: reservation.tokens } : {}),
      ...(reservation.costUsd !== undefined ? { costUsd: reservation.costUsd } : {}),
      ...lineage,
    },
    reservation,
  };
}

/** Largest integer an RFC 9651 structured field carries (15 digits): larger values, unbounded max hops included, are capped to it. */
export const SF_MAX_INTEGER = 999_999_999_999_999;
/** Largest whole part of an RFC 9651 decimal (12 digits). */
const SF_MAX_DECIMAL = 999_999_999_999;

const sfInteger = (n: number) => String(Math.min(Math.max(0, Math.floor(n)), SF_MAX_INTEGER));
/** A cost as an RFC 9651 decimal: rounded down to 3 decimals (never more than was sent), whole part capped at 12 digits. */
const sfDecimal = (n: number) => {
  const thousandths = Math.floor(Math.min(Math.max(0, n), SF_MAX_DECIMAL) * 1000);
  const whole = Math.floor(thousandths / 1000);
  const fraction = thousandths % 1000;
  return fraction ? `${whole}.${String(fraction).padStart(3, '0').replace(/0+$/, '')}` : String(whole);
};
const sfString = (v: string) => `"${v.replace(/[\\"]/g, '\\$&')}"`;

/**
 * The `Agent-Bounds` header value of a delegation (`remaining-ms=45000, hops=2, max-hops=4, tokens=1000,
 * cost-usd=0.5`), as the gateway parses it: integers capped at 15 digits (an unbounded max hops is sent as the cap),
 * the cost rounded down to 3 decimals.
 */
export function formatAgentBounds(d: Delegation): string {
  return [
    `remaining-ms=${sfInteger(d.remainingMs)}`, `hops=${sfInteger(d.hops)}`, `max-hops=${sfInteger(d.maxHops)}`,
    ...(d.tokens !== undefined ? [`tokens=${sfInteger(d.tokens)}`] : []),
    ...(d.costUsd !== undefined ? [`cost-usd=${sfDecimal(d.costUsd)}`] : []),
  ].join(', ');
}

/** The `Agent-Lineage` header value of a delegation (`root="run-a1", parent="run-b7"`); undefined when it has no lineage. */
export function formatAgentLineage(d: Pick<Delegation, 'rootRunId' | 'parentRunId'>): string | undefined {
  const members = [
    ...(d.rootRunId !== undefined ? [`root=${sfString(d.rootRunId)}`] : []),
    ...(d.parentRunId !== undefined ? [`parent=${sfString(d.parentRunId)}`] : []),
  ];
  return members.length ? members.join(', ') : undefined;
}
