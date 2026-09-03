/**
 * DHCPServer - DHCP Server Engine (RFC 2131, RFC 2132)
 *
 * Manages DHCP pools, address allocation, lease bindings,
 * statistics, and debug flags. Used by the Router class.
 *
 * RFC compliance:
 *   - Option 54: Server Identifier in OFFER/ACK/NAK
 *   - Pending offers: IP reserved between DISCOVER and REQUEST (RFC 2131 §3.1.2)
 *   - Excluded ranges checked in processRequest() (not just findAvailableIP)
 *   - MAC + IP validation on RELEASE (ciaddr + chaddr, RFC 2131 §3.4.4)
 *   - DHCPDECLINE processing with conflict recording (RFC 2131 §3.1.5)
 *   - Options 58/59: T1/T2 configurable per pool
 *   - XID echoed back in all responses
 *   - DHCPINFORM: Return configuration without lease (RFC 2131 §3.4.3)
 *   - Static bindings: Manual MAC → IP reservations
 *   - Conflict TTL: Conflicts expire after configurable time
 *   - Pool selection by giaddr: Relay agent selects correct pool
 *   - processRequestWithNak: Returns explicit NAK objects
 */

import { IPAddress } from '../core/types';
import { isValidIPv4 } from '../core/ip';
import {
  DHCPPoolConfig, DHCPExcludedRange, DHCPBinding, DHCPServerStats,
  DHCPConflict, DHCPDebugFlags, DHCPRelayConfig, DHCPPendingOffer,
  DHCPDiscoverParams, DHCPOfferResult, DHCPRequestParams, DHCPAckResult,
  DHCPReleaseParams, DHCPDeclineParams,
  DHCPInformParams, DHCPInformResult,
  DHCPRequestWithNakResult, DHCPStaticBinding,
  createDefaultPoolConfig, createDefaultStats,
} from './types';
import type { IProtocolEngine } from '../core/interfaces';
import { DHCP_CONSTANTS } from '../core/constants';
import { Logger } from '../core/Logger';
import { type IEventBus } from '@/events/EventBus';
import { BusHolder } from '@/events/BusHolder';
import {
  DHCPServerSignalStore,
  makeReadonlyDHCPServerObservables,
  type DHCPServerObservables,
  type DhcpServerLeaseVM,
} from './observables';
import { isDhcpOptionCode, dhcpOptionValueIsValid } from './optionSyntax';

/** Default pending offer timeout from centralized constants */
const PENDING_OFFER_TIMEOUT_MS = DHCP_CONSTANTS.PENDING_OFFER_TIMEOUT_MS;

export interface DhcpUtilizationCrossing {
  pool: string;
  crossing: 'high' | 'low';
  threshold: number;
  used: number;
  total: number;
  free: number;
}

export type DhcpUtilizationSink = (crossing: DhcpUtilizationCrossing) => void;

/** Default conflict TTL: infinite (0 = never expire) */
const DEFAULT_CONFLICT_TTL = 0;

