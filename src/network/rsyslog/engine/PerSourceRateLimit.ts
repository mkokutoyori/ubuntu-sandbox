import type { RsyslogMessage } from '../Message';
import type { Template } from '../Template';
import { RsyslogHashTable } from './HashTable';
import type { PerSourceOverride, PerSourcePolicy } from './RateLimitPolicy';
import type { Statistics, StatsObject } from './Statistics';

const SHARDS = 32;
export const DEFAULT_MAX_STATES = 10000;
export const DEFAULT_TOP_N = 10;
const SHARD_HASH_SIZE = 16;
const METRIC_NAME_LIMIT = 128;

export type KeyMode = 'fromhost-ip' | 'fromhost' | 'fromhost-port' | 'fromhost-ip-port' | 'fromhost-name-port' | 'template';

interface SourceEntry {
  readonly key: string;
  count: number;
  windowStart: number;
  allowed: number;
  dropped: number;
  lastSeen: number;
  stateActive: boolean;
  hasOverride: boolean;
  max: number;
  window: number;
  hasMax: boolean;
  hasWindow: boolean;
  lruPrevious: SourceEntry | null;
  lruNext: SourceEntry | null;
}

interface Shard {
  readonly table: RsyslogHashTable<SourceEntry>;
  lruHead: SourceEntry | null;
  lruTail: SourceEntry | null;
  active: number;
  maxStates: number;
}

export function keyModeOf(template: Template | null): KeyMode {
  if (template === null || template.kind !== 'entries' || template.entries.length === 0) return 'template';
  const ids = (index: number): string | null => {
    const entry = template.entries[index];
    return entry.kind === 'field' && !entry.complex ? entry.descriptor.id : null;
  };
  if (template.entries.length === 1) {
    const id = ids(0);
    return id === 'fromhost-ip' || id === 'fromhost' || id === 'fromhost-port' ? id : 'template';
  }
  if (template.entries.length === 3) {
    const separator = template.entries[1];
    if (separator.kind !== 'constant' || separator.text !== ':') return 'template';
    const host = ids(0);
    if (ids(2) !== 'fromhost-port') return 'template';
    if (host === 'fromhost-ip') return 'fromhost-ip-port';
    if (host === 'fromhost') return 'fromhost-name-port';
  }
  return 'template';
}

function shardCap(maxStates: number, shard: number): number {
  if (maxStates === 0) return 0;
  if (maxStates <= SHARDS) return 1;
  return Math.floor(maxStates / SHARDS) + (shard < maxStates % SHARDS ? 1 : 0);
}

function sanitizeMetricName(key: string): string {
  return Array.from(new TextEncoder().encode(key).slice(0, METRIC_NAME_LIMIT))
    .map((byte) => (/[A-Za-z0-9_-]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : '_')).join('');
}

export class PerSourceLimits {
  enabled = false;
  defaultMax = 0;
  defaultWindow = 0;
  policyFile: string | null = null;
  fromPolicyFile = false;
  keyTemplateName: string | null = null;
  topN = DEFAULT_TOP_N;
  maxStates = DEFAULT_MAX_STATES;
  keyMode: KeyMode = 'template';
  keyTemplate: Template | null = null;
  keyTemplateDefault = true;
  private shards: Shard[] = [];
  private object: StatsObject | null = null;
  private topKeys: Array<string | null> = [];
  private topValues: number[] = [];
  private topCounters: Array<string | null> = [];
  readonly counters = { allowed: 0, dropped: 0, evicted: 0, keyTemplateEvals: 0, keyParseEvals: 0 };

  constructor(private readonly name: string, private readonly statistics: Statistics) {}

  get initialized(): boolean {
    return this.shards.length > 0;
  }

  publishKeyPolicy(template: Template | null, isDefault: boolean): void {
    this.keyTemplate = template;
    this.keyTemplateDefault = isDefault;
    this.keyMode = keyModeOf(template);
  }

  private setShardCaps(maxStates: number): void {
    const effective = maxStates === 0 ? DEFAULT_MAX_STATES : maxStates;
    this.maxStates = effective;
    this.shards.forEach((shard, index) => { shard.maxStates = shardCap(effective, index); });
  }

  private initShards(maxStates: number): void {
    if (this.initialized) {
      this.setShardCaps(maxStates);
      return;
    }
    this.shards = Array.from({ length: SHARDS }, () => ({ table: new RsyslogHashTable<SourceEntry>(SHARD_HASH_SIZE), lruHead: null, lruTail: null, active: 0, maxStates: 0 }));
    this.setShardCaps(maxStates);
  }

