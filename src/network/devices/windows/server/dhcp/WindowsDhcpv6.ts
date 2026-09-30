import type { EndHost } from '@/network/devices/EndHost';
import { IPv6Address } from '@/network/core/types';
import { ipv6ToBigInt } from '@/network/core/Ipv6Arithmetic';
import { Dhcpv6HostService, dhcpv6PortOf } from '@/network/dhcpv6/Dhcpv6HostService';
import type { DHCPv6Server } from '@/network/dhcpv6/DHCPv6Server';

export interface DhcpV6OpResult { ok: boolean; message: string }

export interface DhcpV6ScopeInfo {
  prefix: string;
  name: string;
  description: string;
  state: 'Active' | 'InActive';
  preference: number;
  preferredLifetime: number;
  validLifetime: number;
  t1: number;
  t2: number;
}

export interface DhcpV6LeaseInfo {
  ipAddress: string;
  clientDuid: string;
  iaid: number;
  prefix: string;
  leaseExpiration: number;
}

export interface DhcpV6ReservationInfo {
  prefix: string;
  ipAddress: string;
  clientDuid: string;
  iaid: number;
  name: string;
}

export interface DhcpV6ExclusionInfo { prefix: string; startRange: string; endRange: string }

export interface DhcpV6ScopeRequest {
  prefix: string;
  name: string;
  description?: string;
  preferredLifetime?: number;
  validLifetime?: number;
  t1?: number;
  t2?: number;
  state?: 'Active' | 'InActive';
  preference?: number;
}

export const V6_DEFAULT_PREFERRED = 8 * 86400;
export const V6_DEFAULT_VALID = 12 * 86400;
export const V6_DNS_SERVER_OPTION = 23;
export const V6_DOMAIN_SEARCH_OPTION = 24;
export const V6_UNICAST_OPTION = 12;
export const V6_INFORMATION_REFRESH_OPTION = 32;

interface ScopeRecord {
  prefix: string;
  name: string;
  description: string;
  active: boolean;
  preference: number;
  preferredLifetime: number;
  validLifetime: number;
  t1: number;
  t2: number;
  exclusions: Array<{ start: string; end: string }>;
  reservations: Array<{ address: string; clientDuid: string; iaid: number; name: string }>;
  options: Map<number, string[]>;
}

function canonicalPrefix(text: string): string | null {
  try { return new IPv6Address(text).getNetworkPrefix(64).toString(); } catch { return null; }
}

