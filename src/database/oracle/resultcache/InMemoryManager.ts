export type InMemoryPriority = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type InMemoryDistribute = 'AUTO' | 'BY ROWID RANGE' | 'BY PARTITION' | 'BY SUBPARTITION';
export type InMemoryCompression = 'NO MEMCOMPRESS' | 'MEMCOMPRESS FOR DML' | 'MEMCOMPRESS FOR QUERY LOW' | 'MEMCOMPRESS FOR QUERY HIGH' | 'MEMCOMPRESS FOR CAPACITY LOW' | 'MEMCOMPRESS FOR CAPACITY HIGH';

export class InMemorySegment {
  readonly owner: string;
  readonly segmentName: string;
  readonly tablespaceName: string;
  readonly inmemorySize: number;
  readonly bytes: number;
  readonly bytesNotPopulated: number;
  populateStatus: 'COMPLETED' | 'STARTED' | 'OUT OF MEMORY';
  readonly inmemoryPriority: InMemoryPriority;
  readonly inmemoryDistribute: InMemoryDistribute;
  readonly inmemoryCompression: InMemoryCompression;
  readonly inmemoryDuplicate: 'NO DUPLICATE' | 'DUPLICATE' | 'DUPLICATE ALL';
  readonly conId: number;

  constructor(init: {
    owner: string; segmentName: string; tablespaceName: string;
    inmemorySize: number; bytes?: number;
    inmemoryPriority?: InMemoryPriority;
    inmemoryDistribute?: InMemoryDistribute;
    inmemoryCompression?: InMemoryCompression;
    inmemoryDuplicate?: 'NO DUPLICATE' | 'DUPLICATE' | 'DUPLICATE ALL';
    conId?: number;
  }) {
    this.owner = init.owner.toUpperCase();
    this.segmentName = init.segmentName.toUpperCase();
    this.tablespaceName = init.tablespaceName.toUpperCase();
    this.inmemorySize = init.inmemorySize;
    this.bytes = init.bytes ?? init.inmemorySize;
    this.bytesNotPopulated = 0;
    this.populateStatus = 'COMPLETED';
    this.inmemoryPriority = init.inmemoryPriority ?? 'NONE';
    this.inmemoryDistribute = init.inmemoryDistribute ?? 'AUTO';
    this.inmemoryCompression = init.inmemoryCompression ?? 'MEMCOMPRESS FOR QUERY LOW';
    this.inmemoryDuplicate = init.inmemoryDuplicate ?? 'NO DUPLICATE';
    this.conId = init.conId ?? 1;
  }
}

export class InMemoryManager {
  private segments: InMemorySegment[] = [];
  poolSizeBytes: number = 0;

  setPoolSize(bytes: number): void { this.poolSizeBytes = bytes; }

  addSegment(s: InMemorySegment): void {
    this.segments = this.segments.filter(x => !(x.owner === s.owner && x.segmentName === s.segmentName));
    this.segments.push(s);
  }

  removeSegment(owner: string, segmentName: string): boolean {
    const o = owner.toUpperCase(), n = segmentName.toUpperCase();
    const before = this.segments.length;
    this.segments = this.segments.filter(s => !(s.owner === o && s.segmentName === n));
    return this.segments.length < before;
  }

  getSegments(): readonly InMemorySegment[] { return this.segments; }
  getTotalBytes(): number { return this.segments.reduce((s, x) => s + x.bytes, 0); }
}