  private shardOf(hash: number): Shard {
    return this.shards[hash % SHARDS];
  }

  private newEntry(shard: Shard, hash: number, key: string): SourceEntry {
    const entry: SourceEntry = {
      key, count: 0, windowStart: 0, allowed: 0, dropped: 0, lastSeen: 0, stateActive: false, hasOverride: false, max: 0, window: 0,
      hasMax: false, hasWindow: false, lruPrevious: null, lruNext: null,
    };
    shard.table.insertPrehashed(hash, key, entry);
    return entry;
  }

  private lruRemove(shard: Shard, entry: SourceEntry): void {
    if (entry.lruPrevious !== null) entry.lruPrevious.lruNext = entry.lruNext;
    if (entry.lruNext !== null) entry.lruNext.lruPrevious = entry.lruPrevious;
    if (shard.lruHead === entry) shard.lruHead = entry.lruNext;
    if (shard.lruTail === entry) shard.lruTail = entry.lruPrevious;
    entry.lruPrevious = null;
    entry.lruNext = null;
  }

  private lruTouch(shard: Shard, entry: SourceEntry): void {
    if (shard.lruTail === entry) return;
    if (entry.lruPrevious !== null || entry.lruNext !== null || shard.lruHead === entry) this.lruRemove(shard, entry);
    entry.lruPrevious = shard.lruTail;
    if (shard.lruTail !== null) shard.lruTail.lruNext = entry;
    shard.lruTail = entry;
    if (shard.lruHead === null) shard.lruHead = entry;
  }

  private evictOne(shard: Shard): void {
    const victim = shard.lruHead;
    if (victim === null) return;
    this.lruRemove(shard, victim);
    if (shard.active > 0) shard.active--;
    victim.stateActive = false;
    this.counters.evicted++;
    if (victim.hasOverride) return;
    shard.table.remove(victim.key);
  }

  applyOverrides(overrides: ReadonlyMap<string, PerSourceOverride>): void {
    if (!this.initialized) return;
    for (const override of overrides.values()) {
      const hash = this.shards[0].table.hash(override.key);
      const shard = this.shardOf(hash);
      if (shard.table.searchPrehashed(hash, override.key) === undefined) this.newEntry(shard, hash, override.key);
    }
    this.shards.forEach((shard) => {
      for (const [, entry] of shard.table.entries()) {
        entry.hasOverride = false;
        entry.hasMax = false;
        entry.hasWindow = false;
        entry.max = 0;
        entry.window = 0;
      }
      for (const override of overrides.values()) {
        const hash = shard.table.hash(override.key);
        if (this.shardOf(hash) !== shard) continue;
        const entry = shard.table.searchPrehashed(hash, override.key);
        if (entry === undefined) continue;
        entry.hasOverride = true;
        entry.hasMax = override.hasMax;
        entry.max = override.max;
        entry.hasWindow = override.hasWindow;
        entry.window = override.window;
      }
      shard.table.removeIf((_, entry) => !entry.stateActive && !entry.hasOverride);
    });
  }

  init(policy: PerSourcePolicy, policyFile: string, maxStates: number, topN: number): void {
    this.enabled = false;
    this.policyFile = policyFile;
    this.defaultMax = policy.defaultMax;
    this.defaultWindow = policy.defaultWindow;
    this.keyTemplateName = null;
    this.topN = topN === 0 ? DEFAULT_TOP_N : topN;
    this.initShards(maxStates);
    this.applyOverrides(policy.overrides);
    this.counters.allowed = 0;
    this.counters.dropped = 0;
    this.counters.evicted = 0;
    this.counters.keyTemplateEvals = 0;
    this.counters.keyParseEvals = 0;
    const object = this.statistics.create(`ratelimit.${this.name}.per_source`.slice(0, 255), { origin: 'ratelimit', readNotifier: () => this.updateTopN() });
    const counters = this.counters;
    object.addCounter({ name: 'per_source_allowed', read: () => counters.allowed, reset: () => { counters.allowed = 0; } });
    object.addCounter({ name: 'per_source_dropped', read: () => counters.dropped, reset: () => { counters.dropped = 0; } });
    object.addCounter({ name: 'per_source_evicted', read: () => counters.evicted, reset: () => { counters.evicted = 0; } });
    object.addCounter({ name: 'per_source_key_tpl_evals', read: () => counters.keyTemplateEvals, reset: () => { counters.keyTemplateEvals = 0; } });
    object.addCounter({ name: 'per_source_key_parse_evals', read: () => counters.keyParseEvals, reset: () => { counters.keyParseEvals = 0; } });
    this.object = object;
  }