function normalizeDuid(text: string): string | null {
  const hex = text.replace(/[:.\-]/g, '').toLowerCase();
  if (hex.length < 4 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  return (hex.match(/../g) ?? []).join(':');
}

export class WindowsDhcpv6 {
  private readonly service: Dhcpv6HostService;
  private readonly scopes = new Map<string, ScopeRecord>();
  private readonly serverOptions = new Map<number, string[]>();

  constructor(host: EndHost, now: () => number) {
    this.service = new Dhcpv6HostService(dhcpv6PortOf(host), 'dhcpserver', now);
  }

  engine(): DHCPv6Server { return this.service.getEngine(); }

  start(): void { this.service.start(); }

  stop(): void { this.service.stop(); }

  isRunning(): boolean { return this.service.isRunning(); }

  reconfigure(clientDuid: string, msgType: 'RENEW' | 'REBIND' | 'INFORMATION-REQUEST'): boolean {
    return this.service.sendReconfigure(clientDuid, msgType);
  }

  private poolName(prefix: string): string { return `${prefix}/64`; }

  private view(record: ScopeRecord): DhcpV6ScopeInfo {
    return {
      prefix: record.prefix, name: record.name, description: record.description,
      state: record.active ? 'Active' : 'InActive', preference: record.preference,
      preferredLifetime: record.preferredLifetime, validLifetime: record.validLifetime,
      t1: record.t1, t2: record.t2,
    };
  }

  private apply(record: ScopeRecord): void {
    const engine = this.service.getEngine();
    const name = this.poolName(record.prefix);
    if (!record.active) { engine.deletePool(name); return; }
    if (!engine.getPool(name)) engine.createPool(name);
    engine.configurePoolPrefix(name, record.prefix, 64);
    engine.configurePoolLifetime(name, record.preferredLifetime, record.validLifetime);
    engine.configurePoolTimers(name, record.t1, record.t2);
    engine.configurePoolPreference(name, record.preference);
    engine.configurePoolExclusions(name, record.exclusions.map(range => ({ startIp: range.start, endIp: range.end })));
    const dns = record.options.get(V6_DNS_SERVER_OPTION) ?? this.serverOptions.get(V6_DNS_SERVER_OPTION) ?? [];
    const domains = record.options.get(V6_DOMAIN_SEARCH_OPTION) ?? this.serverOptions.get(V6_DOMAIN_SEARCH_OPTION) ?? [];
    engine.configurePoolDns(name, dns);
    if (domains[0]) engine.configurePoolDomain(name, domains[0]);
    const unicast = record.options.get(V6_UNICAST_OPTION) ?? this.serverOptions.get(V6_UNICAST_OPTION) ?? [];
    engine.configurePoolServerUnicast(name, unicast[0] ?? null);
    const refresh = record.options.get(V6_INFORMATION_REFRESH_OPTION) ?? this.serverOptions.get(V6_INFORMATION_REFRESH_OPTION);
    engine.configurePoolInformationRefresh(name, refresh ? Number(refresh[0]) : 86400);
    const pool = engine.getPool(name);
    if (pool) {
      pool.reservations = [];
      for (const r of record.reservations) {
        engine.configurePoolReservation(name, { address: r.address, clientDuid: r.clientDuid, iaid: r.iaid, name: r.name });
      }
      if (domains.length === 0) pool.domainName = null;
    }
  }

  private applyAll(): void {
    for (const record of this.scopes.values()) this.apply(record);
  }

  addScope(request: DhcpV6ScopeRequest): DhcpV6OpResult {
    const prefix = canonicalPrefix(request.prefix);
    if (!prefix) return { ok: false, message: `Cannot validate argument on parameter 'Prefix'. The prefix "${request.prefix}" is not a valid IPv6 prefix.` };
    if (this.scopes.has(prefix)) {
      return { ok: false, message: `Failed to add scope with prefix ${prefix}. The scope already exists on this DHCP server.` };
    }
    for (const other of this.scopes.values()) {
      if (other.name === request.name) return { ok: false, message: `A scope named "${request.name}" already exists on this DHCP server.` };
    }
    const preferred = request.preferredLifetime ?? V6_DEFAULT_PREFERRED;
    const valid = request.validLifetime ?? V6_DEFAULT_VALID;
    const t1 = request.t1 ?? Math.floor(preferred * 0.5);
    const t2 = request.t2 ?? Math.floor(preferred * 0.8);
    const rejected = this.lifetimeError(preferred, valid, t1, t2);
    if (rejected) return { ok: false, message: rejected };
    const record: ScopeRecord = {
      prefix, name: request.name, description: request.description ?? '',
      active: (request.state ?? 'Active') === 'Active', preference: request.preference ?? 0,
      preferredLifetime: preferred, validLifetime: valid, t1, t2,
      exclusions: [], reservations: [], options: new Map(),
    };
    this.scopes.set(prefix, record);
    this.apply(record);
    return { ok: true, message: '' };
  }

  private lifetimeError(preferred: number, valid: number, t1: number, t2: number): string | null {
    if (preferred > valid) return 'The preferred lifetime must not exceed the valid lifetime.';
    if (t1 > t2) return 'T1 must not exceed T2.';
    if (t2 > preferred) return 'T2 must not exceed the preferred lifetime.';
    return null;
  }

  private find(prefixOrName: string): ScopeRecord | null {
    const prefix = canonicalPrefix(prefixOrName);
    if (prefix && this.scopes.has(prefix)) return this.scopes.get(prefix)!;
    for (const record of this.scopes.values()) if (record.name === prefixOrName) return record;
    return null;
  }

  private missing(prefix: string): DhcpV6OpResult {
    return { ok: false, message: `The scope with prefix ${prefix} does not exist on the DHCP server.` };
  }

  getScope(prefix: string): DhcpV6ScopeInfo | null {
    const record = this.find(prefix);
    return record ? this.view(record) : null;
  }

  listScopes(): DhcpV6ScopeInfo[] {
    return [...this.scopes.values()].map(record => this.view(record));
  }

  setScope(prefix: string, changes: Partial<DhcpV6ScopeRequest> & { newName?: string }): DhcpV6OpResult {
    const record = this.find(prefix);
    if (!record) return this.missing(prefix);
    const preferred = changes.preferredLifetime ?? record.preferredLifetime;
    const valid = changes.validLifetime ?? record.validLifetime;
    const t1 = changes.t1 ?? (changes.preferredLifetime !== undefined ? Math.floor(preferred * 0.5) : record.t1);
    const t2 = changes.t2 ?? (changes.preferredLifetime !== undefined ? Math.floor(preferred * 0.8) : record.t2);
    const rejected = this.lifetimeError(preferred, valid, t1, t2);
    if (rejected) return { ok: false, message: rejected };
    record.preferredLifetime = preferred;
    record.validLifetime = valid;
    record.t1 = t1;
    record.t2 = t2;
    if (changes.newName) record.name = changes.newName;
    if (changes.description !== undefined) record.description = changes.description;
    if (changes.state) record.active = changes.state === 'Active';
    if (changes.preference !== undefined) record.preference = changes.preference;
    this.apply(record);
    return { ok: true, message: '' };
  }

  removeScope(prefix: string): DhcpV6OpResult {
    const record = this.find(prefix);
    if (!record) return this.missing(prefix);
    this.service.getEngine().deletePool(this.poolName(record.prefix));
    this.scopes.delete(record.prefix);
    return { ok: true, message: '' };
  }

  addExclusionRange(prefix: string, start: string, end: string): DhcpV6OpResult {
    const record = this.find(prefix);
    if (!record) return this.missing(prefix);
    let first: bigint;
    let last: bigint;
    try {
      first = ipv6ToBigInt(new IPv6Address(start));
      last = ipv6ToBigInt(new IPv6Address(end));
    } catch {
      return { ok: false, message: 'The exclusion range is not made of valid IPv6 addresses.' };
    }
    if (first > last) return { ok: false, message: 'The start of the exclusion range is greater than its end.' };
    const inside = (address: string) => new IPv6Address(address).isInSameSubnet(new IPv6Address(record.prefix), 64);
    if (!inside(start) || !inside(end)) return { ok: false, message: `The exclusion range is outside the scope ${record.prefix}.` };
    record.exclusions.push({ start: new IPv6Address(start).toString(), end: new IPv6Address(end).toString() });
    this.apply(record);
    return { ok: true, message: '' };
  }

  listExclusionRanges(prefix?: string): DhcpV6ExclusionInfo[] {
    const records = prefix ? [this.find(prefix)].filter((r): r is ScopeRecord => r !== null) : [...this.scopes.values()];
    return records.flatMap(record => record.exclusions.map(range => ({ prefix: record.prefix, startRange: range.start, endRange: range.end })));
  }

  addReservation(prefix: string, address: string, clientDuid: string, iaid: number, name: string): DhcpV6OpResult {
    const record = this.find(prefix);
    if (!record) return this.missing(prefix);
    const duid = normalizeDuid(clientDuid);
    if (!duid) return { ok: false, message: `Cannot validate argument on parameter 'ClientDuid'. "${clientDuid}" is not a valid DUID.` };
    let canonical: string;
    try { canonical = new IPv6Address(address).toString(); } catch {
      return { ok: false, message: `Cannot validate argument on parameter 'IPAddress'. "${address}" is not a valid IPv6 address.` };
    }
    if (!new IPv6Address(canonical).isInSameSubnet(new IPv6Address(record.prefix), 64)) {
      return { ok: false, message: `The reserved address ${canonical} is outside the scope ${record.prefix}.` };
    }
    if (record.reservations.some(r => r.address === canonical)) {
      return { ok: false, message: `The address ${canonical} is already reserved in this scope.` };
    }
    record.reservations.push({ address: canonical, clientDuid: duid, iaid, name });
    this.apply(record);
    return { ok: true, message: '' };
  }

  listReservations(prefix?: string): DhcpV6ReservationInfo[] {
    const records = prefix ? [this.find(prefix)].filter((r): r is ScopeRecord => r !== null) : [...this.scopes.values()];
    return records.flatMap(record => record.reservations.map(r => ({
      prefix: record.prefix, ipAddress: r.address, clientDuid: r.clientDuid, iaid: r.iaid, name: r.name,
    })));
  }

  removeReservation(prefix: string, address: string): DhcpV6OpResult {
    const record = this.find(prefix);
    if (!record) return this.missing(prefix);
    let canonical: string;
    try { canonical = new IPv6Address(address).toString(); } catch { return { ok: false, message: 'The address is not a valid IPv6 address.' }; }
    const before = record.reservations.length;
    record.reservations = record.reservations.filter(r => r.address !== canonical);
    if (record.reservations.length === before) return { ok: false, message: `No reservation exists for ${canonical} in scope ${record.prefix}.` };
    this.apply(record);
    return { ok: true, message: '' };
  }

  setOptionValue(prefix: string | undefined, optionId: number, values: string[]): DhcpV6OpResult {
    if (![V6_DNS_SERVER_OPTION, V6_DOMAIN_SEARCH_OPTION, V6_UNICAST_OPTION, V6_INFORMATION_REFRESH_OPTION].includes(optionId)) {
      return { ok: false, message: `Option ID ${optionId} is not supported.` };
    }
    if (optionId === V6_INFORMATION_REFRESH_OPTION && !(values.length === 1 && /^\d+$/.test(values[0]))) {
      return { ok: false, message: 'The Information Refresh Time is a number of seconds.' };
    }
    if (optionId === V6_DNS_SERVER_OPTION || optionId === V6_UNICAST_OPTION) {
      for (const value of values) {
        try { new IPv6Address(value); } catch { return { ok: false, message: `"${value}" is not a valid IPv6 address.` }; }
      }
    }
    if (prefix === undefined) {
      this.serverOptions.set(optionId, values);
      this.applyAll();
      return { ok: true, message: '' };
    }
    const record = this.find(prefix);
    if (!record) return this.missing(prefix);
    record.options.set(optionId, values);
    this.apply(record);
    return { ok: true, message: '' };
  }

  getOptionValues(prefix?: string): Array<{ optionId: number; name: string; value: string[]; prefix: string | null }> {
    const label = (id: number) => ({ [V6_DNS_SERVER_OPTION]: 'DNS Recursive Name Server', [V6_DOMAIN_SEARCH_OPTION]: 'Domain Search List', [V6_UNICAST_OPTION]: 'Unicast', [V6_INFORMATION_REFRESH_OPTION]: 'Information Refresh Time' } as Record<number, string>)[id] ?? String(id);
    if (prefix === undefined) {
      return [...this.serverOptions].map(([optionId, value]) => ({ optionId, name: label(optionId), value, prefix: null }));
    }
    const record = this.find(prefix);
    if (!record) return [];
    return [...record.options].map(([optionId, value]) => ({ optionId, name: label(optionId), value, prefix: record.prefix }));
  }

  getLeases(prefix?: string): DhcpV6LeaseInfo[] {
    const wanted = prefix ? this.find(prefix)?.prefix : undefined;
    return this.service.getEngine().getBindings().flatMap(binding => {
      const scope = [...this.scopes.values()].find(record => this.poolName(record.prefix) === binding.poolName);
      if (!scope || (wanted !== undefined && scope.prefix !== wanted)) return [];
      return [{
        ipAddress: binding.address, clientDuid: binding.clientDuid, iaid: binding.iaid,
        prefix: scope.prefix, leaseExpiration: binding.leaseExpiration,
      }];
    });
  }

  removeLease(address: string): DhcpV6OpResult {
    let canonical: string;
    try { canonical = new IPv6Address(address).toString(); } catch { return { ok: false, message: 'The address is not a valid IPv6 address.' }; }
    return this.service.getEngine().clearBinding(canonical)
      ? { ok: true, message: '' }
      : { ok: false, message: `The lease ${canonical} does not exist on this DHCP server.` };
  }
}
