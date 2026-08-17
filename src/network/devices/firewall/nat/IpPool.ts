import { tryIpToUint32, uint32ToIp } from '../../../core/ip';

export type IpPoolType =
  | 'overload'
  | 'one-to-one'
  | 'fixed-port-range'
  | 'port-block-allocation';

export interface IpPool {
  readonly name: string;
  readonly type: IpPoolType;
  readonly startIP: string;
  readonly endIP: string;
  readonly sourceStartIP?: string;
  readonly sourceEndIP?: string;
  readonly blockSize: number;
  readonly blocksPerUser: number;
  readonly permitAnyHost: boolean;
  readonly arpReply: boolean;
  readonly arpInterface?: string;
  readonly associatedInterface?: string;
  readonly comment?: string;
}

export interface PoolAllocation {
  readonly address: string;
  readonly port: number;
}

export interface PoolAllocationRequest {
  readonly sourceIP: string;
  readonly sourcePort: number;
  readonly fixedPort: boolean;
  readonly simulated: boolean;
}

export interface IpPoolDraft {
  name: string;
  type?: IpPoolType;
  startIP: string;
  endIP?: string;
  sourceStartIP?: string;
  sourceEndIP?: string;
  blockSize?: number;
  blocksPerUser?: number;
  permitAnyHost?: boolean;
  arpReply?: boolean;
  arpInterface?: string;
  associatedInterface?: string;
  comment?: string;
}

export const DEFAULT_BLOCK_SIZE = 128;
export const DEFAULT_BLOCKS_PER_USER = 8;

const EPHEMERAL_FROM = 5117;
const EPHEMERAL_TO = 65533;

export function makeIpPool(draft: IpPoolDraft): IpPool {
  return Object.freeze({
    name: draft.name,
    type: draft.type ?? 'overload',
    startIP: draft.startIP,
    endIP: draft.endIP ?? draft.startIP,
    sourceStartIP: draft.sourceStartIP,
    sourceEndIP: draft.sourceEndIP,
    blockSize: draft.blockSize ?? DEFAULT_BLOCK_SIZE,
    blocksPerUser: draft.blocksPerUser ?? DEFAULT_BLOCKS_PER_USER,
    permitAnyHost: draft.permitAnyHost ?? false,
    arpReply: draft.arpReply ?? true,
    arpInterface: draft.arpInterface,
    associatedInterface: draft.associatedInterface,
    comment: draft.comment,
  });
}

export function poolAddressCount(pool: IpPool): number {
  const from = tryIpToUint32(pool.startIP);
  const to = tryIpToUint32(pool.endIP);
  if (from === null || to === null || to < from) return 0;
  return to - from + 1;
}

export function poolContains(pool: IpPool, address: string): boolean {
  const value = tryIpToUint32(address);
  const from = tryIpToUint32(pool.startIP);
  const to = tryIpToUint32(pool.endIP);
  if (value === null || from === null || to === null) return false;
  return value >= from && value <= to;
}

export function poolAddressAt(pool: IpPool, index: number): string | null {
  const count = poolAddressCount(pool);
  if (count === 0) return null;
  const from = tryIpToUint32(pool.startIP)!;
  return uint32ToIp((from + (index % count)) >>> 0);
}

interface OneToOneBinding {
  readonly address: string;
  sessions: number;
}

export class IpPoolAllocator {
  private readonly pools = new Map<string, IpPool>();
  private readonly overloadPorts = new Map<string, Set<number>>();
  private readonly overloadMappings = new Map<string, PoolAllocation>();
  private readonly oneToOne = new Map<string, OneToOneBinding>();
  private readonly blocks = new Map<string, PoolAllocation[]>();

  upsert(pool: IpPool): void {
    this.pools.set(pool.name, pool);
    this.releasePool(pool.name);
  }

  remove(name: string): boolean {
    this.releasePool(name);
    return this.pools.delete(name);
  }

  get(name: string): IpPool | undefined {
    return this.pools.get(name);
  }