function formatChaddr(mac: string | undefined): string {
  const hex = (mac ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase().padStart(12, '0').slice(-12);
  return `${hex.slice(0, 4)}.${hex.slice(4, 8)}.${hex.slice(8, 12)}`;
}

export type DhcpInterfaceMode = 'server' | 'relay' | 'none' | 'global' | 'interface';

export class DHCPServer implements IProtocolEngine {
  /** Service enabled flag */
  private enabled: boolean = true;

  /** Server's own IP address (Option 54: Server Identifier) */
  private serverIdentifier: string = '0.0.0.0';
  private serverOwnedAddresses: Set<string> = new Set();

  /** Named DHCP pools */
  private pools: Map<string, DHCPPoolConfig> = new Map();

  /** Excluded address ranges */
  private excludedRanges: DHCPExcludedRange[] = [];

  /** Active lease bindings: IP → binding */
  private bindings: Map<string, DHCPBinding> = new Map();

  /** Pending offers: IP → pending (reserved between DISCOVER and REQUEST) */
  private pendingOffers: Map<string, DHCPPendingOffer> = new Map();

  /**
   * clientId → the address it last held, kept even after the active
   * binding is deleted on RELEASE/expiry. Every real DHCP server
   * (including Cisco IOS's own pool database) re-offers a client its
   * previous address on its next DISCOVER when that address is still
   * free — RFC 2131 doesn't mandate it, but a plain `dhclient -r &&
   * dhclient` hopping to a different address with nothing else on the
   * network having claimed the old one is not how real DHCP behaves.
   */
  private releaseHistory: Map<string, { ip: string; poolName: string }> = new Map();

  /** `ip dhcp ping packets` (IOS default 2; `ip dhcp ping packets 0` disables the check) */
  private pingPacketCount = 2;
  /** `ip dhcp ping timeout` in milliseconds */
  private pingTimeoutMs = 500;

  /** Server statistics */
  private stats: DHCPServerStats = createDefaultStats();
  private relayStats = { forwarded: 0, repliesForwarded: 0, dropped: 0 };

  /** IP conflict database */
  private conflicts: DHCPConflict[] = [];
  private databaseAgents: string[] = [];

  /** Conflict TTL in seconds (0 = never expire) */
  private conflictTTL: number = DEFAULT_CONFLICT_TTL;

  /** Debug flags */
  private debug: DHCPDebugFlags = { serverPacket: false, serverEvents: false };

  /** DHCP relay configuration */
  private relay: DHCPRelayConfig = {
    helperAddresses: new Map(),
    forwardProtocols: new Set([67]), // bootps by default
  };

  /** Static bindings (manual reservations): poolName → bindings[] */
  private staticBindings: Map<string, DHCPStaticBinding[]> = new Map();

  // ─── Reactive plumbing (Phase 4b2-DHCP server) ─────────────────────
  private readonly busHolder = new BusHolder();
  private deviceId: string = '';
  private hostname: string = '';
  private readonly serverSignalStore = new DHCPServerSignalStore();
  /** Read-only observables (leases, stats). */
  readonly observables: DHCPServerObservables = makeReadonlyDHCPServerObservables(this.serverSignalStore);

  private utilizationSink: DhcpUtilizationSink | null = null;
  private readonly highUtilizationNotified: Set<string> = new Set();

  setEventBus(bus: IEventBus | null): void { this.busHolder.set(bus); }
  setUtilizationSink(sink: DhcpUtilizationSink | null): void { this.utilizationSink = sink; }
  setDeviceId(id: string, hostname?: string): void {
    this.deviceId = id;
    if (hostname !== undefined) this.hostname = hostname;
  }
  getDeviceId(): string { return this.deviceId; }
  private getBus(): IEventBus { return this.busHolder.get(); }
  private deviceRef() { return { deviceId: this.deviceId, hostname: this.hostname }; }

  /** Refresh server-side observables (called after every binding mutation). */
  private refreshServerSignals(): void {
    const out: DhcpServerLeaseVM[] = [];
    for (const [ip, b] of this.bindings) {
      out.push({
        pool: b.poolName,
        clientMac: b.clientId,
        ip,
        grantedAt: b.leaseStart,
        expiresAt: b.leaseExpiration,
      });
    }
    this.serverSignalStore.leases.set(out);
    this.serverSignalStore.stats.set({
      running: this.enabled,
      poolCount: this.pools.size,
      activeLeases: this.bindings.size,
      reservationsCount: Array.from(this.staticBindings.values()).reduce((s, arr) => s + arr.length, 0),
    });
    this.evaluateUtilizationMarks();
  }

  configurePoolUtilizationMark(
    name: string, kind: 'high' | 'low', percentage: number, log: boolean,
  ): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    if (!Number.isInteger(percentage)) return false;
    const floor = kind === 'high' ? 1 : 0;
    if (percentage < floor || percentage > 100) return false;
    if (kind === 'high') {
      pool.highUtilizationMark = percentage;
      pool.highUtilizationLog = log;
    } else {
      pool.lowUtilizationMark = percentage;
      pool.lowUtilizationLog = log;
    }
    this.highUtilizationNotified.delete(name);
    this.refreshServerSignals();
    return true;
  }

  resetPoolUtilizationMark(name: string, kind: 'high' | 'low'): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    if (kind === 'high') {
      pool.highUtilizationMark = 100;
      pool.highUtilizationLog = false;
    } else {
      pool.lowUtilizationMark = 0;
      pool.lowUtilizationLog = false;
    }
    this.highUtilizationNotified.delete(name);
    this.refreshServerSignals();
    return true;
  }

  poolLeasableTotal(pool: DHCPPoolConfig): number {
    return Math.max(0, this.countTotalAddresses(pool) - this.countExcludedForPool(pool));
  }

  poolUtilizationPercent(pool: DHCPPoolConfig): number {
    const total = this.poolLeasableTotal(pool);
    if (total === 0) return 0;
    return Math.floor((this.countBindingsForPool(pool.name) * 100) / total);
  }

  private evaluateUtilizationMarks(): void {
    for (const [name, pool] of this.pools) {
      const total = this.poolLeasableTotal(pool);
      if (total === 0) continue;
      const used = this.countBindingsForPool(name);
      const percent = Math.floor((used * 100) / total);
      const armed = this.highUtilizationNotified.has(name);
      if (!armed && percent >= pool.highUtilizationMark) {
        this.highUtilizationNotified.add(name);
        this.announceUtilization(pool, 'high', used, total);
      } else if (armed && percent <= pool.lowUtilizationMark) {
        this.highUtilizationNotified.delete(name);
        this.announceUtilization(pool, 'low', used, total);
      }
    }
  }

  private announceUtilization(
    pool: DHCPPoolConfig, crossing: 'high' | 'low', used: number, total: number,
  ): void {
    const threshold = crossing === 'high' ? pool.highUtilizationMark : pool.lowUtilizationMark;
    const free = Math.max(0, total - used);
    this.getBus().publish({
      topic: 'dhcp.pool.utilization',
      payload: { ...this.deviceRef(), pool: pool.name, crossing, threshold, used, total, free },
    });
    const wantsLog = crossing === 'high' ? pool.highUtilizationLog : pool.lowUtilizationLog;
    if (wantsLog) {
      Logger.info(this.deviceId, `dhcpd:${crossing}-util`,
        `Pool '${pool.name}' is in ${crossing} utilization state (${used} addresses used out of ${total})`);
    }
    this.utilizationSink?.({ pool: pool.name, crossing, threshold, used, total, free });
  }

  // ─── IProtocolEngine ─────────────────────────────────────────────

  start(): void {
    this.enabled = true;
    this.refreshServerSignals();
    this.getBus().publish({
      topic: 'dhcp.engine.started',
      payload: { ...this.deviceRef(), role: 'server' },
    });
  }
  stop(): void {
    this.enabled = false;
    this.refreshServerSignals();
    this.getBus().publish({
      topic: 'dhcp.engine.stopped',
      payload: { ...this.deviceRef(), role: 'server' },
    });
  }
  isRunning(): boolean { return this.enabled; }

  // ─── Service Control (legacy aliases) ──────────────────────────

  enable(): void { this.enabled = true; }
  disable(): void { this.enabled = false; }
  isEnabled(): boolean { return this.enabled; }

  /** Set the server's own IP (used as Option 54: Server Identifier) */
  setServerIdentifier(ip: string): void { this.serverIdentifier = ip; }
  getServerIdentifier(): string { return this.serverIdentifier; }

  /**
   * Option 54 value for a response. When no explicit server identifier was
   * configured, fall back to the serving subnet's gateway — for a router
   * acting as DHCP server this is its own interface address on that subnet.
   */
  private resolveServerId(pool?: DHCPPoolConfig | null): string {
    if (this.serverIdentifier && this.serverIdentifier !== '0.0.0.0') return this.serverIdentifier;
    const gw = pool?.defaultRouter;
    if (gw && gw !== '0.0.0.0') return gw;
    return this.serverIdentifier;
  }

  private findPoolForIP(ip: string | undefined): DHCPPoolConfig | null {
    if (!ip) return null;
    for (const [, pool] of this.pools) {
      if (pool.network && pool.mask && this.isIPInPool(ip, pool)) return pool;
    }
    return null;
  }

  /**
   * RFC 2131 §3.1: a client echoes the selected server's Option 54 in its
   * REQUEST. Accept it when it matches our configured identifier or any pool
   * gateway we advertise (so the response and validation stay consistent).
   */
  private isOurServerId(id: string | undefined): boolean {
    if (!id || id === '0.0.0.0') return true;
    if (id === this.serverIdentifier) return true;
    for (const [, pool] of this.pools) {
      if (pool.defaultRouter && pool.defaultRouter === id) return true;
    }
    return false;
  }

  // ─── Pool Management ──────────────────────────────────────────────

  createPool(name: string): DHCPPoolConfig {
    const pool = createDefaultPoolConfig(name);
    this.pools.set(name, pool);
    return pool;
  }

  getPool(name: string): DHCPPoolConfig | undefined {
    return this.pools.get(name);
  }

  deletePool(name: string): boolean {
    this.highUtilizationNotified.delete(name);
    return this.pools.delete(name);
  }

  getAllPools(): Map<string, DHCPPoolConfig> {
    return this.pools;
  }

  configurePoolNetwork(name: string, network: string, mask: string): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    if (!this.isValidIPv4(network) || !this.isValidIPv4(mask)) return false;
    pool.network = network;
    pool.mask = mask;
    return true;
  }

  configurePoolRouter(name: string, router: string | string[]): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    const routers = Array.isArray(router) ? router : [router];
    pool.defaultRouters = routers;
    pool.defaultRouter = routers[0] ?? null;
    return true;
  }

  configurePoolDNS(name: string, servers: string[]): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    pool.dnsServers = servers;
    return true;
  }

  configurePoolDomain(name: string, domain: string): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    pool.domainName = domain;
    return true;
  }

  configurePoolLease(name: string, durationSeconds: number): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    pool.leaseDuration = durationSeconds;
    return true;
  }

  /** Configure Option 58: T1 renewal time for a pool */
  configurePoolRenewalTime(name: string, seconds: number): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    pool.renewalTime = seconds;
    return true;
  }

  /** Configure Option 59: T2 rebinding time for a pool */
  configurePoolRebindingTime(name: string, seconds: number): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    pool.rebindingTime = seconds;
    return true;
  }

  addDenyPattern(name: string, pattern: string): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    pool.denyPatterns.push(pattern);
    return true;
  }

  configurePoolNextServer(name: string, ip: string): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    pool.nextServer = ip;
    return true;
  }

  configurePoolBootfile(name: string, file: string): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    pool.bootfile = file;
    return true;
  }

  configurePoolNetbios(name: string, servers: string[]): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    pool.netbiosServers = servers;
    return true;
  }

  configurePoolNetbiosNodeType(name: string, nodeType: string): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    pool.netbiosNodeType = nodeType;
    return true;
  }

  configurePoolLeaseInfinite(name: string): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    pool.leaseInfinite = true;
    return true;
  }

  configurePoolOption(
    name: string, code: number, kind: 'ip' | 'ascii' | 'hex', value: string,
  ): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    if (!isDhcpOptionCode(code) || !dhcpOptionValueIsValid(kind, value)) return false;
    (pool.options ??= []).push({ code, kind, value });
    return true;
  }

  /** Pool name already holding `ip` as a static reservation (`host` or `static-bind`), if any other than `excludePool`. */
  private findReservedIPConflict(ip: string, excludePool: string): string | null {
    for (const [name, pool] of this.pools) {
      if (name !== excludePool && pool.manual?.host === ip) return name;
    }
    for (const [name, bindings] of this.staticBindings) {
      if (name === excludePool) continue;
      if (bindings.some(b => b.ipAddress === ip)) return name;
    }
    return null;
  }

  configurePoolManual(
    name: string, field: keyof NonNullable<DHCPPoolConfig['manual']>,
    value: string, mask?: string,
  ): { ok: boolean; error?: string } {
    const pool = this.pools.get(name);
    if (!pool) return { ok: false, error: `pool ${name} does not exist` };
    if (field === 'host') {
      const conflictPool = this.findReservedIPConflict(value, name);
      if (conflictPool) {
        return { ok: false, error: `IP address ${value} is already reserved in DHCP pool ${conflictPool}` };
      }
    }
    pool.manual ??= {};
    pool.manual[field] = value;
    if (field === 'host' && mask) pool.manual.hostMask = mask;
    return { ok: true };
  }

  isPoolComplete(name: string): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    return pool.network !== null && pool.mask !== null;
  }

  // ─── Excluded Addresses ───────────────────────────────────────────

  addExcludedRange(start: string, end: string): boolean {
    if (!isValidIPv4(start) || !isValidIPv4(end)) return false;
    this.excludedRanges.push({ start, end });
    return true;
  }

  removeExcludedRange(start: string, end: string): boolean {
    const before = this.excludedRanges.length;
    this.excludedRanges = this.excludedRanges.filter(r => !(r.start === start && r.end === end));
    return this.excludedRanges.length < before;
  }

  setPoolActive(name: string, active: boolean): boolean {
    const pool = this.getPool(name);
    if (!pool) return false;
    pool.active = active;
    return true;
  }

  getExcludedRanges(): DHCPExcludedRange[] {
    return [...this.excludedRanges];
  }

  setServerOwnedAddresses(ips: string[]): void {
    this.serverOwnedAddresses = new Set(ips.filter(ip => ip && ip !== '0.0.0.0'));
  }

  getServerOwnedAddresses(): string[] {
    return [...this.serverOwnedAddresses];
  }

  private isExcluded(ip: string): boolean {
    if (this.serverOwnedAddresses.has(ip)) return true;
    const ipNum = this.ipToNumber(ip);
    for (const range of this.excludedRanges) {
      const startNum = this.ipToNumber(range.start);
      const endNum = this.ipToNumber(range.end);
      if (ipNum >= startNum && ipNum <= endNum) return true;
    }
    return false;
  }

  // ─── Static Bindings (Manual Reservations) ─────────────────────────

  /** Add a static MAC → IP binding to a pool */
  addStaticBinding(poolName: string, clientMAC: string, ipAddress: string): { ok: boolean; error?: string } {
    const existing = this.staticBindings.get(poolName) || [];
    const already = existing.find(b => b.ipAddress === ipAddress);
    if (already && already.clientId.toLowerCase() !== clientMAC.toLowerCase()) {
      return { ok: false, error: `IP address ${ipAddress} is already bound to ${already.clientId} in this pool` };
    }
    if (!already) {
      const conflictPool = this.findReservedIPConflict(ipAddress, poolName);
      if (conflictPool) {
        return { ok: false, error: `IP address ${ipAddress} is already reserved in DHCP pool ${conflictPool}` };
      }
      existing.push({
        clientId: clientMAC,
        ipAddress,
        poolName,
        type: 'manual',
      });
      this.staticBindings.set(poolName, existing);
    }
    return { ok: true };
  }

  /** Is this address reserved for this very client, in any pool? */
  private isReservedFor(clientMAC: string, ipAddress: string): boolean {
    const mac = clientMAC.toLowerCase();
    for (const bindings of this.staticBindings.values()) {
      if (bindings.some(binding => binding.ipAddress === ipAddress
        && binding.clientId.toLowerCase() === mac)) return true;
    }
    return false;
  }

  /** Get all static bindings for a pool */
  getStaticBindings(poolName: string): DHCPStaticBinding[] {
    return this.staticBindings.get(poolName) || [];
  }

  /** Remove a static binding by IP (or all in the pool when no IP given) */
  removeStaticBinding(poolName: string, ipAddress?: string): boolean {
    const existing = this.staticBindings.get(poolName);
    if (!existing) return false;
    if (!ipAddress) {
      this.staticBindings.delete(poolName);
      return true;
    }
    const kept = existing.filter(b => b.ipAddress !== ipAddress);
    if (kept.length === existing.length) return false;
    this.staticBindings.set(poolName, kept);
    return true;
  }

  /** Find static binding for a client MAC in a specific pool */
  private findStaticBinding(clientMAC: string, poolName: string): DHCPStaticBinding | null {
    const bindings = this.staticBindings.get(poolName) || [];
    const mac = clientMAC.toLowerCase();
    return bindings.find(b => b.clientId.toLowerCase() === mac) || null;
  }

  // ─── Address Allocation (DORA Server-Side) ────────────────────────

  /**
   * Process a DHCPDISCOVER and return an offer IP.
   * RFC 2131 §3.1.2: The server reserves the offered address until the client responds.
   *
   * Accepts either the new DHCPDiscoverParams or legacy (clientMAC: string) for backward compat.
   */
  processDiscover(paramsOrMAC: DHCPDiscoverParams | string): DHCPOfferResult | null {
    const dbgMac = typeof paramsOrMAC === 'string' ? paramsOrMAC : paramsOrMAC.clientMAC;
    const dbgXid = typeof paramsOrMAC === 'string' ? 0 : paramsOrMAC.xid;
    const dbgGiaddr = typeof paramsOrMAC === 'string' ? undefined : paramsOrMAC.giaddr;
    this.debugEvent(`DHCPDISCOVER from ${formatChaddr(dbgMac)} through ${dbgGiaddr ?? 'relay not used'}`);
    this.debugPacket('BOOTREQUEST', { xid: dbgXid, chaddr: formatChaddr(dbgMac), giaddr: dbgGiaddr });
    const dbgOffer = this.processDiscoverInternal(paramsOrMAC);
    if (dbgOffer) {
      this.debugEvent(`DHCPOFFER on interface, offering ${dbgOffer.ip} to ${formatChaddr(dbgMac)}`);
      this.debugPacket('BOOTREPLY', { xid: dbgOffer.xid, chaddr: formatChaddr(dbgMac), yiaddr: dbgOffer.ip, giaddr: dbgGiaddr });
    }
    return dbgOffer;
  }

  private processDiscoverInternal(paramsOrMAC: DHCPDiscoverParams | string): DHCPOfferResult | null {
    this.stats.discovers++;
    if (!this.enabled) return null;

    // Normalize params (backward compat)
    const params: DHCPDiscoverParams = typeof paramsOrMAC === 'string'
      ? { clientMAC: paramsOrMAC, xid: 0, clientIdentifier: '01' + paramsOrMAC.replace(/:/g, ''), parameterRequestList: [] }
      : paramsOrMAC;

    // Clean expired pending offers
    this.cleanExpiredPendingOffers();

    // Subnet anchor for pool selection: giaddr when relayed, otherwise the
    // local ingress interface's own IP for a directly-attached client.
    const subnetAnchor = params.giaddr ?? params.localGatewayIP;
    const poolEntries = this.getPoolsForDiscover(subnetAnchor);

    for (const pool of poolEntries) {
      if (!pool.network || !pool.mask) continue;
      if (pool.active === false) continue;

      // Only consider pools whose subnet actually contains the anchor.
      if (subnetAnchor && !this.isIPInPool(subnetAnchor, pool)) continue;

      // Check deny patterns
      if (this.isClientDenied(params.clientMAC, pool)) continue;

      // Check static binding first — preferred IP for this client
      const staticBinding = this.findStaticBinding(params.clientMAC, pool.name);
      if (staticBinding) {
        // Check if the static IP is already bound to someone else
        const existing = this.bindings.get(staticBinding.ipAddress);
        if (!existing || existing.clientId === params.clientMAC) {
          this.stats.offers++;
          return {
            ip: staticBinding.ipAddress,
            pool,
            serverIdentifier: this.resolveServerId(pool),
            xid: params.xid,
            renewalTime: pool.renewalTime,
            rebindingTime: pool.rebindingTime,
          };
        }
      }

      // Check existing binding — prefer re-offering the same IP
      for (const [ip, binding] of this.bindings) {
        if (binding.clientId === params.clientMAC && binding.poolName === pool.name) {
          this.stats.offers++;
          return {
            ip,
            pool,
            serverIdentifier: this.resolveServerId(pool),
            xid: params.xid,
            renewalTime: pool.renewalTime,
            rebindingTime: pool.rebindingTime,
          };
        }
      }

      // Check if we already have a pending offer for this client
      for (const [ip, pending] of this.pendingOffers) {
        if (pending.clientMAC === params.clientMAC && pending.poolName === pool.name) {
          this.stats.offers++;
          return {
            ip,
            pool,
            serverIdentifier: this.resolveServerId(pool),
            xid: params.xid,
            renewalTime: pool.renewalTime,
            rebindingTime: pool.rebindingTime,
          };
        }
      }

      // Prefer re-offering the address this client held before its lease
      // was released or expired (see releaseHistory's own doc comment),
      // as long as nothing else has claimed it since.
      const history = this.releaseHistory.get(params.clientMAC);
      if (history && history.poolName === pool.name
        && !this.bindings.has(history.ip) && !this.pendingOffers.has(history.ip)
        && !this.isExcluded(history.ip) && !this.isConflicted(history.ip)) {
        this.stats.offers++;
        return {
          ip: history.ip,
          pool,
          serverIdentifier: this.resolveServerId(pool),
          xid: params.xid,
          renewalTime: pool.renewalTime,
          rebindingTime: pool.rebindingTime,
        };
      }

      // Allocate a new IP and create a pending offer
      const ip = this.findAvailableIP(pool, params.clientMAC);
      if (!ip) {
        // Real IOS/VRP raise a log/trap on pool exhaustion; a silent
        // null left operators discovering it from user complaints.
        this.getBus().publish({
          topic: 'dhcp.pool.exhausted',
          payload: {
            ...this.deviceRef(),
            pool: pool.name,
            network: pool.network,
            clientMac: String(params.clientMAC),
          },
        });
        Logger.warn(this.deviceId, 'dhcp:pool-exhausted',
          `${this.hostname}: DHCP pool '${pool.name}' exhausted — no free address for ${params.clientMAC}`);
      }
      if (ip) {
        // Reserve the IP (RFC 2131 §3.1.2)
        this.pendingOffers.set(ip, {
          ip,
          clientMAC: params.clientMAC,
          poolName: pool.name,
          expiresAt: Date.now() + PENDING_OFFER_TIMEOUT_MS,
        });

        this.stats.offers++;
        return {
          ip,
          pool,
          serverIdentifier: this.resolveServerId(pool),
          xid: params.xid,
          renewalTime: pool.renewalTime,
          rebindingTime: pool.rebindingTime,
        };
      }
    }

    return null;
  }

  /**
   * Process a DHCPREQUEST and create/renew binding.
   * RFC 2131 §3.1.3: Validates requested IP against excluded ranges and server identifier.
   *
   * Accepts either the new DHCPRequestParams or legacy (clientMAC, requestedIP) for backward compat.
   */
  processRequest(paramsOrMAC: DHCPRequestParams | string, legacyRequestedIP?: string): DHCPAckResult | null {
    const dbgMac = typeof paramsOrMAC === 'string' ? paramsOrMAC : paramsOrMAC.clientMAC;
    const dbgXid = typeof paramsOrMAC === 'string' ? 0 : paramsOrMAC.xid;
    const dbgReq = typeof paramsOrMAC === 'string' ? legacyRequestedIP : paramsOrMAC.requestedIP;
    this.debugEvent(`DHCPREQUEST received from client ${formatChaddr(dbgMac)} for ${dbgReq ?? '0.0.0.0'}`);
    this.debugPacket('BOOTREQUEST', { xid: dbgXid, chaddr: formatChaddr(dbgMac), ciaddr: dbgReq });
    const dbgAck = this.processRequestInternal(paramsOrMAC, legacyRequestedIP);
    if (dbgAck) {
      this.traceAck(dbgMac, dbgAck.xid, dbgAck.binding?.ipAddress ?? dbgReq);
    } else {
      this.debugEvent(`DHCPNAK sent to client ${formatChaddr(dbgMac)}`);
    }
    return dbgAck;
  }

  private processRequestInternal(paramsOrMAC: DHCPRequestParams | string, legacyRequestedIP?: string): DHCPAckResult | null {
    if (!this.enabled) return null;

    // Normalize params (backward compat)
    const params: DHCPRequestParams = typeof paramsOrMAC === 'string'
      ? {
          clientMAC: paramsOrMAC,
          xid: 0,
          requestedIP: legacyRequestedIP!,
          clientIdentifier: '01' + paramsOrMAC.replace(/:/g, ''),
        }
      : paramsOrMAC;

    // If server identifier is specified (SELECTING state), verify it matches us
    // Do NOT count requests destined for other servers (BUG FIX: no more stats.requests--)
    if (!this.isOurServerId(params.serverIdentifier)) {
      return null;
    }

    // Count this as our request only after verifying it's for us
    this.stats.requests++;

    // RFC compliance: Check if the requested IP is in an excluded range
    if (this.isExcluded(params.requestedIP)
      && !this.isReservedFor(params.clientMAC, params.requestedIP)) {
      this.stats.naks++;
      return null;
    }

    // Check for conflicts
    if (this.isConflicted(params.requestedIP)) {
      this.stats.naks++;
      return null;
    }

    // Find pool for this IP
    for (const [, pool] of this.pools) {
      if (!pool.network || !pool.mask) continue;
      if (!this.isIPInPool(params.requestedIP, pool)) continue;

      if (this.isClientDenied(params.clientMAC, pool)) {
        this.stats.naks++;
        return null;
      }

      // Check that no other client holds this IP
      const existingBinding = this.bindings.get(params.requestedIP);
      if (existingBinding && existingBinding.clientId !== params.clientMAC) {
        this.stats.naks++;
        return null;
      }

      // Remove pending offer (if any)
      this.pendingOffers.delete(params.requestedIP);

      const binding: DHCPBinding = {
        ipAddress: params.requestedIP,
        clientId: params.clientMAC,
        leaseStart: Date.now(),
        leaseExpiration: Date.now() + pool.leaseDuration * 1000,
        poolName: pool.name,
        type: 'automatic',
      };

      this.bindings.set(params.requestedIP, binding);
      this.stats.acks++;
      this.getBus().publish({
        topic: 'dhcp.pool.lease-allocated',
        payload: {
          ...this.deviceRef(),
          pool: pool.name,
          clientMac: params.clientMAC,
          ip: params.requestedIP,
          leaseTimeSec: pool.leaseDuration,
        },
      });
      this.refreshServerSignals();

      return {
        binding,
        serverIdentifier: this.resolveServerId(pool),
        xid: params.xid,
        renewalTime: pool.renewalTime,
        rebindingTime: pool.rebindingTime,
      };
    }

    this.stats.naks++;
    return null;
  }

  /**
   * Process a DHCPREQUEST and return an explicit ACK or NAK result.
   * Unlike processRequest(), this returns a typed result indicating
   * whether the response is ACK or NAK, rather than using null for NAK.
   */
  private traceAck(mac: string, xid: number, ip: string | undefined): void {
    const adresse = ip ?? '0.0.0.0';
    this.debugEvent(`DHCPACK sent to client ${formatChaddr(mac)} for ${adresse}`);
    this.debugPacket('BOOTREPLY', { xid, chaddr: formatChaddr(mac), yiaddr: adresse });
  }

  processRequestWithNak(paramsOrMAC: DHCPRequestParams | string, legacyRequestedIP?: string): DHCPRequestWithNakResult | null {
    const dbgMac = typeof paramsOrMAC === 'string' ? paramsOrMAC : paramsOrMAC.clientMAC;
    const dbgXid = typeof paramsOrMAC === 'string' ? 0 : paramsOrMAC.xid;
    const dbgReq = typeof paramsOrMAC === 'string' ? legacyRequestedIP : paramsOrMAC.requestedIP;
    this.debugEvent(`DHCPREQUEST received from client ${formatChaddr(dbgMac)} for ${dbgReq ?? '0.0.0.0'}`);
    this.debugPacket('BOOTREQUEST', { xid: dbgXid, chaddr: formatChaddr(dbgMac), ciaddr: dbgReq });
    const dbgRes = this.processRequestWithNakInternal(paramsOrMAC, legacyRequestedIP);
    if (dbgRes && dbgRes.type === 'ACK') {
      this.traceAck(dbgMac, dbgRes.xid, dbgRes.binding?.ipAddress ?? dbgReq);
    } else if (dbgRes && dbgRes.type === 'NAK') {
      this.debugEvent(`DHCPNAK sent to client ${formatChaddr(dbgMac)}`);
      this.debugPacket('BOOTREPLY', { xid: dbgRes.xid, chaddr: formatChaddr(dbgMac) });
    }
    return dbgRes;
  }

  private processRequestWithNakInternal(paramsOrMAC: DHCPRequestParams | string, legacyRequestedIP?: string): DHCPRequestWithNakResult | null {
    if (!this.enabled) return null;

    // Normalize params
    const params: DHCPRequestParams = typeof paramsOrMAC === 'string'
      ? {
          clientMAC: paramsOrMAC,
          xid: 0,
          requestedIP: legacyRequestedIP!,
          clientIdentifier: '01' + paramsOrMAC.replace(/:/g, ''),
        }
      : paramsOrMAC;

    // If server identifier is specified, verify it matches us
    if (!this.isOurServerId(params.serverIdentifier)) {
      return null; // Not for us, don't count
    }

    this.stats.requests++;

    // Check excluded
    if (this.isExcluded(params.requestedIP)
      && !this.isReservedFor(params.clientMAC, params.requestedIP)) {
      this.stats.naks++;
      return {
        type: 'NAK',
        serverIdentifier: this.resolveServerId(this.findPoolForIP(params.requestedIP)),
        xid: params.xid,
        message: `Requested address ${params.requestedIP} is in excluded range`,
      };
    }

    // Check conflicts
    if (this.isConflicted(params.requestedIP)) {
      this.stats.naks++;
      return {
        type: 'NAK',
        serverIdentifier: this.resolveServerId(this.findPoolForIP(params.requestedIP)),
        xid: params.xid,
        message: `Requested address ${params.requestedIP} has a conflict`,
      };
    }

    // Find pool
    for (const [, pool] of this.pools) {
      if (!pool.network || !pool.mask) continue;
      if (!this.isIPInPool(params.requestedIP, pool)) continue;

      if (this.isClientDenied(params.clientMAC, pool)) {
        this.stats.naks++;
        return {
          type: 'NAK',
          serverIdentifier: this.resolveServerId(pool),
          xid: params.xid,
          message: `Client ${params.clientMAC} denied by pool policy`,
        };
      }

      const existingBinding = this.bindings.get(params.requestedIP);
      if (existingBinding && existingBinding.clientId !== params.clientMAC) {
        this.stats.naks++;
        return {
          type: 'NAK',
          serverIdentifier: this.resolveServerId(pool),
          xid: params.xid,
          message: `Requested address ${params.requestedIP} already bound to another client`,
        };
      }

      this.pendingOffers.delete(params.requestedIP);

      const binding: DHCPBinding = {
        ipAddress: params.requestedIP,
        clientId: params.clientMAC,
        leaseStart: Date.now(),
        leaseExpiration: Date.now() + pool.leaseDuration * 1000,
        poolName: pool.name,
        type: 'automatic',
      };

      this.bindings.set(params.requestedIP, binding);
      this.stats.acks++;
      this.getBus().publish({
        topic: 'dhcp.pool.lease-allocated',
        payload: {
          ...this.deviceRef(),
          pool: pool.name,
          clientMac: params.clientMAC,
          ip: params.requestedIP,
          leaseTimeSec: pool.leaseDuration,
        },
      });
      this.refreshServerSignals();

      return {
        type: 'ACK',
        binding,
        serverIdentifier: this.resolveServerId(pool),
        xid: params.xid,
        renewalTime: pool.renewalTime,
        rebindingTime: pool.rebindingTime,
      };
    }

    this.stats.naks++;
    return {
      type: 'NAK',
      serverIdentifier: this.serverIdentifier,
      xid: params.xid,
      message: `Requested address ${params.requestedIP} not in any pool`,
    };
  }

  /**
   * Process DHCPRELEASE - remove binding.
   * RFC 2131 §3.4.4: Validates both MAC and IP (ciaddr) match the binding.
   *
   * Accepts either the new DHCPReleaseParams or legacy (clientMAC: string) for backward compat.
   */
  processRelease(paramsOrMAC: DHCPReleaseParams | string): void {
    this.stats.releases++;

    if (typeof paramsOrMAC === 'string') {
      // Legacy: remove first binding matching MAC
      for (const [ip, binding] of this.bindings) {
        if (binding.clientId === paramsOrMAC) {
          this.bindings.delete(ip);
          this.releaseHistory.set(binding.clientId, { ip, poolName: binding.poolName });
          this.getBus().publish({
            topic: 'dhcp.pool.lease-released',
            payload: { ...this.deviceRef(), pool: binding.poolName, ip, reason: 'client-release' },
          });
          this.refreshServerSignals();
          return;
        }
      }
      return;
    }

    // RFC-compliant: validate both MAC and IP
    const params = paramsOrMAC;
    const binding = this.bindings.get(params.clientIP);
    if (!binding) return;

    // Validate that the releasing client actually owns this binding
    if (binding.clientId !== params.clientMAC) return;

    this.bindings.delete(params.clientIP);
    this.releaseHistory.set(binding.clientId, { ip: params.clientIP, poolName: binding.poolName });
    this.getBus().publish({
      topic: 'dhcp.pool.lease-released',
      payload: { ...this.deviceRef(), pool: binding.poolName, ip: params.clientIP, reason: 'client-release' },
    });
    this.refreshServerSignals();
  }

  /**
   * Process DHCPDECLINE — client detected address conflict after ACK.
   * RFC 2131 §3.1.5: Server records conflict and removes binding.
   */
  processDecline(params: DHCPDeclineParams): void {
    this.stats.declines++;

    // Record the conflict
    this.conflicts.push({
      ipAddress: params.declinedIP,
      detectionMethod: 'DHCP Decline',
      detectionTime: Date.now(),
    });

    // Remove the binding
    const binding = this.bindings.get(params.declinedIP);
    if (binding && binding.clientId === params.clientMAC) {
      this.bindings.delete(params.declinedIP);
      this.getBus().publish({
        topic: 'dhcp.pool.lease-released',
        payload: { ...this.deviceRef(), pool: binding.poolName, ip: params.declinedIP, reason: 'declined' },
      });
      this.refreshServerSignals();
    }

    // Remove any pending offer
    this.pendingOffers.delete(params.declinedIP);
  }

  /**
   * Process DHCPINFORM — client requests configuration without lease.
   * RFC 2131 §3.4.3: Server replies with DHCPACK containing configuration
   * parameters but no lease binding.
   */
  processInform(params: DHCPInformParams): DHCPInformResult | null {
    this.stats.informs++;

    // Find pool that contains the client's IP
    for (const [, pool] of this.pools) {
      if (!pool.network || !pool.mask) continue;
      if (!this.isIPInPool(params.clientIP, pool)) continue;

      return {
        serverIdentifier: this.resolveServerId(pool),
        xid: params.xid,
        mask: pool.mask,
        router: pool.defaultRouter,
        dnsServers: pool.dnsServers,
        domainName: pool.domainName,
      };
    }

    return null;
  }

  // ─── Lease Bindings ───────────────────────────────────────────────

  getBindings(): Map<string, DHCPBinding> {
    return this.bindings;
  }

  clearBindings(): void {
    this.bindings.clear();
    this.refreshServerSignals();
  }

  clearBinding(ip: string): boolean {
    const removed = this.bindings.delete(ip);
    if (removed) this.refreshServerSignals();
    return removed;
  }

  /** Remove bindings whose lease has expired */
  cleanExpiredBindings(): void {
    const now = Date.now();
    let removed = false;
    for (const [ip, binding] of this.bindings) {
      if (binding.leaseExpiration <= now) {
        this.bindings.delete(ip);
        removed = true;
      }
    }
    if (removed) this.refreshServerSignals();
  }

  // ─── Statistics ───────────────────────────────────────────────────

  getStats(): DHCPServerStats {
    return { ...this.stats };
  }

  clearStats(): void {
    this.stats = createDefaultStats();
    this.relayStats = { forwarded: 0, repliesForwarded: 0, dropped: 0 };
  }

  countRelayForward(): void { this.relayStats.forwarded++; }
  countRelayReply(): void { this.relayStats.repliesForwarded++; }
  countRelayDrop(): void { this.relayStats.dropped++; }
  getRelayStats(): Readonly<{ forwarded: number; repliesForwarded: number; dropped: number }> {
    return { ...this.relayStats };
  }

  // ─── Ping-before-offer (`ip dhcp ping packets`/`ip dhcp ping timeout`) ──

  setPingPacketCount(n: number): void { this.pingPacketCount = n; }
  getPingPacketCount(): number { return this.pingPacketCount; }
  setPingTimeoutMs(ms: number): void { this.pingTimeoutMs = ms; }
  getPingTimeoutMs(): number { return this.pingTimeoutMs; }

  /** Release a candidate reserved by processDiscover so a retry can pick a different address. */
  cancelPendingOffer(ip: string): void {
    this.pendingOffers.delete(ip);
  }

  // ─── Conflicts ────────────────────────────────────────────────────

  getConflicts(): DHCPConflict[] {
    return this.conflicts;
  }

  clearConflicts(): void {
    this.conflicts = [];
  }

  /** Record a conflict detected by the server (e.g., via ping/ARP before offering) */
  addConflict(ip: string, method: string): void {
    this.conflicts.push({
      ipAddress: ip,
      detectionMethod: method,
      detectionTime: Date.now(),
    });
  }

  /** Set the TTL for conflict entries in seconds (0 = never expire) */
  setConflictTTL(seconds: number): void {
    this.conflictTTL = seconds;
  }

  /** Remove conflicts that have exceeded their TTL */
  cleanExpiredConflicts(): void {
    if (this.conflictTTL <= 0) return; // No expiration
    const now = Date.now();
    const ttlMs = this.conflictTTL * 1000;
    this.conflicts = this.conflicts.filter(c => (now - c.detectionTime) < ttlMs);
  }

  /** Test helper: set detection time for a specific conflict */
  setConflictTimeForTest(ip: string, time: number): void {
    const conflict = this.conflicts.find(c => c.ipAddress === ip);
    if (conflict) {
      conflict.detectionTime = time;
    }
  }

  private isConflicted(ip: string): boolean {
    return this.conflicts.some(c => c.ipAddress === ip);
  }

  // ─── Debug ────────────────────────────────────────────────────────

  getDebugFlags(): DHCPDebugFlags {
    return { ...this.debug };
  }

  setDebugServerPacket(on: boolean): void {
    this.debug.serverPacket = on;
  }

  setDebugServerEvents(on: boolean): void {
    this.debug.serverEvents = on;
  }

  private debugEmitFn?: (line: string) => void;
  setDebugEmitter(fn: (line: string) => void): void { this.debugEmitFn = fn; }

  private debugEvent(line: string): void {
    if (!this.debug.serverEvents) return;
    this.debugEmitFn?.(`DHCPD: ${line}`);
  }

  private debugPacket(kind: string, fields: { xid?: number; chaddr?: string; ciaddr?: string; yiaddr?: string; giaddr?: string }): void {
    if (!this.debug.serverPacket) return;
    const parts = [
      `xid ${(fields.xid ?? 0).toString(16).toUpperCase()}`,
      `chaddr ${fields.chaddr ?? '0000.0000.0000'}`,
      `ciaddr ${fields.ciaddr ?? '0.0.0.0'}`,
      `yiaddr ${fields.yiaddr ?? '0.0.0.0'}`,
      `giaddr ${fields.giaddr ?? '0.0.0.0'}`,
    ];
    this.debugEmitFn?.(`DHCPD: ${kind}: ${parts.join(', ')}`);
  }

  // ─── Relay ────────────────────────────────────────────────────────

  addHelperAddress(iface: string, address: string): void {
    const existing = this.relay.helperAddresses.get(iface) || [];
    if (!existing.includes(address)) {
      existing.push(address);
      this.relay.helperAddresses.set(iface, existing);
    }
  }

  removeHelperAddress(iface: string, address: string): boolean {
    const existing = this.relay.helperAddresses.get(iface);
    if (!existing) return false;
    const idx = existing.indexOf(address);
    if (idx < 0) return false;
    existing.splice(idx, 1);
    if (existing.length === 0) this.relay.helperAddresses.delete(iface);
    return true;
  }

  private readonly interfaceModes: Map<string, DhcpInterfaceMode> = new Map();
  private readonly snoopingEnabledIfaces: Set<string> = new Set();
  private readonly forwardProtocolPorts: Map<string, Set<number>> = new Map();

  setInterfaceMode(iface: string, mode: DhcpInterfaceMode): void {
    this.interfaceModes.set(iface, mode);
  }
  getInterfaceMode(iface: string): DhcpInterfaceMode { return this.interfaceModes.get(iface) ?? 'server'; }

  setSnoopingEnabled(iface: string, enabled: boolean): void {
    if (enabled) this.snoopingEnabledIfaces.add(iface);
    else this.snoopingEnabledIfaces.delete(iface);
  }
  isSnoopingEnabled(iface: string): boolean { return this.snoopingEnabledIfaces.has(iface); }
  getSnoopingInterfaces(): readonly string[] { return [...this.snoopingEnabledIfaces]; }

  addForwardProtocolPort(iface: string, port: number): void {
    let set = this.forwardProtocolPorts.get(iface);
    if (!set) { set = new Set(); this.forwardProtocolPorts.set(iface, set); }
    set.add(port);
  }
  getForwardProtocolPorts(iface: string): readonly number[] {
    return [...(this.forwardProtocolPorts.get(iface) ?? [])];
  }

  getHelperAddresses(iface: string): string[] {
    return this.relay.helperAddresses.get(iface) || [];
  }

  setRelayInformationOption(on: boolean): void {
    this.relay.informationOption = on;
  }

  isRelayInformationOptionEnabled(): boolean {
    return this.relay.informationOption === true;
  }

  addForwardProtocol(port: number): void {
    this.relay.forwardProtocols.add(port);
  }

  getRelayConfig(): DHCPRelayConfig {
    return this.relay;
  }

  // ─── Pool Show Formatting ─────────────────────────────────────────

  formatPoolShow(poolName?: string): string {
    if (poolName) {
      const pool = this.pools.get(poolName);
      if (!pool) return `% Pool ${poolName} not found.`;
      if ((!pool.network || !pool.mask) && !pool.manual?.host) {
        return `% Incomplete configuration - missing network statement for pool "${poolName}"`;
      }
      return this.formatSinglePool(pool);
    }

    const lines: string[] = [];
    for (const [, pool] of this.pools) {
      lines.push(this.formatSinglePool(pool));
      lines.push('');
    }
    return lines.join('\n').trimEnd();
  }

  private countTotalAddresses(pool: DHCPPoolConfig): number {
    if (!pool.network || !pool.mask) return 0;
    const hostBits = 32 - this.maskToCIDR(pool.mask);
    if (hostBits <= 1) return 0;
    return Math.pow(2, hostBits) - 2;
  }

  private countExcludedForPool(pool: DHCPPoolConfig): number {
    if (!pool.network || !pool.mask) return 0;
    const netNum = this.ipToNumber(pool.network);
    const maskNum = this.ipToNumber(pool.mask);
    let n = 0;
    for (const range of this.excludedRanges) {
      const start = this.ipToNumber(range.start);
      const end = this.ipToNumber(range.end ?? range.start);
      for (let a = start; a <= end; a++) {
        if ((a & maskNum) === (netNum & maskNum)) n++;
      }
    }
    return n;
  }

  private formatSinglePool(pool: DHCPPoolConfig): string {
    const cidr = pool.mask ? this.maskToCIDR(pool.mask) : '?';
    const leaseDays = Math.floor(pool.leaseDuration / 86400);
    const leaseStr = leaseDays >= 1 ? `${leaseDays} days` : this.formatLeaseTime(pool.leaseDuration);

    const total = this.countTotalAddresses(pool);
    const loues = this.countBindingsForPool(pool.name);
    const exclus = this.countExcludedForPool(pool);

    const lines = [
      `Pool ${pool.name} :`,
      ` Utilization mark (high/low)    : ${pool.highUtilizationMark} / ${pool.lowUtilizationMark}`,
      ` Subnet size (first/next)       : 0 / 0`,
      ` Total addresses                : ${total}`,
      ` Leased addresses               : ${loues}`,
      ` Excluded addresses             : ${exclus}`,
      ` Pending event                  : none`,
    ];
    // Le tableau par sous-réseau : c'est là qu'IOS met la plage et la
    // répartition, et c'est ce qui distinguait sa sortie de la nôtre.
    if (pool.network && pool.mask) {
      const debut = this.numberToIP(this.ipToNumber(pool.network) + 1);
      const fin = this.numberToIP(this.ipToNumber(pool.network) + total);
      lines.push(' 1 subnet is currently in the pool :');
      lines.push(' Current index        IP address range                    Leased/Excluded/Total');
      lines.push(` ${debut.padEnd(20)} ${debut.padEnd(16)} - ${fin.padEnd(16)} `
        + `${String(loues).padEnd(5)}/${String(exclus).padEnd(9)}/${total}`);
    }
    const details = [
      `  Network          : ${pool.network || 'not configured'}/${cidr}`,
      `  Default Router   : ${pool.defaultRouter || 'not configured'}`,
      `  DNS Server(s)    : ${pool.dnsServers.length > 0 ? pool.dnsServers.join(', ') : 'not configured'}`,
      `  Domain Name      : ${pool.domainName || 'not configured'}`,
      `  Lease Time       : ${pool.leaseInfinite ? 'infinite' : leaseStr}`,
      `  Current Bindings : ${loues}`,
    ];
    lines.push(...details);
    if (pool.nextServer) lines.push(`  Next Server      : ${pool.nextServer}`);
    if (pool.bootfile) lines.push(`  Bootfile         : ${pool.bootfile}`);
    if (pool.netbiosServers?.length) {
      lines.push(`  NetBIOS Server(s): ${pool.netbiosServers.join(', ')}`);
    }
    if (pool.netbiosNodeType) {
      lines.push(`  NetBIOS Node Type: ${pool.netbiosNodeType}`);
    }
    for (const o of pool.options ?? []) {
      lines.push(`  Option ${o.code} (${o.kind}) : ${o.value}`);
    }
    if (pool.manual?.host) {
      lines.push(`  Manual Binding   : ${pool.manual.host}` +
        (pool.manual.hostMask ? `/${this.maskToCIDR(pool.manual.hostMask)}` : ''));
      if (pool.manual.hardwareAddress) {
        lines.push(`  Hardware Address : ${pool.manual.hardwareAddress}`);
      }
      if (pool.manual.clientIdentifier) {
        lines.push(`  Client Identifier: ${pool.manual.clientIdentifier}`);
      }
      if (pool.manual.clientName) {
        lines.push(`  Client Name      : ${pool.manual.clientName}`);
      }
    }
    return lines.join('\n');
  }

  formatExcludedShow(): string {
    if (this.excludedRanges.length === 0) return 'No excluded addresses configured.';
    const lines = ['Excluded Address Ranges:', ''];
    for (const range of this.excludedRanges) {
      if (range.start === range.end) {
        lines.push(`  ${range.start}`);
      } else {
        lines.push(`  ${range.start} - ${range.end}`);
      }
    }
    return lines.join('\n');
  }

  formatBindingsShow(): string {
    const lines = [
      'IP address       Client-id/              Lease expiration        Type',
      '                 Hardware address',
    ];
    if (this.bindings.size === 0) {
      return lines.join('\n');
    }
    for (const [ip, binding] of this.bindings) {
      const expDate = new Date(binding.leaseExpiration);
      const expStr = expDate.toLocaleString();
      lines.push(`${ip.padEnd(17)}${binding.clientId.padEnd(24)}${expStr.padEnd(24)}${binding.type}`);
    }
    return lines.join('\n');
  }

  formatStatsShow(): string {
    return [
      'Memory usage         ' + this.stats.totalMemory,
      'Address pools        ' + this.pools.size,
      'Automatic bindings   ' + this.countAutomaticBindings(),
      '',
      'Message              Received',
      'DHCPDISCOVER         ' + this.stats.discovers,
      'DHCPREQUEST          ' + this.stats.requests,
      'DHCPINFORM           ' + this.stats.informs,
      'DHCPRELEASE          ' + this.stats.releases,
      'DHCPDECLINE          ' + this.stats.declines,
      '',
      'Message              Sent',
      'DHCPOFFER            ' + this.stats.offers,
      'DHCPACK              ' + this.stats.acks,
      'DHCPNAK              ' + this.stats.naks,
    ].join('\n');
  }

  formatConflictShow(): string {
    const lines = ['IP address        Detection method   Detection time'];
    if (this.conflicts.length === 0) {
      lines.push('');
      lines.push('No conflicts detected.');
    }
    for (const c of this.conflicts) {
      lines.push(`${c.ipAddress.padEnd(18)}${c.detectionMethod.padEnd(19)}${new Date(c.detectionTime).toLocaleString()}`);
    }
    return lines.join('\n');
  }

  formatDebugShow(): string {
    const lines: string[] = [];
    if (this.debug.serverPacket || this.debug.serverEvents) {
      lines.push('DHCP server debugging is on');
    }
    if (this.debug.serverPacket) lines.push('DHCP server packet debugging is on');
    if (this.debug.serverEvents) lines.push('DHCP server event debugging is on');
    if (lines.length === 0) lines.push('No DHCP debugging is enabled');
    return lines.join('\n');
  }

  // ─── Database agents (`ip dhcp database <url>`) ───────────────────

  addDatabaseAgent(url: string): void {
    if (!this.databaseAgents.includes(url)) this.databaseAgents.push(url);
  }

  removeDatabaseAgent(url: string): void {
    const i = this.databaseAgents.indexOf(url);
    if (i >= 0) this.databaseAgents.splice(i, 1);
  }

  getDatabaseAgents(): string[] {
    return [...this.databaseAgents];
  }

  formatDatabaseShow(): string {
    if (this.databaseAgents.length === 0) return 'Database agents: 0';
    const lines: string[] = [`Database agents: ${this.databaseAgents.length}`, ''];
    for (const url of this.databaseAgents) {
      lines.push(
        `URL              : ${url}`,
        'Read succeeded   : never',
        'Write succeeded  : never',
        '',
      );
    }
    return lines.join('\n').trimEnd();
  }

  // ─── Internal Helpers ─────────────────────────────────────────────

  /**
   * Get pools for DISCOVER, prioritizing pools matching the subnet anchor
   * (giaddr when relayed, or the local ingress interface's own IP when not).
   */
  private getPoolsForDiscover(subnetAnchor?: string): DHCPPoolConfig[] {
    const allPools = Array.from(this.pools.values());
    if (!subnetAnchor) return allPools;

    const matching: DHCPPoolConfig[] = [];
    const others: DHCPPoolConfig[] = [];
    for (const pool of allPools) {
      if (pool.network && pool.mask && this.isIPInPool(subnetAnchor, pool)) {
        matching.push(pool);
      } else {
        others.push(pool);
      }
    }
    return [...matching, ...others];
  }

  private findAvailableIP(pool: DHCPPoolConfig, clientMAC?: string): string | null {
    if (!pool.network || !pool.mask) return null;

    const networkNum = this.ipToNumber(pool.network);
    const maskNum = this.ipToNumber(pool.mask);
    const broadcastNum = (networkNum | ~maskNum) >>> 0;

    // Iterate through all host addresses in the subnet
    for (let ip = networkNum + 1; ip < broadcastNum; ip++) {
      const ipStr = this.numberToIP(ip);

      // Skip excluded
      if (this.isExcluded(ipStr)) continue;

      // Skip already bound
      if (this.bindings.has(ipStr)) continue;

      // Skip pending offers (reserved for other clients)
      if (this.pendingOffers.has(ipStr)) continue;

      // Skip conflicted addresses
      if (this.isConflicted(ipStr)) continue;

      // Skip IPs reserved for other clients via static bindings
      if (clientMAC) {
        const reservedFor = this.getStaticBindingForIP(ipStr, pool.name);
        if (reservedFor && reservedFor.clientId !== clientMAC) continue;
      }

      return ipStr;
    }

    return null; // Pool exhausted
  }

  /** Find static binding that reserves a specific IP */
  private getStaticBindingForIP(ip: string, poolName: string): DHCPStaticBinding | null {
    const bindings = this.staticBindings.get(poolName) || [];
    return bindings.find(b => b.ipAddress === ip) || null;
  }

  private isIPInPool(ip: string, pool: DHCPPoolConfig): boolean {
    if (!pool.network || !pool.mask) return false;
    const ipNum = this.ipToNumber(ip);
    const netNum = this.ipToNumber(pool.network);
    const maskNum = this.ipToNumber(pool.mask);
    return (ipNum & maskNum) === (netNum & maskNum);
  }

  private isClientDenied(clientMAC: string, pool: DHCPPoolConfig): boolean {
    const macNoColons = clientMAC.replace(/:/g, '').toLowerCase();
    // Client-ID format: 01 (hw type) + MAC without separators
    const clientId = '01' + macNoColons;
    // MAC with dots (Cisco notation): 0100.5e00.0001
    const macDotted = macNoColons.replace(/(.{4})/g, '$1.').replace(/\.$/, '');
    const clientIdDotted = clientId.replace(/(.{4})/g, '$1.').replace(/\.$/, '');
    for (const pattern of pool.denyPatterns) {
      // Convert glob pattern to regex: * → .*, ? → ., . → \. (literal dot)
      let regexStr = '';
      for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '*') regexStr += '.*';
        else if (ch === '?') regexStr += '.';
        else if ('.+^${}()|[]\\'.includes(ch)) regexStr += '\\' + ch;
        else regexStr += ch;
      }
      const regex = new RegExp('^' + regexStr + '$', 'i');
      // Test against multiple client-id formats
      if (regex.test(clientId) || regex.test(macNoColons) ||
          regex.test(macDotted) || regex.test(clientIdDotted)) return true;
    }
    return false;
  }

  private cleanExpiredPendingOffers(): void {
    const now = Date.now();
    for (const [ip, pending] of this.pendingOffers) {
      if (pending.expiresAt <= now) {
        this.pendingOffers.delete(ip);
      }
    }
  }

  private countBindingsForPool(poolName: string): number {
    let count = 0;
    for (const [, binding] of this.bindings) {
      if (binding.poolName === poolName) count++;
    }
    return count;
  }

  private countAutomaticBindings(): number {
    let count = 0;
    for (const [, binding] of this.bindings) {
      if (binding.type === 'automatic') count++;
    }
    return count;
  }

  /** Validate that a string is a valid dotted-decimal IPv4 address (0-255 per octet) */
  private isValidIPv4(ip: string): boolean {
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    return parts.every(p => {
      const n = Number(p);
      return Number.isInteger(n) && n >= 0 && n <= 255 && p === String(n);
    });
  }

  private ipToNumber(ip: string): number {
    return new IPAddress(ip).toUint32();
  }

  private numberToIP(num: number): string {
    return [
      (num >>> 24) & 0xFF,
      (num >>> 16) & 0xFF,
      (num >>> 8) & 0xFF,
      num & 0xFF,
    ].join('.');
  }

  private maskToCIDR(mask: string): number {
    const num = this.ipToNumber(mask);
    let bits = 0;
    let n = num;
    while (n) {
      bits += n & 1;
      n >>>= 1;
    }
    return bits;
  }

  private formatLeaseTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours} hours`);
    if (mins > 0) parts.push(`${mins} minutes`);
    if (secs > 0) parts.push(`${secs} seconds`);
    return parts.join(' ') || '0 seconds';
  }
}
