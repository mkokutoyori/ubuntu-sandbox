/**
 * DHCPServer - DHCP Server Engine (RFC 2131)
 *
 * Manages DHCP pools, address allocation, lease bindings,
 * statistics, and debug flags. Used by the Router class.
 *
 * Responsibilities:
 *   - Pool configuration and validation
 *   - Address allocation (DORA process server-side)
 *   - Lease binding database
 *   - Excluded address management
 *   - Statistics and conflict tracking
 *   - Debug flag management
 */

import {
  DHCPPoolConfig, DHCPExcludedRange, DHCPBinding, DHCPServerStats,
  DHCPConflict, DHCPDebugFlags, DHCPRelayConfig,
  createDefaultPoolConfig, createDefaultStats,
} from './types';

export class DHCPServer {
  /** Service enabled flag */
  private enabled: boolean = true;

  /** Named DHCP pools */
  private pools: Map<string, DHCPPoolConfig> = new Map();

  /** Excluded address ranges */
  private excludedRanges: DHCPExcludedRange[] = [];

  /** Active lease bindings: IP → binding */
  private bindings: Map<string, DHCPBinding> = new Map();

  /** Server statistics */
  private stats: DHCPServerStats = createDefaultStats();

  /** IP conflict database */
  private conflicts: DHCPConflict[] = [];

  /** Debug flags */
  private debug: DHCPDebugFlags = { serverPacket: false, serverEvents: false };

  /** DHCP relay configuration */
  private relay: DHCPRelayConfig = {
    helperAddresses: new Map(),
    forwardProtocols: new Set([67]), // bootps by default
  };

  // ─── Service Control ─────────────────────────────────────────────

  enable(): void { this.enabled = true; }
  disable(): void { this.enabled = false; }
  isEnabled(): boolean { return this.enabled; }

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
      const ip = this.findAvailableIP(pool);
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
   */
  processDiscover(clientMAC: string): { ip: string; pool: DHCPPoolConfig } | null {
    this.stats.discovers++;
    if (!this.enabled) return null;

    for (const [, pool] of this.pools) {
      if (!pool.network || !pool.mask) continue;

      // Check existing binding
      for (const [ip, binding] of this.bindings) {
        if (binding.clientId === clientMAC && binding.poolName === pool.name) {
          this.stats.offers++;
          return { ip, pool };
        }
      }

      const ip = this.findAvailableIP(pool);
      if (ip) {
        this.stats.offers++;
        return { ip, pool };
      }
    }

    return null;
  }

  /**
   * Process a DHCPREQUEST and create/renew binding.
   */
  processRequest(clientMAC: string, requestedIP: string): DHCPBinding | null {
    this.stats.requests++;
    if (!this.enabled) return null;

    // Find pool for this IP
    for (const [, pool] of this.pools) {
      if (!pool.network || !pool.mask) continue;
      if (!this.isIPInPool(requestedIP, pool)) continue;

      if (this.isClientDenied(clientMAC, pool)) {
        this.stats.naks++;
        return null;
      }

      const binding: DHCPBinding = {
        ipAddress: requestedIP,
        clientId: clientMAC,
        leaseStart: Date.now(),
        leaseExpiration: Date.now() + pool.leaseDuration * 1000,
        poolName: pool.name,
        type: 'automatic',
      };

      this.bindings.set(requestedIP, binding);
      this.stats.acks++;
      return binding;
    }

    this.stats.naks++;
    return null;
  }

  /**
   * Process DHCPRELEASE - remove binding.
   */
  processRelease(clientMAC: string): void {
    this.stats.releases++;
    for (const [ip, binding] of this.bindings) {
      if (binding.clientId === clientMAC) {
        this.bindings.delete(ip);
        return;
      }
    }
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

  // ─── Statistics ───────────────────────────────────────────────────

  getStats(): DHCPServerStats {
    return { ...this.stats };
  }

  clearStats(): void {
    this.stats = createDefaultStats();
  }

  // ─── Conflicts ────────────────────────────────────────────────────

  getConflicts(): DHCPConflict[] {
    return [...this.conflicts];
  }

  clearConflicts(): void {
    this.conflicts = [];
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

  private findAvailableIP(pool: DHCPPoolConfig): string | null {
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

      return ipStr;
    }

    return null; // Pool exhausted
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
