import { simulationNowMs } from '@/network/core/SystemClock';
import type { IkeConfigReply, IkeConfigRequest } from '../IPSecTypes';

export interface EzvpnGroup {
  readonly name: string;
  key?: string;
  pool?: string;
  dns: string[];
  wins: string[];
  domain?: string;
  splitAcl?: string;
  netmask?: string;
  maxUsers?: number;
  maxLogins?: number;
}

export interface LocalPool {
  readonly name: string;
  readonly first: string;
  readonly last: string;
}

export interface EzvpnSession {
  readonly peer: string;
  readonly group: string;
  readonly user: string;
  readonly address: string;
  readonly startedMs: number;
}

export type AuthVerdict = 'accepted' | 'denied';

export interface MapClientPolicy {
  authenticationList?: string;
  authorizationList?: string;
  respond: boolean;
  initiate?: boolean;
}

export interface EzvpnHost {
  isLive(peer: string): boolean;
  authenticate(list: string, user: string, password: string): AuthVerdict;
  authorize(list: string, group: string): AuthVerdict;
  splitNetworks(acl: string): readonly string[];
  clientPolicyFor(peer: string): MapClientPolicy | null;
}

function toNumber(address: string): number {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((value) => Number.isNaN(value) || value < 0 || value > 255)) return NaN;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function toAddress(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

export function parseLocalPool(name: string, first: string, last?: string): LocalPool | string {
  const a = toNumber(first);
  const b = toNumber(last ?? first);
  if (Number.isNaN(a) || Number.isNaN(b)) return '% Invalid pool address';
  if (b < a) return '% Pool end address is below the start address';
  return { name, first, last: last ?? first };
}

export class EzvpnServer {
  readonly groups = new Map<string, EzvpnGroup>();
  readonly pools = new Map<string, LocalPool>();
  private readonly sessions = new Map<string, EzvpnSession>();
  private host: EzvpnHost | null = null;
  defaultPool: string | undefined;

  attach(host: EzvpnHost): void { this.host = host; }

  ensureGroup(name: string): EzvpnGroup {
    let group = this.groups.get(name);
    if (!group) {
      group = { name, dns: [], wins: [] };
      this.groups.set(name, group);
    }
    return group;
  }

  removeGroup(name: string): void { this.groups.delete(name); }

  groupKeyFor(identity: string): string | undefined {
    return this.groups.get(identity)?.key;
  }

  isConfigured(): boolean { return this.groups.size > 0; }

  liveSessions(): EzvpnSession[] {
    for (const [peer] of this.sessions) {
      if (this.host && !this.host.isLive(peer)) this.sessions.delete(peer);
    }
    return [...this.sessions.values()];
  }

  poolUsage(pool: string): Map<string, string> {
    const used = new Map<string, string>();
    for (const session of this.liveSessions()) {
      if ((this.groups.get(session.group)?.pool ?? this.defaultPool) === pool) used.set(session.address, session.peer);
    }
    return used;
  }

  private allocate(pool: LocalPool, peer: string): string | null {
    const held = this.sessions.get(peer);
    const used = this.poolUsage(pool.name);
    if (held && used.get(held.address) === peer) return held.address;
    for (let candidate = toNumber(pool.first); candidate <= toNumber(pool.last); candidate++) {
      const address = toAddress(candidate);
      if (!used.has(address)) return address;
    }
    return null;
  }

  answer(peer: string, identity: string, request: IkeConfigRequest): IkeConfigReply | string | undefined {
    if (!request.wantAddress || !this.host) return undefined;
    const policy = this.host.clientPolicyFor(peer);
    if (policy === null || !policy.respond) return undefined;
    const group = this.groups.get(identity);
    if (policy.authorizationList !== undefined) {
      if (!group || this.host.authorize(policy.authorizationList, identity) === 'denied') return 'AUTHORIZATION_FAILED';
    }
    if (!group) return 'NO_GROUP_CONFIGURED';
    const user = request.identity ?? '';
    if (policy.authenticationList !== undefined) {
      if (user.length === 0 || this.host.authenticate(policy.authenticationList, user, request.credential ?? '') === 'denied') {
        return 'AUTHENTICATION_FAILED';
      }
    }
    const others = this.liveSessions().filter((s) => s.peer !== peer);
    if (group.maxUsers !== undefined && others.filter((s) => s.group === group.name).length >= group.maxUsers) {
      return 'MAX_USERS_REACHED';
    }
    if (group.maxLogins !== undefined && user.length > 0
      && others.filter((s) => s.group === group.name && s.user === user).length >= group.maxLogins) {
      return 'MAX_LOGINS_REACHED';
    }
    const poolName = group.pool ?? this.defaultPool;
    const pool = poolName ? this.pools.get(poolName) : undefined;
    if (!pool) return 'IPv4 pool is not configured';
    const address = this.allocate(pool, peer);
    if (address === null) return 'IPv4 address pool is exhausted';
    this.sessions.set(peer, { peer, group: group.name, user, address, startedMs: simulationNowMs() });
    return {
      address,
      netmask: group.netmask ?? '255.255.255.255',
      splitInclude: group.splitAcl ? this.host.splitNetworks(group.splitAcl) : undefined,
      dnsServers: group.dns.length > 0 ? [...group.dns] : undefined,
      winsServers: group.wins.length > 0 ? [...group.wins] : undefined,
      domain: group.domain,
    };
  }

  renderGroupLines(): string[] {
    const lines: string[] = [];
    for (const group of this.groups.values()) {
      lines.push(`crypto isakmp client configuration group ${group.name}`);
      if (group.key) lines.push(` key ${group.key}`);
      if (group.dns.length > 0) lines.push(` dns ${group.dns.join(' ')}`);
      if (group.wins.length > 0) lines.push(` wins ${group.wins.join(' ')}`);
      if (group.domain) lines.push(` domain ${group.domain}`);
      if (group.pool) lines.push(` pool ${group.pool}`);
      if (group.splitAcl) lines.push(` acl ${group.splitAcl}`);
      if (group.netmask) lines.push(` netmask ${group.netmask}`);
      if (group.maxUsers !== undefined) lines.push(` max-users ${group.maxUsers}`);
      if (group.maxLogins !== undefined) lines.push(` max-logins ${group.maxLogins}`);
    }
    if (this.defaultPool) lines.push(`crypto isakmp client configuration address-pool local ${this.defaultPool}`);
    for (const pool of this.pools.values()) {
      lines.push(pool.first === pool.last ? `ip local pool ${pool.name} ${pool.first}` : `ip local pool ${pool.name} ${pool.first} ${pool.last}`);
    }
    return lines;
  }

  private anyLimitConfigured(): boolean {
    return [...this.groups.values()].some((g) => g.maxUsers !== undefined || g.maxLogins !== undefined);
  }

  renderSessionGroups(): string {
    if (!this.anyLimitConfigured()) return '';
    const counts = new Map<string, number>();
    for (const session of this.liveSessions()) counts.set(session.group, (counts.get(session.group) ?? 0) + 1);
    if (counts.size === 0) return '';
    return ['Group: Connections', ...[...counts].map(([name, n]) => `${name}: ${n}`)].join('\n');
  }

  renderSessionSummary(): string {
    if (!this.anyLimitConfigured()) return '';
    const byGroup = new Map<string, Map<string, number>>();
    for (const session of this.liveSessions()) {
      const users = byGroup.get(session.group) ?? new Map<string, number>();
      users.set(session.user, (users.get(session.user) ?? 0) + 1);
      byGroup.set(session.group, users);
    }
    const out: string[] = [];
    for (const [name, users] of byGroup) {
      const total = [...users.values()].reduce((a, b) => a + b, 0);
      out.push(`Group ${name} has ${total} connections`, 'User (Logins)', ...[...users].map(([user, n]) => `${user} (${n})`));
    }
    return out.join('\n');
  }

  renderLocalPool(name?: string): string {
    const pools = [...this.pools.values()].filter((p) => name === undefined || p.name === name);
    if (name !== undefined && pools.length === 0) return `Pool ${name} does not exist`;
    const out = ['Pool                  Begin           End             Free  InUse'];
    for (const pool of pools) {
      const total = toNumber(pool.last) - toNumber(pool.first) + 1;
      const inUse = this.poolUsage(pool.name).size;
      out.push(`${pool.name.padEnd(22)}${pool.first.padEnd(16)}${pool.last.padEnd(16)}${String(total - inUse).padEnd(6)}${inUse}`);
    }
    return out.join('\n');
  }
}