  dispose(): void {
    if (this.object !== null) this.statistics.remove(this.object);
    this.object = null;
    this.shards = [];
  }

  swapPolicy(policy: PerSourcePolicy): void {
    this.applyOverrides(policy.overrides);
    this.defaultMax = policy.defaultMax;
    this.defaultWindow = policy.defaultWindow;
  }

  reconfigure(maxStates: number, topN: number): void {
    this.setShardCaps(maxStates);
    const effective = topN === 0 ? DEFAULT_TOP_N : topN;
    if (this.topN !== effective) {
      this.resetTopN();
      this.topN = effective;
    }
  }

  private resetTopN(): void {
    for (const name of this.topCounters) if (name !== null) this.object?.removeCounter(name);
    this.topKeys = [];
    this.topValues = [];
    this.topCounters = [];
  }

  keyOf(message: RsyslogMessage, render: (template: Template, message: RsyslogMessage) => string): string | null {
    if (!this.enabled) return null;
    const host = message.fromHost ?? '';
    const ip = message.fromHostIp ?? '';
    const port = message.fromHostPort ?? '';
    switch (this.keyMode) {
      case 'fromhost-ip': return ip;
      case 'fromhost': return host;
      case 'fromhost-port': return port;
      case 'fromhost-ip-port': return `${ip}:${port}`;
      case 'fromhost-name-port': return `${host}:${port}`;
      default:
        if (this.keyTemplate === null || this.keyTemplateDefault) return message.hostnameOrSender;
        this.counters.keyTemplateEvals++;
        return render(this.keyTemplate, message);
    }
  }

  check(key: string, seconds: number): boolean {
    if (!this.enabled || key.length === 0) return false;
    const hash = this.shards[0].table.hash(key);
    const shard = this.shardOf(hash);
    const entry = shard.table.searchPrehashed(hash, key) ?? this.newEntry(shard, hash, key);
    if (!entry.stateActive) {
      while (shard.maxStates > 0 && shard.active >= shard.maxStates) {
        if (shard.lruHead === null) break;
        this.evictOne(shard);
      }
      entry.stateActive = true;
      entry.windowStart = seconds;
      entry.lastSeen = seconds;
      shard.active++;
    }
    this.lruTouch(shard, entry);
    const max = entry.hasOverride && entry.hasMax ? entry.max : this.defaultMax;
    const window = entry.hasOverride && entry.hasWindow ? entry.window : this.defaultWindow;
    let mustDrop = false;
    if (max === 0 || window === 0) entry.allowed++;
    else {
      if (entry.windowStart === 0 || seconds - entry.windowStart >= window || seconds < entry.windowStart) {
        entry.windowStart = seconds;
        entry.count = 0;
      }
      if (entry.count < max) {
        entry.count++;
        entry.allowed++;
      } else {
        entry.dropped++;
        mustDrop = true;
      }
    }
    entry.lastSeen = seconds;
    if (mustDrop) this.counters.dropped++;
    else this.counters.allowed++;
    return mustDrop;
  }

  private updateTopN(): void {
    const object = this.object;
    if (object === null || this.topN === 0) return;
    const topN = this.topN;
    const values: number[] = new Array<number>(topN).fill(0);
    const keys: Array<string | null> = new Array<string | null>(topN).fill(null);
    for (const shard of this.shards) {
      for (const [, entry] of shard.table.entries()) {
        if (!entry.stateActive || entry.dropped === 0) continue;
        for (let i = 0; i < topN; i++) {
          if (entry.dropped > values[i]) {
            for (let j = topN - 1; j > i; j--) {
              values[j] = values[j - 1];
              keys[j] = keys[j - 1];
            }
            values[i] = entry.dropped;
            keys[i] = entry.key;
            break;
          }
        }
      }
    }
    const unchanged = this.topKeys.length === topN && keys.every((key, index) => key === this.topKeys[index]);
    if (!unchanged) {
      this.resetTopN();
      this.topKeys = new Array<string | null>(topN).fill(null);
      this.topCounters = new Array<string | null>(topN).fill(null);
      this.topValues = new Array<number>(topN).fill(0);
      keys.forEach((key, index) => {
        if (key === null) return;
        const name = `per_source_drop_${index + 1}_${sanitizeMetricName(key)}`.slice(0, 255);
        this.topValues[index] = values[index];
        object.addCounter({ name, read: () => this.topValues[index] });
        this.topKeys[index] = key;
        this.topCounters[index] = name;
      });
    } else {
      values.forEach((value, index) => { this.topValues[index] = value; });
    }
  }
}
