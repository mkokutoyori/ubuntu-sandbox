/**
 * DHCPClient - DHCP Client Engine (RFC 2131)
 *
 * Manages the DHCP client state machine per-interface.
 * Used by EndHost (LinuxPC, WindowsPC) classes.
 *
 * State machine:
 *   INIT → SELECTING → REQUESTING → BOUND
 *   BOUND → RENEWING (at T1=50%) → REBINDING (at T2=87.5%) → INIT (expired)
 *   BOUND → INIT (via release)
 */

import { DHCPServer } from './DHCPServer';
import {
  DHCPClientState, DHCPClientIfaceState, DHCPClientLease,
  createDefaultClientState,
} from './types';

/** Reference to a connected DHCP server (for simulated DORA) */
interface ServerRef {
  server: DHCPServer;
  serverIP: string;
}

export class DHCPClient {
  /** Per-interface DHCP state */
  private ifaceStates: Map<string, DHCPClientIfaceState> = new Map();

  /** Connected DHCP servers reachable from this host */
  private connectedServers: ServerRef[] = [];

  /** MAC address resolver callback */
  private getMACForIface: (iface: string) => string;

  /** Interface IP configuration callback */
  private configureIP: (iface: string, ip: string, mask: string, gateway: string | null) => void;

  /** Interface IP clear callback */
  private clearIP: (iface: string) => void;

  constructor(
    getMACForIface: (iface: string) => string,
    configureIP: (iface: string, ip: string, mask: string, gateway: string | null) => void,
    clearIP: (iface: string) => void,
  ) {
    this.getMACForIface = getMACForIface;
    this.configureIP = configureIP;
    this.clearIP = clearIP;
  }

  // ─── Server Registration ──────────────────────────────────────────

  registerServer(server: DHCPServer, serverIP: string): void {
    // Avoid duplicates
    if (!this.connectedServers.find(s => s.server === server)) {
      this.connectedServers.push({ server, serverIP });
    }
  }

  clearServers(): void {
    this.connectedServers = [];
  }

  // ─── State Access ─────────────────────────────────────────────────

  getState(iface: string): DHCPClientIfaceState {
    let state = this.ifaceStates.get(iface);
    if (!state) {
      state = createDefaultClientState();
      this.ifaceStates.set(iface, state);
    }
    return state;
  }

  getLogs(iface: string): string {
    const state = this.ifaceStates.get(iface);
    return state ? state.logs.join('\n') : '';
  }

  // ─── DHCP Discover → Offer → Request → Ack (DORA) ────────────────

  /**
   * Run full DORA process. Returns verbose output if requested.
   */
  requestLease(iface: string, options: {
    verbose?: boolean;
    timeout?: number;
    daemon?: boolean;
  } = {}): string {
    const mac = this.getMACForIface(iface);
    const state = this.getState(iface);
    const lines: string[] = [];
    const { verbose = false, timeout = 30 } = options;

    // Reset state
    state.state = 'INIT';
    state.xid = Math.floor(Math.random() * 0xFFFFFFFF);
    state.processRunning = true;

    // Log INIT
    state.logs.push(`INIT state - starting DHCP on ${iface}`);
    if (verbose) {
      lines.push(`Internet Systems Consortium DHCP Client 4.4.1`);
      lines.push(`Listening on LPF/${iface}/${mac}`);
      lines.push(`Sending on   LPF/${iface}/${mac}`);
      lines.push(`DHCPDISCOVER on ${iface} to 255.255.255.255 port 67 interval 3`);
      lines.push(`INIT state`);
    }

    // If no servers connected
    if (this.connectedServers.length === 0) {
      // Verbose mode or explicit timeout: show failure
      if (verbose || options.timeout !== undefined) {
        state.state = 'INIT';
        state.logs.push('No DHCPOFFERS received');
        if (verbose) {
          lines.push(`No DHCPOFFERS received.`);
          lines.push(`No working leases in persistent database - sleeping. expired.`);
        }
        return lines.join('\n');
      }

      // Non-verbose without timeout: auto-assign simulated lease (simulator convenience)
      return this.autoAssignLease(iface, state);
    }

    // SELECTING: Send DISCOVER to all servers, pick first OFFER
    state.state = 'SELECTING';
    let offer: { ip: string; pool: any; serverRef: ServerRef } | null = null;

    for (const ref of this.connectedServers) {
      const result = ref.server.processDiscover(mac);
      if (result) {
        offer = { ...result, serverRef: ref };
        break;
      }
    }

    if (!offer) {
      state.state = 'INIT';
      state.logs.push('No DHCPOFFERS received');
      if (verbose) {
        lines.push(`No DHCPOFFERS received.`);
        lines.push(`No working leases in persistent database - sleeping. expired.`);
      }
      return lines.join('\n');
    }

    if (verbose) {
      lines.push(`DHCPOFFER of ${offer.ip} from ${offer.serverRef.serverIP}`);
    }
    state.logs.push(`DHCPOFFER of ${offer.ip} from ${offer.serverRef.serverIP}`);

    // REQUESTING: Send REQUEST for the offered IP
    state.state = 'REQUESTING';
    const binding = offer.serverRef.server.processRequest(mac, offer.ip);

    if (!binding) {
      // NAK
      state.state = 'INIT';
      state.logs.push(`DHCPNAK from ${offer.serverRef.serverIP} - restarting`);
      if (verbose) {
        lines.push(`DHCPREQUEST of ${offer.ip} on ${iface} to 255.255.255.255 port 67`);
        lines.push(`DHCPNAK from ${offer.serverRef.serverIP} (${iface})`);
        lines.push(`DHCPDISCOVER on ${iface} - restarting`);
      }
      return lines.join('\n');
    }

    // BOUND: Got ACK
    state.state = 'BOUND';
    const pool = offer.pool;

    const lease: DHCPClientLease = {
      iface,
      ipAddress: binding.ipAddress,
      subnetMask: pool.mask,
      defaultGateway: pool.defaultRouter,
      dnsServers: pool.dnsServers || [],
      domainName: pool.domainName,
      serverIdentifier: offer.serverRef.serverIP,
      leaseStart: binding.leaseStart,
      leaseDuration: pool.leaseDuration,
      renewalTime: Math.floor(pool.leaseDuration * 0.5),
      rebindingTime: Math.floor(pool.leaseDuration * 0.875),
      expiration: binding.leaseExpiration,
      xid: state.xid,
    };

    state.lease = lease;
    state.logs.push(`DHCPREQUEST of ${binding.ipAddress} on ${iface}`);
    state.logs.push(`DHCPACK of ${binding.ipAddress} from ${offer.serverRef.serverIP}`);
    state.logs.push(`bound to ${binding.ipAddress}`);

    if (verbose) {
      lines.push(`DHCPREQUEST of ${binding.ipAddress} on ${iface} to 255.255.255.255 port 67`);
      lines.push(`DHCPACK of ${binding.ipAddress} from ${offer.serverRef.serverIP}`);
      lines.push(`bound to ${binding.ipAddress} -- renewal in ${lease.renewalTime} seconds.`);
    }

    // Configure the interface
    this.configureIP(iface, binding.ipAddress, pool.mask, pool.defaultRouter);

    // Set up lease timers
    this.setupLeaseTimers(iface, state);

    return lines.join('\n');
  }

