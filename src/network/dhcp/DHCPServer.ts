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

/** Default pending offer timeout from centralized constants */
const PENDING_OFFER_TIMEOUT_MS = DHCP_CONSTANTS.PENDING_OFFER_TIMEOUT_MS;

/** Default conflict TTL: infinite (0 = never expire) */
const DEFAULT_CONFLICT_TTL = 0;

export class DHCPServer implements IProtocolEngine {
  /** Service enabled flag */
  private enabled: boolean = true;

  /** Server's own IP address (Option 54: Server Identifier) */
  private serverIdentifier: string = '0.0.0.0';

  /** Named DHCP pools */
  private pools: Map<string, DHCPPoolConfig> = new Map();

  /** Excluded address ranges */
  private excludedRanges: DHCPExcludedRange[] = [];

  /** Active lease bindings: IP → binding */
  private bindings: Map<string, DHCPBinding> = new Map();

  /** Pending offers: IP → pending (reserved between DISCOVER and REQUEST) */
  private pendingOffers: Map<string, DHCPPendingOffer> = new Map();

  /** Server statistics */
  private stats: DHCPServerStats = createDefaultStats();

  /** IP conflict database */
  private conflicts: DHCPConflict[] = [];

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

  // ─── IProtocolEngine ─────────────────────────────────────────────

  start(): void { this.enabled = true; }
  stop(): void { this.enabled = false; }
  isRunning(): boolean { return this.enabled; }

  // ─── Service Control (legacy aliases) ──────────────────────────

  enable(): void { this.enabled = true; }
  disable(): void { this.enabled = false; }
  isEnabled(): boolean { return this.enabled; }

  /** Set the server's own IP (used as Option 54: Server Identifier) */
  setServerIdentifier(ip: string): void { this.serverIdentifier = ip; }
  getServerIdentifier(): string { return this.serverIdentifier; }

  // ─── Pool Management ──────────────────────────────────────────────

  createPool(name: string): DHCPPoolConfig {
    const pool = createDefaultPoolConfig(name);
    this.pools.set(name, pool);
    return pool;
  }

