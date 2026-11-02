import { randomUUID } from 'node:crypto';
import { ATTR, defineAdapter, errorMessage, noopTelemetry, PORT_VERSIONS, type TelemetryPort, type Trigger, type TriggerHandle, type TriggerPort } from '@agent-layers/core';

/** One schedule: a fixed interval (`everyMs`) or a five-field cron expression (`cron`, UTC). */
export interface Schedule {
  /** Name of the schedule, in `Trigger.source` and `ext["cron-trigger.schedule"]`. */
  name: string;
  /** Interval between firings, in milliseconds (at least 1000); the first firing is one interval after start. */
  everyMs?: number;
  /** `minute hour day-of-month month day-of-week`, evaluated in UTC. */
  cron?: string;
  /** Agent to run, checked against the stack's agents at start; the host's first agent when omitted. */
  agent?: string;
  /** Run input (`Trigger.data`). */
  input?: string;
}

export interface CronTriggerOptions {
  schedules: Schedule[];
}

/** What a cron trigger uses besides its options; `create` fills them from the adapter context. */
export interface CronTriggerDeps {
  clock?: { now(): number };
  /** Where a failed run of a schedule is reported (event `cron-trigger.run.failed`). */
  telemetry?: TelemetryPort;
  /** The stack's agents: when given, `start` rejects a schedule naming another agent. */
  agents?: () => string[];
}

export const SCHEDULE_KEY = 'cron-trigger.schedule';
/** Telemetry event of a scheduled run that failed: schedule name in `agent.name`, message in `agent.error`. */
export const RUN_FAILED_EVENT = 'cron-trigger.run.failed';
/** Shortest interval of an `everyMs` schedule. */
export const MIN_EVERY_MS = 1000;
const KIND = 'schedule';
const MINUTE = 60_000;
/** A cron expression with no firing in this many days is rejected when the trigger starts (covers 29 February). */
const HORIZON_DAYS = 5 * 366;
/** Longest delay `setTimeout` accepts; a later firing is reached through several timers. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** A parsed cron expression: the allowed values of each field. */
export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Day of month and day of week both restricted: a day matches when either does (as in cron). */
  either: boolean;
}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
] as const;

