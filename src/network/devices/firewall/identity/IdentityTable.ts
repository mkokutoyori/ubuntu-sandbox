export type IdentitySource = 'local' | 'radius' | 'tacacs+' | 'ldap';

export interface AuthenticatedIdentity {
  readonly id: number;
  readonly address: string;
  readonly user: string;
  readonly source: IdentitySource;
  readonly server?: string;
  readonly groups: readonly string[];
  readonly groupIds: readonly number[];
  readonly policyId?: string;
  readonly authenticatedAt: number;
  lastSeenAt: number;
  expiresAt: number;
  packetsIn: number;
  packetsOut: number;
  bytesIn: number;
  bytesOut: number;
}

export interface IdentityBindOptions {
  readonly address: string;
  readonly user: string;
  readonly source: IdentitySource;
  readonly server?: string;
  readonly groups: readonly string[];
  readonly groupIds?: readonly number[];
  readonly policyId?: string;
  readonly timeoutSec: number;
}

export interface IdentityTableDeps {
  readonly now?: () => number;
}

export const DEFAULT_AUTH_TIMEOUT_SEC = 300;

export class IdentityTable {
  private readonly byAddress = new Map<string, AuthenticatedIdentity>();
  private readonly now: () => number;
  private nextId = 1;

  constructor(deps: IdentityTableDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
  }

  bind(options: IdentityBindOptions): AuthenticatedIdentity {
    const at = this.now();
    const identity: AuthenticatedIdentity = {
      id: this.nextId++,
      address: options.address,
      user: options.user,
      source: options.source,
      server: options.server,
      groups: Object.freeze([...options.groups]),
      groupIds: Object.freeze([...(options.groupIds ?? options.groups.map((_, i) => i + 1))]),
      policyId: options.policyId,
      authenticatedAt: at,
      lastSeenAt: at,
      expiresAt: at + options.timeoutSec * 1000,
      packetsIn: 0,
      packetsOut: 0,
      bytesIn: 0,
      bytesOut: 0,
    };

    this.byAddress.set(options.address, identity);
    return identity;
  }

  lookup(address: string): AuthenticatedIdentity | undefined {
    const found = this.byAddress.get(address);
    if (!found) return undefined;
    if (this.expired(found)) {
      this.byAddress.delete(address);
      return undefined;
    }
    return found;
  }

  isAuthenticatedFor(address: string, groups: readonly string[]): boolean {
    const identity = this.lookup(address);
    if (!identity) return false;
    if (groups.length === 0) return true;
    return groups.some(group => identity.groups.includes(group));
  }

  touch(address: string, direction: 'in' | 'out', bytes: number): void {
    const identity = this.lookup(address);
    if (!identity) return;

    identity.lastSeenAt = this.now();
    if (direction === 'in') {
      identity.packetsIn += 1;
      identity.bytesIn += bytes;
      return;
    }
    identity.packetsOut += 1;
    identity.bytesOut += bytes;
  }

  extend(address: string, timeoutSec: number): void {
    const identity = this.lookup(address);
    if (!identity) return;
    identity.expiresAt = this.now() + timeoutSec * 1000;
  }

  release(address: string): boolean {
    return this.byAddress.delete(address);
  }

  releaseUser(user: string): number {
    let removed = 0;
    for (const [address, identity] of [...this.byAddress]) {
      if (identity.user !== user) continue;
      this.byAddress.delete(address);
      removed++;
    }
    return removed;
  }

  clear(): number {
    const size = this.byAddress.size;
    this.byAddress.clear();
    return size;
  }

  list(): readonly AuthenticatedIdentity[] {
    this.prune();
    return Object.freeze([...this.byAddress.values()]);
  }

  size(): number {
    this.prune();
    return this.byAddress.size;
  }

  durationOf(identity: AuthenticatedIdentity): number {
    return Math.floor((this.now() - identity.authenticatedAt) / 1000);
  }

  idleOf(identity: AuthenticatedIdentity): number {
    return Math.floor((this.now() - identity.lastSeenAt) / 1000);
  }

  private prune(): void {
    for (const [address, identity] of [...this.byAddress]) {
      if (this.expired(identity)) this.byAddress.delete(address);
    }
  }

  private expired(identity: AuthenticatedIdentity): boolean {
    return this.now() >= identity.expiresAt;
  }
}
