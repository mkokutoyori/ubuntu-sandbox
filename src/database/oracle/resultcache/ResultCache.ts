export type ResultCacheStatus = 'NEW' | 'PUBLISHED' | 'BYPASS' | 'EXPIRED' | 'INVALID';
export type ResultCacheObjectType = 'Result' | 'Dependency';

export class ResultCacheEntry {
  readonly id: number;
  readonly type: ResultCacheObjectType;
  status: ResultCacheStatus;
  bucketNo: number;
  hashKey: number;
  name: string;
  cacheId: string;
  cacheKey: string;
  blockCount: number;
  columnCount: number;
  pinCount: number;
  scanCount: number;
  rowCount: number;
  rowSize: number;
  spaceForResultCacheMb: number;
  cachedAt: Date;
  invalidatedAt: Date | null;
  invalidationsCount: number;
  creator: string;
  dependencyCount: number;

  constructor(init: {
    id: number; type?: ResultCacheObjectType;
    name: string; cacheId?: string; cacheKey?: string;
    rowCount?: number; rowSize?: number; columnCount?: number;
    creator?: string;
  }) {
    this.id = init.id;
    this.type = init.type ?? 'Result';
    this.status = 'PUBLISHED';
    this.bucketNo = init.id % 1024;
    let h = 0;
    for (let i = 0; i < init.name.length; i++) h = ((h << 5) - h + init.name.charCodeAt(i)) | 0;
    this.hashKey = Math.abs(h);
    this.name = init.name;
    this.cacheId = init.cacheId ?? `RC_${init.id.toString(16).padStart(8, '0').toUpperCase()}`;
    this.cacheKey = init.cacheKey ?? `qry-${init.id}`;
    this.rowCount = init.rowCount ?? 0;
    this.rowSize = init.rowSize ?? 0;
    this.columnCount = init.columnCount ?? 0;
    this.blockCount = Math.max(1, Math.ceil((this.rowCount * this.rowSize) / 8192));
    this.pinCount = 0;
    this.scanCount = 0;
    this.spaceForResultCacheMb = this.blockCount * 8 / 1024;
    this.cachedAt = new Date();
    this.invalidatedAt = null;
    this.invalidationsCount = 0;
    this.creator = init.creator ?? 'SYS';
    this.dependencyCount = 0;
  }

  invalidate(): void {
    this.status = 'INVALID';
    this.invalidatedAt = new Date();
    this.invalidationsCount++;
  }

  touch(): void { this.scanCount++; }
}

export class ResultCacheDependency {
  constructor(
    readonly id: number,
    readonly objectOwner: string,
    readonly objectName: string,
    readonly objectType: string,
    readonly resultId: number,
  ) {}
}

export class ResultCacheManager {
  private entries: ResultCacheEntry[] = [];
  private deps: ResultCacheDependency[] = [];
  private nextId = 1;
  enabled: boolean = false;

  flush(): void {
    for (const e of this.entries) e.status = 'INVALID';
  }

  bypass(on: boolean): void {
    for (const e of this.entries) e.status = on ? 'BYPASS' : 'PUBLISHED';
  }

  add(name: string, opts: { rowCount?: number; rowSize?: number; columnCount?: number; creator?: string } = {}): ResultCacheEntry {
    const e = new ResultCacheEntry({ id: this.nextId++, name, ...opts });
    this.entries.push(e);
    return e;
  }

  addDependency(objectOwner: string, objectName: string, objectType: string, resultId: number): void {
    this.deps.push(new ResultCacheDependency(this.deps.length + 1, objectOwner.toUpperCase(), objectName.toUpperCase(), objectType, resultId));
    const e = this.entries.find(x => x.id === resultId);
    if (e) e.dependencyCount++;
  }

  invalidateByObject(owner: string, name: string): number {
    const o = owner.toUpperCase(), n = name.toUpperCase();
    let count = 0;
    for (const d of this.deps) {
      if (d.objectOwner === o && d.objectName === n) {
        const e = this.entries.find(x => x.id === d.resultId);
        if (e && e.status === 'PUBLISHED') {
          e.invalidate();
          count++;
        }
      }
    }
    return count;
  }

  getEntries(): readonly ResultCacheEntry[] { return this.entries; }
  getDependencies(): readonly ResultCacheDependency[] { return this.deps; }
}
