import { RsyslogHashTable } from './HashTable';
import { RS_RET } from './Log';
import type { RsyslogFiles } from './Host';
import type { RuntimeLog } from './Modules';
import type { Statistics, StatsObject } from './Statistics';

const DYN_INC_OK = 0;

const HASHTABLE_OVERPROVISIONING = 1.25;

export const DEFAULT_MAX_CARDINALITY = 2000;
export const DEFAULT_UNUSED_METRIC_LIFE_SECONDS = 3600;

export interface DynStatsOptions {
  readonly name: string;
  readonly resettable: boolean;
  readonly maxCardinality: number;
  readonly unusedMetricLifeSeconds: number;
  readonly persistUpdates?: number;
  readonly persistSeconds?: number;
  readonly stateDirectory?: string | null;
}

export interface DynStatsServices {
  readonly nowMs: () => number;
  readonly runtime: () => RuntimeLog;
  readonly files: RsyslogFiles;
  readonly workDirectory: () => string | null;
}

const STATE_FILE_PREFIX = 'dynstats-state:';
const OPEN_STATE_FILE_FAILED = 'dynstats: openStateFile failed - there should be messages before this one with the reason.\n';

function plainJson(value: unknown): string {
  return JSON.stringify(value).replace(/\//g, '\\/');
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
  private table: RsyslogHashTable<MetricCounter>;
  private survivors = new Map<string, MetricCounter>();
  private metricCount = 0;
  private cleanupAtMs = 0;
  private readonly counters: BucketCounters = { opsOverflow: 0, newMetricAdd: 0, noMetric: 0, metricsPurged: 0, opsIgnored: 0, purgeTriggered: 0 };
  private readonly object: StatsObject;
  private updates = 0;
  private persistExpirationSeconds = 0;

  constructor(
    readonly options: DynStatsOptions, private readonly statistics: Statistics, globalObject: StatsObject, private readonly services: DynStatsServices,
  ) {
    this.table = this.newTable();
    this.object = statistics.create(options.name, {
      origin: 'dynstats.bucket', reportingNamespace: 'values', readNotifier: () => this.resetIfExpired(),
    });
    this.reset();
    this.counters.purgeTriggered = 0;
    for (const [suffix, key] of GLOBAL_COUNTER_SUFFIXES) {
      globalObject.addCounter({ name: `${options.name}.${suffix}`, read: () => this.counters[key], reset: () => { this.counters[key] = 0; } });
    }
    if (this.persistsState) {
      if (this.loadState() !== DYN_INC_OK) this.services.runtime().info(OPEN_STATE_FILE_FAILED, RS_RET.ERR);
      if (this.persistSeconds > 0) this.persistExpirationSeconds = this.nowSeconds() + this.persistSeconds;
    }
  }

  private get persistUpdates(): number {
    return this.options.persistUpdates ?? 0;
  }

  private get persistSeconds(): number {
    return this.options.persistSeconds ?? 0;
  }

  get persistsState(): boolean {
    return this.persistUpdates > 0 || this.persistSeconds > 0;
  }

  private nowSeconds(): number {
    return Math.floor(this.services.nowMs() / 1000);
  }

  private stateFilePath(): string {
    const name = this.options.name;
    let fileName = `${STATE_FILE_PREFIX}${name}`;
    if (name.includes('/')) {
      const sanitized = name.replace(/\//g, '_');
      fileName = `${STATE_FILE_PREFIX}${sanitized}`;
      this.services.runtime().warning(`dynstats: bucket name '${name}' contains slashes, sanitized to '${sanitized}' for state file`, DYN_INC_OK);
    }
    return `${this.options.stateDirectory ?? this.services.workDirectory() ?? '.'}/${fileName}`;
  }

  private loadState(): number {
    const runtime = this.services.runtime();
    const path = this.stateFilePath();
    const content = this.services.files.read(path);
    if (content === null) {
      runtime.info(`dyn_stats: warning state file doesn't exist: '${path}'`, RS_RET.FILE_NOT_FOUND);
      return RS_RET.FILE_NOT_FOUND;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      runtime.info(`dyn_stats: error couldn't read json from file: '${path}'`, RS_RET.JSON_UNUSABLE);
      return RS_RET.JSON_UNUSABLE;
    }
    const values = (parsed as { values?: unknown }).values;
    if (typeof values !== 'object' || values === null) return DYN_INC_OK;
    for (const [metric, value] of Object.entries(values)) {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        runtime.error(`dynstats: state file '${path}' contains non-integer value for metric '${metric}'`, RS_RET.JSON_UNUSABLE);
        continue;
      }
      if (value < 0) {
        runtime.error(`dynstats: state file '${path}' contains negative value ${value} for metric '${metric}' - ignoring`, RS_RET.JSON_UNUSABLE);
        continue;
      }
      const code = this.addMetric(metric, value, 0);
      if (code !== DYN_INC_OK) runtime.error(`dynstats: failed to add metric '${metric}' from state file`, code);
    }
    return DYN_INC_OK;
  }

  persistState(synchronous: boolean): void {
    const path = this.stateFilePath();
    const members = this.table.values().map((counter) => `${plainJson(counter.metric)}:${counter.value}`);
    const runtime = this.services.runtime();
    const files = this.services.files;
    const temporary = `${path}.tmp`;
    if (!files.write(temporary, `{"name":${plainJson(this.options.name)},"values":{${members.join(',')}}}`)) {
      runtime.error(`dynstats: cannot open state file '${temporary}' for persisting file state - some data will probably be duplicated on next startup`, RS_RET.IO_ERROR);
      if (synchronous) runtime.error(`dynstats: could not persist state file ${path} - data may be repeated on next startup. Is WorkDirectory set?`, RS_RET.IO_ERROR);
      return;
    }
    if (files.rename(temporary, path)) return;
    runtime.error(`dynstats: rename failed from '${temporary}' to '${path}'`, RS_RET.IO_ERROR);
    files.remove(temporary);
    if (synchronous) runtime.error(`dynstats: could not persist state file ${path} - data may be repeated on next startup. Is WorkDirectory set?`, RS_RET.IO_ERROR);
  }

  persistOnStop(): void {
    if (this.persistsState || this.persistExpirationSeconds !== 0) this.persistState(true);
  }

  private persistIfDue(): void {
    if (!this.persistsState) return;
    const now = this.nowSeconds();
    let due = false;
    if (this.persistUpdates > 0) {
      this.updates++;
      due = this.updates >= this.persistUpdates;
    }
    if (!due && this.persistExpirationSeconds !== 0 && now >= this.persistExpirationSeconds) due = true;
    if (!due) return;
    this.persistState(false);
    if (this.persistUpdates > 0) this.updates -= this.persistUpdates;
    if (this.persistSeconds > 0) this.persistExpirationSeconds = now + this.persistSeconds;
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
    const existing = this.table.search(metric);
    if (existing !== undefined) existing.value++;
    else {
      const code = this.addMetric(metric, 0, 1);
      if (code !== DYN_INC_OK) return code;
    }
    this.persistIfDue();
    return DYN_INC_OK;
  }

  private addMetric(metric: string, offset: number, increment: number): number {
    if (this.metricCount >= this.options.maxCardinality) {
      this.counters.opsOverflow++;
      return RS_RET.OUT_OF_MEMORY;
    }
    const survivor = this.survivors.get(metric);
    const counter: MetricCounter = survivor ?? { metric, value: 0 };
    if (survivor !== undefined) this.survivors.delete(metric);
    this.table.insert(metric, counter);
    this.object.addCounter({ name: metric, read: () => counter.value, reset: () => { counter.value = 0; }, mustReset: this.options.resettable });
    counter.value += increment + offset;
    if (survivor === undefined) {
      this.metricCount++;
      this.counters.newMetricAdd++;
    }
    return DYN_INC_OK;
  }

  private newTable(): RsyslogHashTable<MetricCounter> {
    return new RsyslogHashTable(Math.floor(HASHTABLE_OVERPROVISIONING * this.options.maxCardinality + 1));
  }

  private reset(): void {
    this.object.clearCounters();
    this.counters.metricsPurged += this.survivors.size;
    this.metricCount -= this.survivors.size;
    this.survivors = new Map(this.table.entries());
    this.table = this.newTable();
    this.counters.purgeTriggered++;
    this.cleanupAtMs = this.services.nowMs() + this.options.unusedMetricLifeSeconds * 1000;
  }

  private resetIfExpired(): void {
    if (this.services.nowMs() < this.cleanupAtMs) return;
    this.services.runtime().info(`dynstats: bucket '${this.options.name}' is being reset`, RS_RET.TIMED_OUT);
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
    if (this.find(options.name) !== undefined) {
      this.services.runtime().warning(`dynstats: duplicate bucket name '${options.name}' in current config set; impstats output may be ambiguous`, DYN_INC_OK);
    }
    const bucket = new DynStatsBucket(options, this.statistics, this.globalObject, this.services);
    this.buckets.unshift(bucket);
    return bucket;
  }

  find(name: string): DynStatsBucket | undefined {
    return this.buckets.find((bucket) => bucket.name === name);
  }

  persistAll(): void {
    for (const bucket of this.buckets) bucket.persistOnStop();
  }
}