function field(text: string, f: (typeof FIELDS)[number]): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron ${f.name}: "${part}" is not a value, range or step`);
    const from = m[1] === '*' ? f.min : Number(m[2]);
    const to = m[1] === '*' ? f.max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? f.max : from;
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (from < f.min || to > f.max || from > to || step < 1) throw new Error(`cron ${f.name}: "${part}" is outside ${f.min}-${f.max}`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/** Parses `minute hour day-of-month month day-of-week`: values, `*`, ranges `a-b`, steps `/n` and lists. 7 is Sunday too. */
export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== FIELDS.length) throw new Error(`cron expression needs ${FIELDS.length} fields, got ${parts.length}`);
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => field(p, FIELDS[i]!)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (weekdays.delete(7)) weekdays.add(0);
  // As in Vixie cron, a field starting with `*` (`*`, `*/2`) leaves the day unrestricted for the either-or rule.
  return { minutes, hours, days, months, weekdays, either: !parts[2]!.startsWith('*') && !parts[4]!.startsWith('*') };
}

/** The first time strictly after `from` (epoch ms) that matches `spec`, in UTC; undefined within the horizon. */
export function nextCron(spec: CronSpec, from: number): number | undefined {
  const start = Math.floor(from / MINUTE) * MINUTE + MINUTE;
  const first = new Date(start);
  for (let d = 0; d < HORIZON_DAYS; d++) {
    const day = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate() + d));
    if (!spec.months.has(day.getUTCMonth() + 1)) continue;
    const dom = spec.days.has(day.getUTCDate());
    const dow = spec.weekdays.has(day.getUTCDay());
    if (spec.either ? !(dom || dow) : !(dom && dow)) continue;
    for (const h of [...spec.hours].sort((a, b) => a - b)) {
      for (const m of [...spec.minutes].sort((a, b) => a - b)) {
        const t = day.getTime() + h * 60 * MINUTE + m * MINUTE;
        if (t >= start) return t;
      }
    }
  }
  return undefined;
}

/**
 * Starts runs on a schedule, in this process, with timers. A firing is skipped while the previous run of the same
 * schedule is still going; a failed run is reported through telemetry and the schedule carries on. Nothing is
 * persisted: firings due while the process is down are not made up, and every replica fires on its own. Only a process
 * that starts its triggers (`agent-layers dev`, `stack.start()`) runs the schedules: the gateway has nothing to mount.
 */
export function createCronTrigger(options: CronTriggerOptions, name = 'cron-trigger', deps: CronTriggerDeps = {}): TriggerPort {
  const clock = deps.clock ?? { now: () => Date.now() };
  const telemetry = deps.telemetry ?? noopTelemetry;
  const schedules = options.schedules.map((s) => {
    if ((s.everyMs === undefined) === (s.cron === undefined)) throw new Error(`schedule "${s.name}": set exactly one of everyMs and cron`);
    if (s.everyMs !== undefined && !(Number.isInteger(s.everyMs) && s.everyMs >= MIN_EVERY_MS)) throw new Error(`schedule "${s.name}": everyMs must be an integer of at least ${MIN_EVERY_MS}`);
    return { ...s, spec: s.cron !== undefined ? parseCron(s.cron) : undefined };
  });
  return {
    name,
    async start(handler) {
      const next = (s: (typeof schedules)[number], after: number): number | undefined => (s.spec ? nextCron(s.spec, after) : after + s.everyMs!);
      for (const s of schedules) if (next(s, clock.now()) === undefined) throw new Error(`schedule "${s.name}": the cron expression never fires`);
      const agents = deps.agents?.();
      for (const s of schedules) {
        if (agents && s.agent && !agents.includes(s.agent)) throw new Error(`schedule "${s.name}": unknown agent "${s.agent}" (known: ${agents.join(', ') || 'none'})`);
      }
      const failed = (s: (typeof schedules)[number], err: unknown) => telemetry.event(RUN_FAILED_EVENT, {
        [ATTR.layer]: 'interface', [ATTR.adapter]: name, [ATTR.name]: s.name, [ATTR.triggerKind]: KIND, [ATTR.error]: errorMessage(err),
      });
      const timers = new Set<ReturnType<typeof setTimeout>>();
      let closed = false;

      const arm = (s: (typeof schedules)[number], at: number, busy: { run?: Promise<void> }) => {
        if (closed) return;
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (closed) return;
          if (clock.now() < at) return arm(s, at, busy);
          if (!busy.run) {
            const trigger: Trigger = {
              id: randomUUID(), kind: KIND, source: `${name}/${s.name}`, at: new Date(at).toISOString(),
              ...(s.agent ? { agent: s.agent } : {}), ...(s.input !== undefined ? { data: s.input } : {}),
              ext: { [SCHEDULE_KEY]: s.name },
            };
            // A failed run is reported; the next firing goes ahead.
            busy.run = handler(trigger).catch((err: unknown) => failed(s, err)).finally(() => { busy.run = undefined; });
          }
          const following = next(s, Math.max(at, clock.now()));
          if (following !== undefined) arm(s, following, busy);
        }, Math.min(Math.max(0, at - clock.now()), MAX_TIMER_MS));
        timers.add(timer);
      };

      for (const s of schedules) arm(s, next(s, clock.now())!, {});
      return {
        async close() {
          closed = true;
          for (const t of timers) clearTimeout(t);
          timers.clear();
        },
      } satisfies TriggerHandle;
    },
  };
}

/** Descriptor: what the registry and the CLI see. */
export const adapter = defineAdapter<'TriggerPort', CronTriggerOptions>({
  layer: 'interface',
  port: 'TriggerPort',
  name: 'cron-trigger',
  direction: 'inbound',
  maps: { technology: 'in-process timers (interval or cron expression)' },
  portVersion: PORT_VERSIONS.TriggerPort,
  tiers: ['prototype'],
  description: 'Starts an agent run on a fixed interval or a cron schedule, with timers in the running process.',
  optionsSchema: {
    type: 'object',
    properties: {
      schedules: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            everyMs: { type: 'integer', minimum: MIN_EVERY_MS },
            cron: { type: 'string', minLength: 1 },
            agent: { type: 'string', minLength: 1 },
            input: { type: 'string' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    required: ['schedules'],
    additionalProperties: false,
  },
  ext: { produces: [SCHEDULE_KEY] },
  create: (options, ctx) => createCronTrigger(options, ctx.name, {
    telemetry: ctx.telemetry,
    // The stack is composed by the time a trigger starts.
    ...(ctx.stack ? { agents: () => ctx.stack!().agents() } : {}),
  }),
});

export const adapters = [adapter];
