import type { Errno } from '@/network/core/Errno';
import { RS_RET } from './Log';
import { jsonGetInt, jsonGetString, parseJsonC, type JsonValue } from './JsonC';

export interface LookupLog {
  error(text: string, code: number, errno?: Errno): void;
  info(text: string): void;
}

export interface LookupFiles {
  read(path: string): string | null;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
}

export type LookupKeyType = 'string' | 'uint' | 'none';

const ENCODER = new TextEncoder();

function compareBytes(a: string, b: string): number {
  const left = ENCODER.encode(a);
  const right = ENCODER.encode(b);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}

function binarySearch<T>(items: readonly T[], compare: (item: T) => number): T | undefined {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const index = Math.floor((low + high) / 2);
    const comparison = compare(items[index]);
    if (comparison < 0) high = index;
    else if (comparison > 0) low = index + 1;
    else return items[index];
  }
  return undefined;
}

function searchLessOrEqual<T>(items: readonly T[], compare: (item: T) => number): T | undefined {
  let low = 0;
  let high = items.length;
  if (low === high) return undefined;
  let index = 0;
  let comparison = 0;
  while (low < high) {
    index = Math.floor((low + high) / 2);
    comparison = compare(items[index]);
    if (comparison < 0) high = index;
    else if (comparison > 0) low = index + 1;
    else return items[index];
  }
  if (comparison < 0) {
    if (index === 0) return undefined;
    index--;
  }
  return items[index];
}

export class LookupTable {
  keyType: LookupKeyType = 'none';
  private nomatch: string | null = null;
  private entries: Array<{ key: string; value: string }> = [];
  private numbered: Array<{ key: number; value: string }> = [];
  private firstKey = 0;
  private kind: 'string' | 'array' | 'sparseArray' | 'stub' | 'empty' = 'empty';

  static stubbed(value: string): LookupTable {
    const table = new LookupTable();
    table.nomatch = value;
    table.kind = 'stub';
    return table;
  }

  get isStub(): boolean {
    return this.kind === 'stub';
  }

  get stubValue(): string | null {
    return this.kind === 'stub' ? this.nomatch : null;
  }

  private defaultValue(): string {
    return this.nomatch ?? '';
  }

  lookup(key: string | number): string {
    switch (this.kind) {
      case 'stub': return this.nomatch ?? '';
      case 'string': {
        if (this.entries.length === 0) return this.defaultValue();
        const wanted = String(key);
        const found = binarySearch(this.entries, (entry) => compareBytes(wanted, entry.key));
        return found === undefined ? this.defaultValue() : found.value;
      }
      case 'array': {
        const wanted = key as number;
        if (this.numbered.length === 0 || wanted < this.firstKey) return this.defaultValue();
        const index = wanted - this.firstKey;
        return index >= this.numbered.length ? this.defaultValue() : this.numbered[index].value;
      }
      case 'sparseArray': {
        const wanted = key as number;
        if (this.numbered.length === 0) return this.defaultValue();
        const found = searchLessOrEqual(this.numbered, (entry) => (wanted < entry.key ? -1 : wanted > entry.key ? 1 : 0));
        return found === undefined ? this.defaultValue() : found.value;
      }
      default: return this.defaultValue();
    }
  }

  build(root: JsonValue, name: string, log: LookupLog): boolean {
    const record = (value: JsonValue | undefined): { [key: string]: JsonValue } | null =>
      typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
    const field = (row: JsonValue, field: string): JsonValue | undefined => record(row)?.[field];
    const version = record(root)?.version;
    let versionNumber = 1;
    if (version !== undefined && version !== null) versionNumber = jsonGetInt(version);
    else log.error(`lookup table named: '${name}' doesn't specify version (will use default value: ${versionNumber})`, RS_RET.INVALID_VALUE);
    if (versionNumber !== 1) {
      log.error(`lookup table named: '${name}' uses unsupported version: ${versionNumber}`, RS_RET.INVALID_VALUE);
      return false;
    }
    const table = record(root)?.table;
    if (!Array.isArray(table)) {
      log.error(`lookup table named: '${name}' has invalid table definition`, RS_RET.INVALID_VALUE);
      return false;
    }
    const type = jsonGetString(record(root)?.type) ?? 'string';
    for (const row of table) {
      const value = field(row, 'value');
      if (value === undefined || value === null) {
        log.error(`'${type}' lookup table named: '${name}' has record(s) without 'value' field`, RS_RET.INVALID_VALUE);
        return false;
      }
    }
    this.nomatch = jsonGetString(record(root)?.nomatch);
    const noIndex = (kind: string): false => {
      log.error(`'${kind}' lookup table named: '${name}' has record(s) without 'index' field`, RS_RET.INVALID_VALUE);
      return false;
    };
    const rows = table.map((row) => ({ index: field(row, 'index'), value: jsonGetString(field(row, 'value')) ?? '' }));
    if (type === 'string') {
      for (const row of rows) if (row.index === undefined || row.index === null) return noIndex('string');
      this.entries = rows.map((row) => ({ key: jsonGetString(row.index) ?? '', value: row.value }));
      this.entries.sort((a, b) => compareBytes(a.key, b.key));
      this.kind = 'string';
      this.keyType = 'string';
      return true;
    }
    if (type === 'array') {
      for (const row of rows) if (row.index === undefined || row.index === null) return noIndex('array');
      const indexed = rows.map((row) => ({ key: jsonGetInt(row.index) >>> 0, value: row.value }));
      indexed.sort((a, b) => a.key - b.key);
      let previous = 0;
      indexed.forEach((entry, position) => {
        if (position === 0) this.firstKey = entry.key;
      });
      for (let position = 0; position < indexed.length; position++) {
        if (position > 0) {
          previous = (previous + 1) >>> 0;
          if (indexed[position].key !== previous) {
            log.error(`'array' lookup table name: '${name}' has non-contiguous members between index '${previous}' and '${indexed[position].key}'`, RS_RET.INVALID_VALUE);
            return false;
          }
        } else previous = indexed[position].key;
      }
      this.numbered = indexed;
      this.kind = 'array';
      this.keyType = 'uint';
      return true;
    }
    if (type === 'sparseArray') {
      for (const row of rows) if (row.index === undefined || row.index === null) return noIndex('sparseArray');
      this.numbered = rows.map((row) => ({ key: jsonGetInt(row.index) >>> 0, value: row.value }));
      this.numbered.sort((a, b) => a.key - b.key);
      this.kind = 'sparseArray';
      this.keyType = 'uint';
      return true;
    }
    log.error(`lookup table named: '${name}' uses unupported type: '${type}'`, RS_RET.INVALID_VALUE);
    return false;
  }
}