  names(): readonly string[] {
    return Object.freeze([...this.pools.keys()]);
  }

  all(): readonly IpPool[] {
    return Object.freeze([...this.pools.values()]);
  }

  allocate(name: string, request: PoolAllocationRequest): PoolAllocation | null {
    const pool = this.pools.get(name);
    if (!pool || poolAddressCount(pool) === 0) return null;
    if (!this.acceptsSource(pool, request.sourceIP)) return null;

    switch (pool.type) {
      case 'one-to-one': return this.allocateOneToOne(pool, request);
      case 'fixed-port-range': return this.allocateFixedRange(pool, request);
      case 'port-block-allocation': return this.allocateBlock(pool, request);
      default: return this.allocateOverload(pool, request);
    }
  }

  release(name: string, allocation: PoolAllocation, sourceIP: string): void {
    const pool = this.pools.get(name);
    if (!pool) return;

    if (pool.type === 'one-to-one') {
      const binding = this.oneToOne.get(bindingKey(name, sourceIP));
      if (!binding) return;
      binding.sessions--;
      if (binding.sessions <= 0) this.oneToOne.delete(bindingKey(name, sourceIP));
      return;
    }
    if (pool.type !== 'overload') return;

    this.overloadPorts.get(allocation.address)?.delete(allocation.port);
    this.overloadMappings.delete(mappingKey(name, sourceIP, allocation.port));
  }

  private acceptsSource(pool: IpPool, sourceIP: string): boolean {
    if (pool.sourceStartIP === undefined || pool.sourceEndIP === undefined) return true;

    const value = tryIpToUint32(sourceIP);
    const from = tryIpToUint32(pool.sourceStartIP);
    const to = tryIpToUint32(pool.sourceEndIP);
    if (value === null || from === null || to === null) return false;
    if (value >= from && value <= to) return true;
    return pool.permitAnyHost;
  }

  private allocateOverload(pool: IpPool, request: PoolAllocationRequest): PoolAllocation | null {
    const count = poolAddressCount(pool);
    const preferred = sourceHash(request.sourceIP) % count;

    for (let step = 0; step < count; step++) {
      const address = poolAddressAt(pool, preferred + step);
      if (address === null) continue;

      const taken = this.overloadPorts.get(address) ?? new Set<number>();
      const port = freePort(taken, request.sourcePort, request.fixedPort);
      if (port === null) continue;

      const allocation = Object.freeze({ address, port });
      if (request.simulated) return allocation;

      taken.add(port);
      this.overloadPorts.set(address, taken);
      this.overloadMappings.set(
        mappingKey(pool.name, request.sourceIP, request.sourcePort), allocation);
      return allocation;
    }
    return null;
  }

  private allocateOneToOne(pool: IpPool, request: PoolAllocationRequest): PoolAllocation | null {
    const key = bindingKey(pool.name, request.sourceIP);
    const existing = this.oneToOne.get(key);
    if (existing) {
      if (!request.simulated) existing.sessions++;
      return Object.freeze({ address: existing.address, port: request.sourcePort });
    }

    const used = new Set<string>();
    for (const [otherKey, binding] of this.oneToOne) {
      if (otherKey.startsWith(`${pool.name}|`)) used.add(binding.address);
    }

    const count = poolAddressCount(pool);
    for (let index = 0; index < count; index++) {
      const address = poolAddressAt(pool, index);
      if (address === null || used.has(address)) continue;

      if (!request.simulated) this.oneToOne.set(key, { address, sessions: 1 });
      return Object.freeze({ address, port: request.sourcePort });
    }
    return null;
  }