  getPool(name: string): DHCPPoolConfig | undefined {
    return this.pools.get(name);
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

  configurePoolRouter(name: string, router: string): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    pool.defaultRouter = router;
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

  isPoolComplete(name: string): boolean {
    const pool = this.pools.get(name);
    if (!pool) return false;
    return pool.network !== null && pool.mask !== null;
  }

  // ─── Excluded Addresses ───────────────────────────────────────────

  addExcludedRange(start: string, end: string): void {
    this.excludedRanges.push({ start, end });
  }

  getExcludedRanges(): DHCPExcludedRange[] {
    return [...this.excludedRanges];
  }

  private isExcluded(ip: string): boolean {
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
  addStaticBinding(poolName: string, clientMAC: string, ipAddress: string): void {
    const existing = this.staticBindings.get(poolName) || [];
    existing.push({
      clientId: clientMAC,
      ipAddress,
      poolName,
      type: 'manual',
    });
    this.staticBindings.set(poolName, existing);
  }

  /** Get all static bindings for a pool */
  getStaticBindings(poolName: string): DHCPStaticBinding[] {
    return this.staticBindings.get(poolName) || [];
  }

  /** Find static binding for a client MAC in a specific pool */
  private findStaticBinding(clientMAC: string, poolName: string): DHCPStaticBinding | null {
    const bindings = this.staticBindings.get(poolName) || [];
    return bindings.find(b => b.clientId === clientMAC) || null;
  }

  // ─── Address Allocation (DORA Server-Side) ────────────────────────

  /**
   * Allocate an IP from the appropriate pool for a client.
   * Returns null if no address is available or client is denied.
   */
  allocateAddress(clientMAC: string, requestedIP?: string): DHCPBinding | null {
    if (!this.enabled) return null;

    // Find a matching pool
    for (const [, pool] of this.pools) {
      if (!pool.network || !pool.mask) continue;

      // Check deny patterns
      if (this.isClientDenied(clientMAC, pool)) {
        this.stats.naks++;
        return null;
      }

      // Check if client already has a binding
      for (const [ip, binding] of this.bindings) {
        if (binding.clientId === clientMAC && binding.poolName === pool.name) {
          // Renew existing binding
          binding.leaseStart = Date.now();
          binding.leaseExpiration = Date.now() + pool.leaseDuration * 1000;
          this.stats.acks++;
          return binding;
        }
      }

      // Try to allocate new address
      const ip = this.findAvailableIP(pool, clientMAC);
      if (!ip) continue;

      const binding: DHCPBinding = {
        ipAddress: ip,
        clientId: clientMAC,
        leaseStart: Date.now(),
        leaseExpiration: Date.now() + pool.leaseDuration * 1000,
        poolName: pool.name,
        type: 'automatic',
      };

      this.bindings.set(ip, binding);
      return binding;
    }

    return null;
  }

  /**
   * Process a DHCPDISCOVER and return an offer IP.
   * RFC 2131 §3.1.2: The server reserves the offered address until the client responds.
   *
   * Accepts either the new DHCPDiscoverParams or legacy (clientMAC: string) for backward compat.
   */
  processDiscover(paramsOrMAC: DHCPDiscoverParams | string): DHCPOfferResult | null {
    this.stats.discovers++;
    if (!this.enabled) return null;

    // Normalize params (backward compat)
    const params: DHCPDiscoverParams = typeof paramsOrMAC === 'string'
      ? { clientMAC: paramsOrMAC, xid: 0, clientIdentifier: '01' + paramsOrMAC.replace(/:/g, ''), parameterRequestList: [] }
      : paramsOrMAC;

    // Clean expired pending offers
    this.cleanExpiredPendingOffers();

    // Determine pool iteration order: if giaddr is set, prioritize matching pool
    const poolEntries = this.getPoolsForDiscover(params.giaddr);

    for (const pool of poolEntries) {
      if (!pool.network || !pool.mask) continue;

      // If giaddr is set, only consider pools whose subnet contains the giaddr
      if (params.giaddr && !this.isIPInPool(params.giaddr, pool)) continue;

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
            serverIdentifier: this.serverIdentifier,
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
            serverIdentifier: this.serverIdentifier,
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
            serverIdentifier: this.serverIdentifier,
            xid: params.xid,
            renewalTime: pool.renewalTime,
            rebindingTime: pool.rebindingTime,
          };
        }
      }

      // Allocate a new IP and create a pending offer
      const ip = this.findAvailableIP(pool, params.clientMAC);
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
          serverIdentifier: this.serverIdentifier,
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
    if (params.serverIdentifier && params.serverIdentifier !== this.serverIdentifier) {
      return null;
    }

    // Count this as our request only after verifying it's for us
    this.stats.requests++;

    // RFC compliance: Check if the requested IP is in an excluded range
    if (this.isExcluded(params.requestedIP)) {
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

      return {
        binding,
        serverIdentifier: this.serverIdentifier,
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
  processRequestWithNak(paramsOrMAC: DHCPRequestParams | string, legacyRequestedIP?: string): DHCPRequestWithNakResult | null {
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
    if (params.serverIdentifier && params.serverIdentifier !== this.serverIdentifier) {
      return null; // Not for us, don't count
    }

    this.stats.requests++;

    // Check excluded
    if (this.isExcluded(params.requestedIP)) {
      this.stats.naks++;
      return {
        type: 'NAK',
        serverIdentifier: this.serverIdentifier,
        xid: params.xid,
        message: `Requested address ${params.requestedIP} is in excluded range`,
      };
    }

    // Check conflicts
    if (this.isConflicted(params.requestedIP)) {
      this.stats.naks++;
      return {
        type: 'NAK',
        serverIdentifier: this.serverIdentifier,
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
          serverIdentifier: this.serverIdentifier,
          xid: params.xid,
          message: `Client ${params.clientMAC} denied by pool policy`,
        };
      }

      const existingBinding = this.bindings.get(params.requestedIP);
      if (existingBinding && existingBinding.clientId !== params.clientMAC) {
        this.stats.naks++;
        return {
          type: 'NAK',
          serverIdentifier: this.serverIdentifier,
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

      return {
        type: 'ACK',
        binding,
        serverIdentifier: this.serverIdentifier,
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
        serverIdentifier: this.serverIdentifier,
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
  }

  clearBinding(ip: string): boolean {
    return this.bindings.delete(ip);
  }

  /** Remove bindings whose lease has expired */
  cleanExpiredBindings(): void {
    const now = Date.now();
    for (const [ip, binding] of this.bindings) {
      if (binding.leaseExpiration <= now) {
        this.bindings.delete(ip);
      }
    }
  }

  // ─── Statistics ───────────────────────────────────────────────────

  getStats(): DHCPServerStats {
    return { ...this.stats };
  }

  clearStats(): void {
    this.stats = createDefaultStats();
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

  // ─── Relay ────────────────────────────────────────────────────────

  addHelperAddress(iface: string, address: string): void {
    const existing = this.relay.helperAddresses.get(iface) || [];
    if (!existing.includes(address)) {
      existing.push(address);
      this.relay.helperAddresses.set(iface, existing);
    }
  }

  getHelperAddresses(iface: string): string[] {
    return this.relay.helperAddresses.get(iface) || [];
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
      if (!pool) return `% Pool "${poolName}" not found.`;
      if (!pool.network || !pool.mask) return `% Incomplete configuration - missing network statement for pool "${poolName}"`;
      return this.formatSinglePool(pool);
    }

    const lines: string[] = [];
    for (const [, pool] of this.pools) {
      lines.push(this.formatSinglePool(pool));
      lines.push('');
    }
    return lines.join('\n').trimEnd();
  }

  private formatSinglePool(pool: DHCPPoolConfig): string {
    const cidr = pool.mask ? this.maskToCIDR(pool.mask) : '?';
    const leaseDays = Math.floor(pool.leaseDuration / 86400);
    const leaseStr = leaseDays >= 1 ? `${leaseDays} days` : this.formatLeaseTime(pool.leaseDuration);

    const lines = [
      `Pool ${pool.name} :`,
      `  Network          : ${pool.network || 'not configured'}/${cidr}`,
      `  Default Router   : ${pool.defaultRouter || 'not configured'}`,
      `  DNS Server(s)    : ${pool.dnsServers.length > 0 ? pool.dnsServers.join(', ') : 'not configured'}`,
      `  Domain Name      : ${pool.domainName || 'not configured'}`,
      `  Lease Time       : ${leaseStr}`,
      `  Current Bindings : ${this.countBindingsForPool(pool.name)}`,
    ];
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

  // ─── Internal Helpers ─────────────────────────────────────────────

  /**
   * Get pools for DISCOVER, prioritizing pools matching giaddr if present.
   */
  private getPoolsForDiscover(giaddr?: string): DHCPPoolConfig[] {
    const allPools = Array.from(this.pools.values());
    if (!giaddr) return allPools;

    // If giaddr is present, put matching pools first
    const matching: DHCPPoolConfig[] = [];
    const others: DHCPPoolConfig[] = [];
    for (const pool of allPools) {
      if (pool.network && pool.mask && this.isIPInPool(giaddr, pool)) {
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
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
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
