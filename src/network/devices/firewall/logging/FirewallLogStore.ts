export type FirewallLogType = 'traffic' | 'event' | 'utm';

export type FirewallLogLevel =
  | 'emergency' | 'alert' | 'critical' | 'error'
  | 'warning' | 'notice' | 'information' | 'debug';

export interface FirewallLogRecord {
  readonly at: number;
  readonly type: FirewallLogType;
  readonly subtype: string;
  readonly level: FirewallLogLevel;
  readonly id: string;
  readonly fields: ReadonlyMap<string, string>;
}

export interface FirewallLogDraft {
  at: number;
  type: FirewallLogType;
  subtype: string;
  level: FirewallLogLevel;
  id: string;
  fields: Readonly<Record<string, string | number | undefined>>;
}

export interface FirewallLogFilter {
  readonly type?: FirewallLogType;
  readonly subtype?: string;
  readonly level?: FirewallLogLevel;
  readonly fields?: ReadonlyMap<string, string>;
  readonly viewLines?: number;
}

export const LOG_LEVEL_ORDER: readonly FirewallLogLevel[] = Object.freeze([
  'emergency', 'alert', 'critical', 'error',
  'warning', 'notice', 'information', 'debug',
]);

const DEFAULT_CAPACITY = 1000;

export function logLevelAtLeast(
  candidate: FirewallLogLevel, threshold: FirewallLogLevel,
): boolean {
  return LOG_LEVEL_ORDER.indexOf(candidate) <= LOG_LEVEL_ORDER.indexOf(threshold);
}

import {
  DEFAULT_LOG_FULL_THRESHOLDS, LOG_FULL_LEVELS, logFullDraft, type LogFullLevel,
} from './LogFullEvent';

export class FirewallLogStore {
  private records: FirewallLogRecord[] = [];
  private capacity: number;
  private maxBytes: number | null = null;
  private droppedCount = 0;
  private thresholds: Record<LogFullLevel, number> = { ...DEFAULT_LOG_FULL_THRESHOLDS };
  private announced = new Set<LogFullLevel>();
  private announcing = false;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  setCapacity(capacity: number): void {
    this.capacity = Math.max(1, capacity);
    this.trim();
  }

  getCapacity(): number {
    return this.capacity;
  }

  setMaxBytes(bytes: number | null): void {
    this.maxBytes = bytes === null || bytes <= 0 ? null : bytes;
    this.trim();
  }

  getMaxBytes(): number | null {
    return this.maxBytes;
  }

  usedBytes(): number {
    return this.records.reduce((total, record) => total + sizeOf(record), 0);
  }

  setFullThresholds(thresholds: Partial<Record<LogFullLevel, number>>): void {
    this.thresholds = { ...this.thresholds, ...thresholds };
  }

  getFullThresholds(): Readonly<Record<LogFullLevel, number>> {
    return Object.freeze({ ...this.thresholds });
  }

  private announceFullness(at: number): void {
    if (this.announcing || this.maxBytes === null) return;
    const usedPercent = Math.floor((this.usedBytes() / this.maxBytes) * 100);

    this.announcing = true;
    for (const level of LOG_FULL_LEVELS) {
      const threshold = this.thresholds[level];
      if (usedPercent >= threshold) {
        if (this.announced.has(level)) continue;
        this.announced.add(level);
        this.append(logFullDraft(at, level, threshold, usedPercent));
      } else {
        this.announced.delete(level);
      }
    }
    this.announcing = false;
  }

  append(draft: FirewallLogDraft): FirewallLogRecord {
    const fields = new Map<string, string>();
    for (const [name, value] of Object.entries(draft.fields)) {
      if (value === undefined) continue;
      fields.set(name, String(value));
    }

    const record: FirewallLogRecord = Object.freeze({
      at: draft.at,
      type: draft.type,
      subtype: draft.subtype,
      level: draft.level,
      id: draft.id,
      fields,
    });

    this.records.push(record);
    this.trim();
    this.announceFullness(draft.at);
    return record;
  }

  all(): readonly FirewallLogRecord[] {
    return Object.freeze([...this.records]);
  }

  select(filter: FirewallLogFilter): readonly FirewallLogRecord[] {
    const matched = this.records.filter(record => matches(record, filter));
    const lines = filter.viewLines;
    if (lines === undefined || lines <= 0 || matched.length <= lines) {
      return Object.freeze(matched);
    }
    return Object.freeze(matched.slice(matched.length - lines));
  }

  count(): number {
    return this.records.length;
  }

  dropped(): number {
    return this.droppedCount;
  }

  clear(): number {
    const removed = this.records.length;
    this.records = [];
    this.announced.clear();
    return removed;
  }

  private trim(): void {
    while (this.records.length > this.capacity) {
      this.records.shift();
      this.droppedCount++;
    }
    if (this.maxBytes === null) return;
    let used = this.usedBytes();
    while (this.records.length > 1 && used > this.maxBytes) {
      used -= sizeOf(this.records[0]);
      this.records.shift();
      this.droppedCount++;
    }
  }
}

function sizeOf(record: FirewallLogRecord): number {
  let bytes = record.type.length + record.subtype.length + record.level.length
    + record.id.length + 32;
  for (const [name, value] of record.fields) bytes += name.length + value.length + 2;
  return bytes;
}

function matches(record: FirewallLogRecord, filter: FirewallLogFilter): boolean {
  if (filter.type !== undefined && record.type !== filter.type) return false;
  if (filter.subtype !== undefined && record.subtype !== filter.subtype) return false;
  if (filter.level !== undefined && !logLevelAtLeast(record.level, filter.level)) return false;
  if (filter.fields === undefined) return true;

  for (const [name, wanted] of filter.fields) {
    if (record.fields.get(name) !== wanted) return false;
  }
  return true;
}