  private allocateFixedRange(
    pool: IpPool, request: PoolAllocationRequest,
  ): PoolAllocation | null {
    const source = tryIpToUint32(request.sourceIP);
    const from = tryIpToUint32(pool.sourceStartIP ?? '');
    if (source === null || from === null) return null;

    const internalCount = internalRangeSize(pool);
    if (internalCount === 0) return null;

    const externalCount = poolAddressCount(pool);
    const offset = source - from;
    if (offset < 0 || offset >= internalCount) return null;

    const address = poolAddressAt(pool, Math.floor(offset * externalCount / internalCount));
    if (address === null) return null;

    const perAddress = Math.max(1, Math.floor(internalCount / externalCount));
    const slot = offset % perAddress;
    const span = Math.floor((EPHEMERAL_TO - EPHEMERAL_FROM + 1) / perAddress);
    const base = EPHEMERAL_FROM + slot * span;
    const port = base + (request.sourcePort % span);
    return Object.freeze({ address, port });
  }

  private allocateBlock(pool: IpPool, request: PoolAllocationRequest): PoolAllocation | null {
    const key = bindingKey(pool.name, request.sourceIP);
    const owned = this.blocks.get(key) ?? [];

    for (const block of owned) {
      const port = block.port + (request.sourcePort % pool.blockSize);
      const taken = this.overloadPorts.get(block.address);
      if (taken?.has(port)) continue;
      if (!request.simulated) {
        const ports = taken ?? new Set<number>();
        ports.add(port);
        this.overloadPorts.set(block.address, ports);
      }
      return Object.freeze({ address: block.address, port });
    }

    if (owned.length >= pool.blocksPerUser) return null;

    const block = this.reserveBlock(pool);
    if (block === null) return null;

    if (!request.simulated) {
      owned.push(block);
      this.blocks.set(key, owned);
    }
    return Object.freeze({
      address: block.address, port: block.port + (request.sourcePort % pool.blockSize),
    });
  }

  private reserveBlock(pool: IpPool): PoolAllocation | null {
    const reserved = new Set<string>();
    for (const [key, list] of this.blocks) {
      if (!key.startsWith(`${pool.name}|`)) continue;
      for (const block of list) reserved.add(`${block.address}:${block.port}`);
    }

    const count = poolAddressCount(pool);
    for (let index = 0; index < count; index++) {
      const address = poolAddressAt(pool, index);
      if (address === null) continue;

      for (let base = EPHEMERAL_FROM; base + pool.blockSize - 1 <= EPHEMERAL_TO;
        base += pool.blockSize) {
        if (reserved.has(`${address}:${base}`)) continue;
        return Object.freeze({ address, port: base });
      }
    }
    return null;
  }

  private releasePool(name: string): void {
    for (const key of [...this.oneToOne.keys()]) {
      if (key.startsWith(`${name}|`)) this.oneToOne.delete(key);
    }
    for (const key of [...this.blocks.keys()]) {
      if (key.startsWith(`${name}|`)) this.blocks.delete(key);
    }
    for (const key of [...this.overloadMappings.keys()]) {
      if (key.startsWith(`${name}|`)) this.overloadMappings.delete(key);
    }
  }
}

function internalRangeSize(pool: IpPool): number {
  const from = tryIpToUint32(pool.sourceStartIP ?? '');
  const to = tryIpToUint32(pool.sourceEndIP ?? '');
  if (from === null || to === null || to < from) return 0;
  return to - from + 1;
}

function freePort(taken: ReadonlySet<number>, preferred: number, fixed: boolean): number | null {
  if (fixed) return taken.has(preferred) ? null : preferred;
  if (preferred >= EPHEMERAL_FROM && preferred <= EPHEMERAL_TO && !taken.has(preferred)) {
    return preferred;
  }
  for (let port = EPHEMERAL_FROM; port <= EPHEMERAL_TO; port++) {
    if (!taken.has(port)) return port;
  }
  return null;
}

function sourceHash(address: string): number {
  const value = tryIpToUint32(address);
  return value === null ? 0 : value >>> 0;
}

function bindingKey(pool: string, sourceIP: string): string {
  return `${pool}|${sourceIP}`;
}

function mappingKey(pool: string, sourceIP: string, port: number): string {
  return `${pool}|${sourceIP}:${port}`;
}