export function readLookupFile(files: LookupFiles, name: string, filename: string, log: LookupLog): LookupTable | null {
  if (!files.exists(filename)) {
    log.error(`lookup table file '${filename}' could not be opened`, RS_RET.FILE_NOT_FOUND, 'ENOENT');
    return null;
  }
  if (files.isDirectory(filename)) {
    log.error(`lookup table file '${filename}' read error: Is a directory`, RS_RET.READ_ERR);
    return null;
  }
  const content = files.read(filename);
  if (content === null) {
    log.error(`lookup table file '${filename}' could not be opened`, RS_RET.FILE_NOT_FOUND, 'EACCES');
    return null;
  }
  const root = parseJsonC(content);
  if (root === undefined) {
    log.error(`lookup table file '${filename}' json parsing error`, RS_RET.JSON_PARSE_ERR);
    return null;
  }
  const table = new LookupTable();
  return table.build(root, name, log) ? table : null;
}

export interface LookupSchedule {
  schedule(callback: () => void, delayMs: number): () => void;
}

export class LookupRef {
  table: LookupTable | null = new LookupTable();
  reloadOnHup = true;
  private reloadRequested = false;
  private reloading = false;
  private stubOnFailure: string | null = null;
  private stopped = false;

  constructor(
    readonly name: string,
    readonly filename: string,
    private readonly files: LookupFiles,
    private readonly log: LookupLog,
    private readonly timing: LookupSchedule,
  ) {}

  load(): boolean {
    const table = readLookupFile(this.files, this.name, this.filename, this.log);
    if (table === null) {
      this.table = null;
      return false;
    }
    this.table = table;
    this.log.info(`lookup table '${this.name}' loaded from file '${this.filename}'`);
    return true;
  }

  get reloadPending(): boolean {
    return this.reloadRequested || this.reloading;
  }

  stop(): void {
    this.stopped = true;
  }

  reload(stubIfReloadFails: string | null): void {
    this.stubOnFailure = stubIfReloadFails;
    if (this.reloadRequested) return;
    this.reloadRequested = true;
    this.timing.schedule(() => this.runReload(), 0);
  }

  private runReload(): void {
    if (this.stopped || !this.reloadRequested) return;
    const stub = this.stubOnFailure;
    this.stubOnFailure = null;
    this.reloadRequested = false;
    this.reloading = true;
    try {
      this.reloadOrStub(null, stub === null ? null : stub);
    } finally {
      this.reloading = false;
    }
  }

  private reloadOrStub(stubValue: string | null, stubOnFailure: string | null): void {
    const next = stubValue === null ? readLookupFile(this.files, this.name, this.filename, this.log) : LookupTable.stubbed(stubValue);
    if (next === null) {
      this.log.error(`lookup table '${this.name}' could not be reloaded from file '${this.filename}'`, RS_RET.INTERNAL_ERROR);
      if (stubOnFailure !== null) this.doStub(stubOnFailure);
      return;
    }
    this.table = next;
    if (stubValue === null) this.log.info(`lookup table '${this.name}' reloaded from file '${this.filename}'`);
    else this.log.error(`lookup table '${this.name}' stubbed with value '${stubValue}'`, RS_RET.NONE);
  }

  private doStub(stubValue: string): void {
    if (this.table?.isStub === true && this.table.stubValue === stubValue) {
      this.log.error(`lookup table '${this.name}' is already stubbed with value '${stubValue}'`, RS_RET.NONE);
      return;
    }
    this.log.error(`stubbing lookup table '${this.name}' with value '${stubValue}'`, RS_RET.NONE);
    this.reloadOrStub(stubValue, null);
  }

  lookup(key: string | number): string {
    return this.table === null ? '' : this.table.lookup(key);
  }

  get keyType(): LookupKeyType {
    return this.table?.keyType ?? 'none';
  }
}