  /**
   * Release current lease on an interface.
   */
  releaseLease(iface: string): string {
    const state = this.ifaceStates.get(iface);
    if (!state || !state.lease) {
      // Still valid - just go to INIT
      const s = this.getState(iface);
      s.state = 'INIT';
      s.processRunning = false;
      return '';
    }

    const mac = this.getMACForIface(iface);

    // Notify server
    for (const ref of this.connectedServers) {
      ref.server.processRelease(mac);
    }

    // Clear timers
    this.clearTimers(state);

    // Clear IP
    this.clearIP(iface);

    // Reset state
    const oldIP = state.lease.ipAddress;
    state.lease = null;
    state.state = 'INIT';
    state.processRunning = false;
    state.logs.push(`released ${oldIP} on ${iface}`);

    return `released ${oldIP}`;
  }

  /**
   * Check if dhclient process is running for an interface.
   */
  isProcessRunning(iface: string): boolean {
    const state = this.ifaceStates.get(iface);
    return state?.processRunning ?? false;
  }

  /**
   * Kill dhclient process for an interface.
   */
  stopProcess(iface: string): void {
    const state = this.ifaceStates.get(iface);
    if (state) {
      this.clearTimers(state);
      state.processRunning = false;
    }
  }

  /**
   * Format lease file content (Linux dhclient.leases format).
   */
  formatLeaseFile(iface: string): string {
    const state = this.ifaceStates.get(iface);
    if (!state || !state.lease) return '';

    const lease = state.lease;
    const renewDate = new Date(lease.leaseStart + lease.renewalTime * 1000);
    const rebindDate = new Date(lease.leaseStart + lease.rebindingTime * 1000);
    const expireDate = new Date(lease.expiration);

    const formatDate = (d: Date) => {
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return `${Math.floor(d.getTime() / 1000)} ${days[d.getDay()]} ${d.toISOString().replace('T', ' ').replace('Z', '')}`;
    };

    const lines = [
      `lease {`,
      `  interface "${iface}";`,
      `  fixed-address ${lease.ipAddress};`,
      `  option subnet-mask ${lease.subnetMask};`,
    ];
    if (lease.defaultGateway) {
      lines.push(`  option routers ${lease.defaultGateway};`);
    }
    if (lease.dnsServers.length > 0) {
      lines.push(`  option domain-name-servers ${lease.dnsServers.join(', ')};`);
    }
    if (lease.domainName) {
      lines.push(`  option domain-name "${lease.domainName}";`);
    }
    lines.push(`  renew ${formatDate(renewDate)};`);
    lines.push(`  rebind ${formatDate(rebindDate)};`);
    lines.push(`  expire ${formatDate(expireDate)};`);
    lines.push(`}`);

    return lines.join('\n');
  }

