import { METRIC, type Attributes } from '@agent-layers/core';
import { toAttributes, type KeyValue } from './otlp-json.ts';

// Bucket boundaries recommended by the OpenTelemetry GenAI semantic conventions.
const TOKEN_BOUNDS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864];
const DURATION_BOUNDS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92];

interface Known { unit: string; description: string; bounds?: number[] }

/** Metrics with a fixed meaning. Histograms have bounds; any other name is exported as a counter. */
const KNOWN: Readonly<Record<string, Known>> = {
  'gen_ai.client.token.usage': { unit: '{token}', description: 'Input and output tokens used per model call', bounds: TOKEN_BOUNDS },
  'gen_ai.client.operation.duration': { unit: 's', description: 'Duration of model calls', bounds: DURATION_BOUNDS },
  [METRIC.toolCalls]: { unit: '{call}', description: 'Tool calls by outcome' },
  [METRIC.accessDecisions]: { unit: '{decision}', description: 'Tool authorization decisions' },
  [METRIC.guardActions]: { unit: '{action}', description: 'Guard verdicts that were not allow' },
  'agent.runs': { unit: '{run}', description: 'Finished runs by status' },
};

/** AggregationTemporality CUMULATIVE: totals only grow, so a lost export is healed by the next one. */
const CUMULATIVE = 2;

interface Histogram { count: number; sum: number; min: number; max: number; buckets: number[] }
interface Series { attrs: Attributes; sum: number; histogram?: Histogram }
interface Instrument { name: string; unit: string; description: string; bounds?: number[]; monotonic: boolean; series: Map<string, Series> }

const seriesKey = (attrs: Attributes) => JSON.stringify(Object.entries(attrs).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Aggregates measurements into OTLP metrics (cumulative temporality). */
export class MetricsAggregator {
  #instruments = new Map<string, Instrument>();
  #dirty = false;
  readonly #startNanos: string;
  readonly #now: () => string;

  constructor(now: () => string) {
    this.#now = now;
    this.#startNanos = now();
  }

  get dirty(): boolean { return this.#dirty; }
  markDirty(): void { this.#dirty = true; }

  record(name: string, value: number, attrs: Attributes): void {
    if (!Number.isFinite(value)) return;
    let inst = this.#instruments.get(name);
    if (!inst) {
      const known = KNOWN[name];
      inst = { name, unit: known?.unit ?? '1', description: known?.description ?? name, ...(known?.bounds ? { bounds: known.bounds } : {}), monotonic: true, series: new Map() };
      this.#instruments.set(name, inst);
    }
    if (!inst.bounds && value < 0) inst.monotonic = false;
    const key = seriesKey(attrs);
    let s = inst.series.get(key);
    if (!s) {
      const clean = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined));
      s = { attrs: clean, sum: 0, ...(inst.bounds ? { histogram: { count: 0, sum: 0, min: Infinity, max: -Infinity, buckets: new Array<number>(inst.bounds.length + 1).fill(0) } } : {}) };
      inst.series.set(key, s);
    }
    const h = s.histogram;
    if (h && inst.bounds) {
      h.count++;
      h.sum += value;
      h.min = Math.min(h.min, value);
      h.max = Math.max(h.max, value);
      const i = inst.bounds.findIndex((b) => value <= b);
      h.buckets[i < 0 ? inst.bounds.length : i]!++;
    } else s.sum += value;
    this.#dirty = true;
  }

  /** The `metrics` array of an OTLP `ScopeMetrics`; marks everything as sent. */
  take(): object[] {
    this.#dirty = false;
    const now = this.#now();
    return [...this.#instruments.values()].filter((i) => i.series.size).map((inst) => {
      const points = [...inst.series.values()].map((s) => {
        const base: { attributes: KeyValue[]; startTimeUnixNano: string; timeUnixNano: string } = { attributes: toAttributes(s.attrs), startTimeUnixNano: this.#startNanos, timeUnixNano: now };
        return s.histogram
          ? { ...base, count: String(s.histogram.count), sum: s.histogram.sum, min: s.histogram.min, max: s.histogram.max, bucketCounts: s.histogram.buckets.map(String), explicitBounds: inst.bounds }
          : { ...base, asDouble: s.sum };
      });
      const head = { name: inst.name, description: inst.description, unit: inst.unit };
      return inst.bounds
        ? { ...head, histogram: { aggregationTemporality: CUMULATIVE, dataPoints: points } }
        : { ...head, sum: { aggregationTemporality: CUMULATIVE, isMonotonic: inst.monotonic, dataPoints: points } };
    });
  }
}
