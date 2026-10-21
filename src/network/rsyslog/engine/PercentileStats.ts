import type { Statistics, StatsObject } from './Statistics';

export const CONF_PARAM_INVALID = -2425;
export const INTERNAL_ERROR = -2175;
const NAME_BUFFER = 128;
const OK = 0;

export interface PercentileStatsOptions {
  readonly name: string;
  readonly delimiter: string;
  readonly percentiles: readonly number[];
  readonly windowSize: number;
}

export interface PercentileStatsServices {
  readonly error: (text: string, code: number) => void;
}

const asUnsigned = (value: bigint): bigint => BigInt.asUintN(64, value);
const asCounter = (value: bigint): number => Number(BigInt.asIntN(64, value));

export class RingBuffer {
  readonly size: number;
  private readonly cells: BigInt64Array;
  private head = 0;
  private tail = 0;

  constructor(count: number) {
    this.size = 2 ** Math.ceil(Math.log2(count));
    this.cells = new BigInt64Array(this.size);
  }

  private count(): number {
    return (this.head - this.tail) & (this.size - 1);
  }

  appendWithOverwrite(item: bigint): void {
    if (((this.tail - (this.head + 1)) & (this.size - 1)) === 0) this.tail = (this.tail + 1) & (this.size - 1);
    this.cells[this.head] = item;
    this.head = (this.head + 1) & (this.size - 1);
  }

  private read(limit: number): bigint[] {
    if (this.count() === 0) return [];
    const toEnd = Math.min(this.size - this.tail, ((this.head + this.size - this.tail) & (this.size - 1)));
    const taken = Math.min(toEnd, limit);
    const out: bigint[] = [];
    for (let index = 0; index < taken; index++) out.push(this.cells[this.tail + index]);
    this.tail = (this.tail + taken) & (this.size - 1);
    return out;
  }

  readToEnd(limit: number): bigint[] {
    const first = this.read(limit);
    if (first.length === 0) return first;
    return first.concat(this.read(limit - first.length));
  }
}

interface PercentileCounter {
  readonly percentile: number;
  value: bigint;
}

interface ObservedStat {
  readonly ring: RingBuffer;
  readonly percentiles: PercentileCounter[];
  windowMin: bigint;
  windowMax: bigint;
  windowSum: bigint;
  windowCount: bigint;
  reported: boolean;
}

export class PercentileBucket {
  private readonly stats = new Map<string, ObservedStat>();
  private readonly object: StatsObject;
  private newKeyAdd = 0;
  private opsOverflow = 0;

  constructor(readonly options: PercentileStatsOptions, statistics: Statistics, globalObject: StatsObject, private readonly services: PercentileStatsServices, private readonly allBuckets: () => readonly PercentileBucket[]) {
    this.object = statistics.create(options.name, {
      origin: 'percentile.bucket', reportingNamespace: 'values', readNotifier: () => { for (const bucket of this.allBuckets()) bucket.reportAll(); },
    });
    globalObject.addCounter({ name: `${options.name}.new_metric_add`, read: () => this.newKeyAdd, reset: () => { this.newKeyAdd = 0; } });
    globalObject.addCounter({ name: `${options.name}.ops_overflow`, read: () => this.opsOverflow, reset: () => { this.opsOverflow = 0; } });
  }

  get name(): string {
    return this.options.name;
  }

  observe(key: string, value: bigint): number {
    let stat = this.stats.get(key);
    if (stat === undefined) {
      const created = this.createStat(key, value);
      if (typeof created === 'number') {
        this.services.error(`perctile_obs(): name: ${this.options.name}, key: ${key}, val: ${value}\n`, INTERNAL_ERROR);
        return created;
      }
      stat = created;
      this.stats.set(key, stat);
      this.newKeyAdd++;
    }
    stat.ring.appendWithOverwrite(value);
    if (stat.reported) {
      stat.windowCount = 0n;
      stat.windowSum = 0n;
      stat.windowMin = asUnsigned(value);
      stat.windowMax = asUnsigned(value);
      stat.reported = false;
    }
    const unsigned = asUnsigned(value);
    stat.windowCount++;
    stat.windowSum = asUnsigned(stat.windowSum + value);
    stat.windowMin = stat.windowMin < unsigned ? stat.windowMin : unsigned;
    stat.windowMax = stat.windowMax > unsigned ? stat.windowMax : unsigned;
    return OK;
  }

  private createStat(key: string, value: bigint): ObservedStat | number {
    const delimiter = this.options.delimiter;
    const truncated = (name: string): number => {
      this.services.error(`statname '${name}' truncated - too long for buffer size: ${NAME_BUFFER}\n`, OK);
      this.services.error('Could not initialize percentile stats.', CONF_PARAM_INVALID);
      return CONF_PARAM_INVALID;
    };
    if (key.length >= NAME_BUFFER) return truncated(key);
    const offset = key.length + delimiter.length;
    if (offset >= NAME_BUFFER) return truncated(`${key}${delimiter}`);
    const remaining = NAME_BUFFER - offset - 1;
    const suffixes = [...this.options.percentiles.map((percentile) => `p${percentile}`), 'window_min', 'window_max', 'window_sum', 'window_count'];
    for (const suffix of suffixes) if (suffix.length >= remaining) return truncated(`${key}${delimiter}${suffix}`);
    const stat: ObservedStat = {
      ring: new RingBuffer(this.options.windowSize),
      percentiles: this.options.percentiles.map((percentile) => ({ percentile, value: 0n })),
      windowMin: asUnsigned(value), windowMax: 0n, windowSum: 0n, windowCount: 0n, reported: false,
    };
    const prefix = `${key}${delimiter}`;
    for (const counter of stat.percentiles) this.object.addCounter({ name: `${prefix}p${counter.percentile}`, read: () => asCounter(counter.value) });
    this.object.addCounter({ name: `${prefix}window_min`, read: () => asCounter(stat.windowMin) });
    this.object.addCounter({ name: `${prefix}window_max`, read: () => asCounter(stat.windowMax) });
    this.object.addCounter({ name: `${prefix}window_sum`, read: () => asCounter(stat.windowSum) });
    this.object.addCounter({ name: `${prefix}window_count`, read: () => asCounter(stat.windowCount) });
    return stat;
  }

  reportAll(): void {
    for (const stat of this.stats.values()) {
      const observed = stat.ring.readToEnd(this.options.windowSize);
      if (observed.length === 0) continue;
      observed.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      for (const counter of stat.percentiles) {
        const index = Math.max(0, Math.trunc((counter.percentile / 100) * observed.length - 1));
        counter.value = asUnsigned(observed[index]);
      }
      stat.reported = true;
    }
  }
}

export class PercentileStatsRegistry {
  private buckets: PercentileBucket[] = [];
  private readonly globalObject: StatsObject;

  constructor(private readonly statistics: Statistics, private readonly services: PercentileStatsServices) {
    this.globalObject = statistics.create('global', { origin: 'percentile', reportingNamespace: 'values' });
  }

  create(options: PercentileStatsOptions): PercentileBucket {
    const bucket = new PercentileBucket(options, this.statistics, this.globalObject, this.services, () => this.buckets);
    this.buckets = [bucket, ...this.buckets];
    return bucket;
  }

  find(name: string): PercentileBucket | undefined {
    return this.buckets.find((bucket) => bucket.name === name);
  }
}