  /**
   * Auto-assign a simulated lease when no DHCP server is available.
   * This is a simulator convenience for non-verbose mode.
   */
  private autoAssignLease(iface: string, state: DHCPClientIfaceState): string {
    // Generate a deterministic IP from the MAC
    const mac = this.getMACForIface(iface);
    const macParts = mac.split(':');
    const octet3 = parseInt(macParts[4] || '01', 16) % 254 + 1;
    const octet4 = parseInt(macParts[5] || '02', 16) % 254 + 1;
    const ip = `192.168.1.${octet4}`;
    const mask = '255.255.255.0';
    const gateway = '192.168.1.1';
    const now = Date.now();
    const leaseDuration = 86400; // 1 day

    const lease: DHCPClientLease = {
      iface,
      ipAddress: ip,
      subnetMask: mask,
      defaultGateway: gateway,
      dnsServers: ['8.8.8.8'],
      domainName: null,
      serverIdentifier: gateway,
      leaseStart: now,
      leaseDuration,
      renewalTime: Math.floor(leaseDuration * 0.5),
      rebindingTime: Math.floor(leaseDuration * 0.875),
      expiration: now + leaseDuration * 1000,
      xid: state.xid,
    };

    state.lease = lease;
    state.state = 'BOUND';
    state.processRunning = true;
    state.logs.push(`DHCPDISCOVER on ${iface}`);
    state.logs.push(`DHCPOFFER of ${ip}`);
    state.logs.push(`DHCPREQUEST of ${ip}`);
    state.logs.push(`DHCPACK of ${ip}`);
    state.logs.push(`bound to ${ip}`);

    this.configureIP(iface, ip, mask, gateway);
    this.setupLeaseTimers(iface, state);

    return ''; // Non-verbose: silent success
  }

  /**
   * Cleanup all timers and state.
   */
  destroy(): void {
    for (const [, state] of this.ifaceStates) {
      this.clearTimers(state);
    }
    this.ifaceStates.clear();
    this.connectedServers = [];
  }

  // ─── Lease Timers ─────────────────────────────────────────────────

  private setupLeaseTimers(iface: string, state: DHCPClientIfaceState): void {
    if (!state.lease) return;

    this.clearTimers(state);

    const lease = state.lease;

    // T1: Renewal at 50% of lease
    state.renewalTimer = setTimeout(() => {
      if (state.state === 'BOUND') {
        state.state = 'RENEWING';
        state.logs.push('RENEWING - T1 expired, sending DHCPREQUEST to server');
        state.logs.push(`DHCPREQUEST for ${lease.ipAddress} to ${lease.serverIdentifier}`);

        // Try to renew with original server
        for (const ref of this.connectedServers) {
          if (ref.serverIP === lease.serverIdentifier) {
            const mac = this.getMACForIface(iface);
            const binding = ref.server.processRequest(mac, lease.ipAddress);
            if (binding) {
              state.state = 'BOUND';
              lease.leaseStart = binding.leaseStart;
              lease.expiration = binding.leaseExpiration;
              state.logs.push(`DHCPACK - lease renewed`);
              // Don't reset T2/expiration timers - they remain as safety net
              return;
            }
          }
        }
      }
    }, lease.renewalTime * 1000);

    // T2: Rebinding at 87.5% of lease
    state.rebindingTimer = setTimeout(() => {
      if (state.state === 'RENEWING' || state.state === 'BOUND') {
        state.state = 'REBINDING';
        state.logs.push('REBINDING - T2 expired, broadcast DHCPREQUEST');
        state.logs.push(`DHCPREQUEST for ${lease.ipAddress} broadcast`);

        // Try any server
        for (const ref of this.connectedServers) {
          const mac = this.getMACForIface(iface);
          const binding = ref.server.processRequest(mac, lease.ipAddress);
          if (binding) {
            state.state = 'BOUND';
            lease.leaseStart = binding.leaseStart;
            lease.expiration = binding.leaseExpiration;
            state.logs.push(`DHCPACK - lease rebound`);
            this.setupLeaseTimers(iface, state);
            return;
          }
        }
      }
    }, lease.rebindingTime * 1000);

    // Expiration
    state.expirationTimer = setTimeout(() => {
      state.state = 'INIT';
      state.lease = null;
      state.processRunning = false;
      state.logs.push('Lease expired - returning to INIT');
      this.clearIP(iface);
    }, lease.leaseDuration * 1000);
  }

  private clearTimers(state: DHCPClientIfaceState): void {
    if (state.renewalTimer) { clearTimeout(state.renewalTimer); state.renewalTimer = null; }
    if (state.rebindingTimer) { clearTimeout(state.rebindingTimer); state.rebindingTimer = null; }
    if (state.expirationTimer) { clearTimeout(state.expirationTimer); state.expirationTimer = null; }
  }
}
