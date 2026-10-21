import { RS_RET } from './Log';
import type { Statistics, StatsObject } from './Statistics';

const DYN_INC_OK = 0;

export const DEFAULT_MAX_CARDINALITY = 2000;
export const DEFAULT_UNUSED_METRIC_LIFE_SECONDS = 3600;

export interface DynStatsOptions {
  readonly name: string;
  readonly resettable: boolean;
  readonly maxCardinality: number;
  readonly unusedMetricLifeSeconds: number;
}

export interface DynStatsServices {
  readonly nowMs: () => number;
  readonly info: (text: string, code: number) => void;
}

interface MetricCounter {
  readonly metric: string;
  value: number;
}

interface BucketCounters {
  opsOverflow: number;
  newMetricAdd: number;
  noMetric: number;
  metricsPurged: number;
  opsIgnored: number;
  purgeTriggered: number;
}

const GLOBAL_COUNTER_SUFFIXES: ReadonlyArray<readonly [string, keyof BucketCounters]> = [
  ['ops_overflow', 'opsOverflow'], ['new_metric_add', 'newMetricAdd'], ['no_metric', 'noMetric'],
  ['metrics_purged', 'metricsPurged'], ['ops_ignored', 'opsIgnored'], ['purge_triggered', 'purgeTriggered'],
];

export class DynStatsBucket {
  private table = new Map<string, MetricCounter>();
  private survivors = new Map<string, MetricCounter>();
  private metricCount = 0;
  private cleanupAtMs = 0;
  private readonly counters: BucketCounters = { opsOverflow: 0, newMetricAdd: 0, noMetric: 0, metricsPurged: 0, opsIgnored: 0, purgeTriggered: 0 };
  private readonly object: StatsObject;

  constructor(
    readonly options: DynStatsOptions, private readonly statistics: Statistics, globalObject: StatsObject, private readonly services: DynStatsServices,
  ) {
    this.object = statistics.create(options.name, {
      origin: 'dynstats.bucket', reportingNamespace: 'values', readNotifier: () => this.resetIfExpired(),
    });
    this.reset();
    this.counters.purgeTriggered = 0;
    for (const [suffix, key] of GLOBAL_COUNTER_SUFFIXES) {
      globalObject.addCounter({ name: `${options.name}.${suffix}`, read: () => this.counters[key], reset: () => { this.counters[key] = 0; } });
    }
  }

  get name(): string {
    return this.options.name;
  }

  inc(metric: string): number {
    if (!this.statistics.enabled) return DYN_INC_OK;
    if (metric.length === 0) {
      this.counters.noMetric++;
      return DYN_INC_OK;
    }
    const existing = this.table.get(metric);
    if (existing !== undefined) {
      existing.value++;
      return DYN_INC_OK;
    }
    return this.addMetric(metric);
  }

  private addMetric(metric: string): number {
    if (this.metricCount >= this.options.maxCardinality) {
      this.counters.opsOverflow++;
      return RS_RET.OUT_OF_MEMORY;
    }
    const survivor = this.survivors.get(metric);
    const counter: MetricCounter = survivor ?? { metric, value: 0 };
    if (survivor !== undefined) this.survivors.delete(metric);
    this.table.set(metric, counter);
    this.object.addCounter({ name: metric, read: () => counter.value, reset: () => { counter.value = 0; }, mustReset: this.options.resettable });
    counter.value++;
    if (survivor === undefined) {
      this.metricCount++;
      this.counters.newMetricAdd++;
    }
    return DYN_INC_OK;
  }

  private reset(): void {
    this.object.clearCounters();
    this.counters.metricsPurged += this.survivors.size;
    this.metricCount -= this.survivors.size;
    this.survivors = this.table;
    this.table = new Map();
    this.counters.purgeTriggered++;
    this.cleanupAtMs = this.services.nowMs() + this.options.unusedMetricLifeSeconds * 1000;
  }

  private resetIfExpired(): void {
    if (this.services.nowMs() < this.cleanupAtMs) return;
    this.services.info(`dynstats: bucket '${this.options.name}' is being reset`, RS_RET.TIMED_OUT);
    this.reset();
  }
}

export class DynStatsRegistry {
  private readonly buckets: DynStatsBucket[] = [];
  private readonly globalObject: StatsObject;

  constructor(private readonly statistics: Statistics, private readonly services: DynStatsServices) {
    this.globalObject = statistics.create('global', { origin: 'dynstats', reportingNamespace: 'values' });
  }

  create(options: DynStatsOptions): DynStatsBucket {
    const bucket = new DynStatsBucket(options, this.statistics, this.globalObject, this.services);
    this.buckets.unshift(bucket);
    return bucket;
  }

  find(name: string): DynStatsBucket | undefined {
    return this.buckets.find((bucket) => bucket.name === name);
  }
}
