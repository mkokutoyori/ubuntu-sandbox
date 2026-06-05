/**
 * DHCPClient - DHCP Client Engine (RFC 2131, RFC 2132)
 *
 * Manages the DHCP client state machine per-interface.
 * Used by EndHost (LinuxPC, WindowsPC) classes.
 *
 * State machine (RFC 2131 §4.4, Figure 5):
 *   INIT → SELECTING → REQUESTING → BOUND
 *   BOUND → RENEWING (at T1) → REBINDING (at T2) → INIT (expired)
 *   BOUND → INIT (via release)
 *   INIT-REBOOT → REBOOTING → BOUND (reuse lease after reboot)
 *
 * RFC compliance:
 *   - XID validation: responses must match the client's transaction ID
 *   - Option 55: Parameter Request List sent in DISCOVER/REQUEST
 *   - Option 61: Client Identifier (01 + MAC for Ethernet)
 *   - Option 50: Requested IP Address in DHCPREQUEST
 *   - Option 54: Server Identifier validation and forwarding
 *   - Options 58/59: T1/T2 read from server response (fallback 50%/87.5%)
 *   - DHCPDECLINE: ARP probe after ACK, decline if conflict (RFC 2131 §3.1.5)
 *   - INIT-REBOOT: Reuse last known lease after reboot (RFC 2131 §3.2)
 */

import { DHCPServer } from './DHCPServer';
import {
  DHCPClientState, DHCPClientIfaceState, DHCPClientLease,
  DHCPOfferResult, DHCPAckResult,
  createDefaultClientState,
} from './types';
import type { IProtocolEngine } from '../core/interfaces';
import { getDefaultEventBus, type IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { TimerSet } from '@/events/TimerSet';
import {
  DHCPClientSignalStore,
  makeReadonlyDHCPClientObservables,
  projectDhcpClientIfaces,
  projectDhcpClientStats,
  type DHCPClientObservables,
} from './observables';
import { DHCPClientSignalRefreshActor } from './actors';

/** Reference to a connected DHCP server (for simulated DORA) */
interface ServerRef {
  server: DHCPServer;
  serverIP: string;
}

/** Standard DHCP Option codes requested by clients (RFC 2132) */
const DEFAULT_PARAMETER_REQUEST_LIST = [
  1,   // Subnet Mask
  3,   // Router
  6,   // Domain Name Server
  15,  // Domain Name
  26,  // Interface MTU
  28,  // Broadcast Address
  51,  // IP Address Lease Time
  58,  // Renewal (T1) Time Value
  59,  // Rebinding (T2) Time Value
];

export class DHCPClient implements IProtocolEngine {
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

  /** ARP probe callback: returns true if the IP is already in use (conflict detected) */
  private checkAddressConflict: ((iface: string, ip: string) => boolean) | null = null;

  private running = false;

  // ─── Reactive plumbing (Phase 4b2-DHCP) ────────────────────────────
  private busOverride: IEventBus | null = null;
  private schedulerOverride: IScheduler | null = null;
  private readonly timers = new TimerSet(() => this.getScheduler());
  private readonly signalStore = new DHCPClientSignalStore();
  /** Read-only observables (ifaces, stats). */
  readonly observables: DHCPClientObservables = makeReadonlyDHCPClientObservables(this.signalStore);
  private signalRefreshActor: DHCPClientSignalRefreshActor | null = null;
  /** Optional device id stamped on every event. Set via setDeviceId(). */
  private deviceId: string = '';
  private hostname: string = '';

  // Counters feeding projectDhcpClientStats.
  private discoversSent = 0;
  private offersReceived = 0;
  private requestsSent = 0;
  private acksReceived = 0;
  private naksReceived = 0;
  private leasesGranted = 0;
  private leasesExpired = 0;
  private leasesReleased = 0;
  private conflicts = 0;

  setEventBus(bus: IEventBus | null): void {
    this.busOverride = bus;
    this.attachActors();
  }
  setScheduler(scheduler: IScheduler | null): void { this.schedulerOverride = scheduler; }
  /** Bind the client to a host device so events carry deviceId. */
  setDeviceId(id: string, hostname?: string): void {
    this.deviceId = id;
    if (hostname !== undefined) this.hostname = hostname;
  }
  getDeviceId(): string { return this.deviceId; }
  private getBus(): IEventBus { return this.busOverride ?? getDefaultEventBus(); }
  private getScheduler(): IScheduler { return this.schedulerOverride ?? getDefaultScheduler(); }
  private deviceRef() { return { deviceId: this.deviceId, hostname: this.hostname }; }

  private attachActors(): void {
    this.signalRefreshActor?.stop();
    this.signalRefreshActor = new DHCPClientSignalRefreshActor(this.getBus(), this);
    this.signalRefreshActor.start();
  }

  /** [actor-API] Refresh ifaces + stats. */
  _refreshAll(): void {
    this.signalStore.ifaces.set(projectDhcpClientIfaces(this.ifaceStates));
    this._refreshStats();
  }

  /** [actor-API] Refresh stats only. */
  _refreshStats(): void {
    this.signalStore.stats.set(projectDhcpClientStats({
      running: this.running,
      ifaceStates: this.ifaceStates,
      discoversSent: this.discoversSent,
      offersReceived: this.offersReceived,
      requestsSent: this.requestsSent,
      acksReceived: this.acksReceived,
      naksReceived: this.naksReceived,
      leasesGranted: this.leasesGranted,
      leasesExpired: this.leasesExpired,
      leasesReleased: this.leasesReleased,
      conflicts: this.conflicts,
    }));
  }

  /** Internal: emit a state-change event on the bus. */
  private emitStateChange(iface: string, oldState: string, newState: string, cause: string): void {
    if (oldState === newState) return;
    this.getBus().publish({
      topic: 'dhcp.client.state-changed',
      payload: { ...this.deviceRef(), iface, oldState, newState, cause },
    });
  }

  constructor(
    getMACForIface: (iface: string) => string,
    configureIP: (iface: string, ip: string, mask: string, gateway: string | null) => void,
    clearIP: (iface: string) => void,
  ) {
    this.getMACForIface = getMACForIface;
    this.configureIP = configureIP;
    this.clearIP = clearIP;
    this.attachActors();
  }

  // ─── IProtocolEngine ────────────────────────────────────────────────

  start(): void {
    this.running = true;
    this.signalRefreshActor?.start();
    this.getBus().publish({
      topic: 'dhcp.engine.started',
      payload: { ...this.deviceRef(), role: 'client' },
    });
    this._refreshAll();
  }

  stop(): void {
    this.running = false;
    this.timers.clearAll();
    for (const [, st] of this.ifaceStates) {
      st.renewalTimer = null;
      st.rebindingTimer = null;
      st.expirationTimer = null;
    }
    this.ifaceStates.clear();
    this.connectedServers = [];
    this.signalRefreshActor?.stop();
    this.getBus().publish({
      topic: 'dhcp.engine.stopped',
      payload: { ...this.deviceRef(), role: 'client' },
    });
    this._refreshAll();
  }

  isRunning(): boolean { return this.running; }

  // ─── ARP Probe Registration ────────────────────────────────────────

  /**
   * Register an ARP probe callback for address conflict detection.
   * RFC 2131 §4.4.1: Client SHOULD perform ARP check after receiving ACK.
   */
  setAddressConflictChecker(checker: (iface: string, ip: string) => boolean): void {
    this.checkAddressConflict = checker;
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

  // ─── Client Identifier Helper ─────────────────────────────────────

  /** Build Option 61 Client Identifier: 01 (hw type Ethernet) + MAC */
  private buildClientIdentifier(mac: string): string {
    return '01' + mac.replace(/:/g, '').toLowerCase();
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
    const clientIdentifier = this.buildClientIdentifier(mac);

    // Check for INIT-REBOOT: do we have a lastKnownLease from a prior session?
    if (state.state === 'INIT' && state.lastKnownLease && !state.lease) {
      const lastLease = state.lastKnownLease;
      // Only try INIT-REBOOT if the lease hasn't expired
      if (lastLease.expiration > Date.now()) {
        return this.initReboot(iface, state, lastLease, mac, clientIdentifier, verbose);
      }
      // Lease expired — clear it and proceed with normal INIT
      state.lastKnownLease = null;
    }

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
    this.emitStateChange(iface, 'INIT', 'SELECTING', 'DISCOVER');
    state.state = 'SELECTING';
    let offer: (DHCPOfferResult & { serverRef: ServerRef }) | null = null;

    this.discoversSent++;
    this.getBus().publish({
      topic: 'dhcp.discover.sent',
      payload: { ...this.deviceRef(), iface, xid: state.xid },
    });

    for (const ref of this.connectedServers) {
      const result = ref.server.processDiscover({
        clientMAC: mac,
        xid: state.xid,
        clientIdentifier,
        parameterRequestList: DEFAULT_PARAMETER_REQUEST_LIST,
      });
      if (result) {
        // XID validation (RFC 2131 §3.1): response xid must match our xid
        if (result.xid !== state.xid) {
          state.logs.push(`DHCPOFFER XID mismatch (expected ${state.xid}, got ${result.xid}) - ignoring`);
          continue;
        }
        offer = { ...result, serverRef: ref };
        this.offersReceived++;
        this.getBus().publish({
          topic: 'dhcp.offer.received',
          payload: {
            ...this.deviceRef(),
            iface,
            serverIp: result.serverIdentifier,
            offeredIp: result.ip,
            leaseTimeSec: result.pool.leaseDuration,
          },
        });
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
      lines.push(`DHCPOFFER of ${offer.ip} from ${offer.serverIdentifier}`);
    }
    state.logs.push(`DHCPOFFER of ${offer.ip} from ${offer.serverIdentifier}`);

    // REQUESTING: Send REQUEST with Option 50 (Requested IP) and Option 54 (Server Identifier)
    this.emitStateChange(iface, 'SELECTING', 'REQUESTING', 'OFFER');
    state.state = 'REQUESTING';
    this.requestsSent++;
    this.getBus().publish({
      topic: 'dhcp.request.sent',
      payload: {
        ...this.deviceRef(),
        iface,
        serverIp: offer.serverIdentifier,
        requestedIp: offer.ip,
        xid: state.xid,
      },
    });
    const ackResult = offer.serverRef.server.processRequest({
      clientMAC: mac,
      xid: state.xid,
      requestedIP: offer.ip,                    // Option 50
      serverIdentifier: offer.serverIdentifier,  // Option 54
      clientIdentifier,                          // Option 61
    });

    if (!ackResult) {
      // NAK
      this.naksReceived++;
      this.getBus().publish({
        topic: 'dhcp.nak.received',
        payload: { ...this.deviceRef(), iface, serverIp: offer.serverIdentifier },
      });
      this.emitStateChange(iface, 'REQUESTING', 'INIT', 'NAK');
      state.state = 'INIT';
      state.logs.push(`DHCPNAK from ${offer.serverIdentifier} - restarting`);
      if (verbose) {
        lines.push(`DHCPREQUEST of ${offer.ip} on ${iface} to 255.255.255.255 port 67`);
        lines.push(`DHCPNAK from ${offer.serverIdentifier} (${iface})`);
        lines.push(`DHCPDISCOVER on ${iface} - restarting`);
      }
      return lines.join('\n');
    }
    this.acksReceived++;

    // XID validation on ACK
    if (ackResult.xid !== state.xid) {
      state.state = 'INIT';
      state.logs.push(`DHCPACK XID mismatch (expected ${state.xid}, got ${ackResult.xid}) - ignoring`);
      return lines.join('\n');
    }

    // RFC 2131 §4.4.1: ARP probe to detect address conflict before using the IP
    if (this.checkAddressConflict && this.checkAddressConflict(iface, ackResult.binding.ipAddress)) {
      // Conflict detected — send DHCPDECLINE
      state.logs.push(`ARP probe conflict detected for ${ackResult.binding.ipAddress} - sending DHCPDECLINE`);
      this.conflicts++;
      this.getBus().publish({
        topic: 'dhcp.address-conflict',
        payload: { ...this.deviceRef(), iface, ip: ackResult.binding.ipAddress },
      });
      this.getBus().publish({
        topic: 'dhcp.decline.sent',
        payload: {
          ...this.deviceRef(),
          iface,
          serverIp: offer.serverIdentifier,
          ip: ackResult.binding.ipAddress,
          reason: 'arp-conflict',
        },
      });
      offer.serverRef.server.processDecline({
        clientMAC: mac,
        declinedIP: ackResult.binding.ipAddress,
        serverIdentifier: offer.serverIdentifier,
        clientIdentifier,
      });
      this.emitStateChange(iface, 'REQUESTING', 'INIT', 'DECLINE');
      state.state = 'INIT';
      if (verbose) {
        lines.push(`DHCPREQUEST of ${ackResult.binding.ipAddress} on ${iface} to 255.255.255.255 port 67`);
        lines.push(`DHCPACK of ${ackResult.binding.ipAddress} from ${offer.serverIdentifier}`);
        lines.push(`ARP probe: ${ackResult.binding.ipAddress} is already in use — DHCPDECLINE sent`);
      }
      return lines.join('\n');
    }

    // BOUND: Got ACK — read T1/T2 from server options or use defaults
    this.emitStateChange(iface, 'REQUESTING', 'BOUND', 'ACK');
    state.state = 'BOUND';
    const pool = offer.pool;
    const leaseDuration = pool.leaseDuration;

    // T1: Option 58 from server, or 50% of lease (RFC 2131 §4.4.5)
    let renewalTime = ackResult.renewalTime ?? pool.renewalTime ?? Math.floor(leaseDuration * 0.5);
    // T2: Option 59 from server, or 87.5% of lease (RFC 2131 §4.4.5)
    let rebindingTime = ackResult.rebindingTime ?? pool.rebindingTime ?? Math.floor(leaseDuration * 0.875);

    if (renewalTime >= rebindingTime || rebindingTime >= leaseDuration || renewalTime <= 0) {
      renewalTime = Math.floor(leaseDuration * 0.5);
      rebindingTime = Math.floor(leaseDuration * 0.875);
    }

    const lease: DHCPClientLease = {
      iface,
      ipAddress: ackResult.binding.ipAddress,
      subnetMask: pool.mask!,
      defaultGateway: pool.defaultRouter,
      dnsServers: pool.dnsServers || [],
      domainName: pool.domainName,
      serverIdentifier: ackResult.serverIdentifier,
      leaseStart: ackResult.binding.leaseStart,
      leaseDuration,
      renewalTime,
      rebindingTime,
      expiration: ackResult.binding.leaseExpiration,
      xid: state.xid,
    };

    state.lease = lease;
    state.lastKnownLease = { ...lease }; // Persist for INIT-REBOOT
    state.logs.push(`DHCPREQUEST of ${ackResult.binding.ipAddress} on ${iface}`);
    state.logs.push(`DHCPACK of ${ackResult.binding.ipAddress} from ${ackResult.serverIdentifier}`);
    state.logs.push(`bound to ${ackResult.binding.ipAddress}`);

    if (verbose) {
      lines.push(`DHCPREQUEST of ${ackResult.binding.ipAddress} on ${iface} to 255.255.255.255 port 67`);
      lines.push(`DHCPACK of ${ackResult.binding.ipAddress} from ${ackResult.serverIdentifier}`);
      lines.push(`bound to ${ackResult.binding.ipAddress} -- renewal in ${lease.renewalTime} seconds.`);
    }

    // Configure the interface
    this.configureIP(iface, ackResult.binding.ipAddress, pool.mask!, pool.defaultRouter);

    // Reactive notifications
    this.leasesGranted++;
    this.getBus().publish({
      topic: 'dhcp.ack.received',
      payload: {
        ...this.deviceRef(),
        iface,
        serverIp: ackResult.serverIdentifier,
        assignedIp: ackResult.binding.ipAddress,
        mask: String(pool.mask ?? ''),
        gateway: pool.defaultRouter,
        leaseTimeSec: leaseDuration,
        t1Sec: renewalTime,
        t2Sec: rebindingTime,
      },
    });
    this.getBus().publish({
      topic: 'dhcp.lease.granted',
      payload: {
        ...this.deviceRef(),
        iface,
        ip: ackResult.binding.ipAddress,
        mask: String(pool.mask ?? ''),
        gateway: pool.defaultRouter,
        leaseTimeSec: leaseDuration,
      },
    });

    // Set up lease timers
    this.setupLeaseTimers(iface, state);

    return lines.join('\n');
  }

  /**
   * INIT-REBOOT: Client has a previously known lease and tries to reuse it.
   * RFC 2131 §3.2: Client sends DHCPREQUEST with previously assigned IP (Option 50),
   * without Server Identifier (Option 54), to validate the lease is still valid.
   */
  private initReboot(
    iface: string,
    state: DHCPClientIfaceState,
    lastLease: DHCPClientLease,
    mac: string,
    clientIdentifier: string,
    verbose: boolean,
  ): string {
    const lines: string[] = [];

    state.state = 'INIT-REBOOT';
    state.xid = Math.floor(Math.random() * 0xFFFFFFFF);
    state.processRunning = true;

    state.logs.push(`INIT-REBOOT state - reusing lease ${lastLease.ipAddress} on ${iface}`);
    if (verbose) {
      lines.push(`Internet Systems Consortium DHCP Client 4.4.1`);
      lines.push(`Listening on LPF/${iface}/${mac}`);
      lines.push(`Sending on   LPF/${iface}/${mac}`);
      lines.push(`INIT-REBOOT state`);
      lines.push(`DHCPREQUEST for ${lastLease.ipAddress} on ${iface} to 255.255.255.255 port 67`);
    }

    // Send broadcast REQUEST without server identifier (RFC 2131 §3.2)
    state.state = 'REBOOTING';
    let ackResult: DHCPAckResult | null = null;
    let respondingRef: ServerRef | null = null;

    for (const ref of this.connectedServers) {
      const result = ref.server.processRequest({
        clientMAC: mac,
        xid: state.xid,
        requestedIP: lastLease.ipAddress,    // Option 50
        // NO serverIdentifier (RFC 2131 §3.2)
        clientIdentifier,                     // Option 61
      });
      if (result && result.xid === state.xid) {
        ackResult = result;
        respondingRef = ref;
        break;
      }
    }

    if (!ackResult || !respondingRef) {
      // NAK or no response — fall back to normal INIT
      state.state = 'INIT';
      state.lastKnownLease = null;
      state.logs.push('INIT-REBOOT failed - reverting to INIT');
      if (verbose) {
        lines.push(`DHCPNAK or no response - reverting to DHCPDISCOVER`);
      }
      // Retry as normal INIT
      return this.requestLease(iface, { verbose });
    }

    // ARP probe
    if (this.checkAddressConflict && this.checkAddressConflict(iface, ackResult.binding.ipAddress)) {
      state.logs.push(`ARP probe conflict detected for ${ackResult.binding.ipAddress} - sending DHCPDECLINE`);
      respondingRef.server.processDecline({
        clientMAC: mac,
        declinedIP: ackResult.binding.ipAddress,
        serverIdentifier: ackResult.serverIdentifier,
        clientIdentifier,
      });
      state.state = 'INIT';
      state.lastKnownLease = null;
      return this.requestLease(iface, { verbose });
    }

    // BOUND with reused lease
    state.state = 'BOUND';
    const renewalTime = ackResult.renewalTime ?? Math.floor(ackResult.binding.leaseExpiration - ackResult.binding.leaseStart) / 1000 * 0.5;
    const rebindingTime = ackResult.rebindingTime ?? Math.floor(ackResult.binding.leaseExpiration - ackResult.binding.leaseStart) / 1000 * 0.875;
    const leaseDuration = Math.floor((ackResult.binding.leaseExpiration - ackResult.binding.leaseStart) / 1000);

    const lease: DHCPClientLease = {
      iface,
      ipAddress: ackResult.binding.ipAddress,
      subnetMask: lastLease.subnetMask,
      defaultGateway: lastLease.defaultGateway,
      dnsServers: lastLease.dnsServers,
      domainName: lastLease.domainName,
      serverIdentifier: ackResult.serverIdentifier,
      leaseStart: ackResult.binding.leaseStart,
      leaseDuration,
      renewalTime: Math.floor(renewalTime),
      rebindingTime: Math.floor(rebindingTime),
      expiration: ackResult.binding.leaseExpiration,
      xid: state.xid,
    };

    state.lease = lease;
    state.lastKnownLease = { ...lease };
    state.logs.push(`DHCPACK of ${ackResult.binding.ipAddress} from ${ackResult.serverIdentifier}`);
    state.logs.push(`bound to ${ackResult.binding.ipAddress} (INIT-REBOOT)`);

    if (verbose) {
      lines.push(`DHCPACK of ${ackResult.binding.ipAddress} from ${ackResult.serverIdentifier}`);
      lines.push(`bound to ${ackResult.binding.ipAddress} -- renewal in ${lease.renewalTime} seconds.`);
    }

    this.configureIP(iface, ackResult.binding.ipAddress, lastLease.subnetMask, lastLease.defaultGateway);
    this.setupLeaseTimers(iface, state);

    return lines.join('\n');
  }

  /**
   * Release current lease on an interface.
   * RFC 2131 §3.4: Client sends DHCPRELEASE with ciaddr and server identifier.
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
    const clientIdentifier = this.buildClientIdentifier(mac);
    const lease = state.lease;

    // Notify server with RFC-compliant RELEASE (MAC + IP + Server Identifier)
    for (const ref of this.connectedServers) {
      if (ref.serverIP === lease.serverIdentifier) {
        ref.server.processRelease({
          clientMAC: mac,
          clientIP: lease.ipAddress,
          serverIdentifier: lease.serverIdentifier,
          clientIdentifier,
        });
        break; // Only release to the server that gave us the lease
      }
    }

    // Clear timers
    this.clearTimers(state);

    // Clear IP
    this.clearIP(iface);

    // Reset state — keep lastKnownLease cleared (explicit release = don't reuse)
    const oldIP = state.lease.ipAddress;
    state.lease = null;
    state.lastKnownLease = null; // Explicit release — do not INIT-REBOOT
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
    lines.push(`  option dhcp-server-identifier ${lease.serverIdentifier};`);
    lines.push(`  renew ${formatDate(renewDate)};`);
    lines.push(`  rebind ${formatDate(rebindDate)};`);
    lines.push(`  expire ${formatDate(expireDate)};`);
    lines.push(`}`);

    return lines.join('\n');
  }

  /**
   * Assign an APIPA (Automatic Private IP Addressing) address when no
   * DHCP server is available. RFC 3927: Link-local addressing (169.254.x.x).
   *
   * The IP is derived deterministically from the MAC address so the same
   * client always gets the same APIPA address.
   */
  private autoAssignLease(iface: string, state: DHCPClientIfaceState): string {
    const mac = this.getMACForIface(iface);
    const macParts = mac.split(':');

    // Derive APIPA octets from MAC (RFC 3927: 169.254.1.0 - 169.254.254.255)
    const octet3 = (parseInt(macParts[4] || '01', 16) % 254) + 1; // 1-254
    const octet4 = parseInt(macParts[5] || '02', 16);              // 0-255
    const ip = `169.254.${octet3}.${octet4}`;
    const mask = '255.255.0.0';
    const now = Date.now();
    const leaseDuration = 86400; // APIPA doesn't have a real lease, but we set one for consistency

    const lease: DHCPClientLease = {
      iface,
      ipAddress: ip,
      subnetMask: mask,
      defaultGateway: null, // APIPA: no gateway (link-local only)
      dnsServers: [],
      domainName: null,
      serverIdentifier: '0.0.0.0',
      leaseStart: now,
      leaseDuration,
      renewalTime: Math.floor(leaseDuration * 0.5),
      rebindingTime: Math.floor(leaseDuration * 0.875),
      expiration: now + leaseDuration * 1000,
      xid: state.xid,
    };

    state.lease = lease;
    state.lastKnownLease = { ...lease };
    state.state = 'BOUND';
    state.processRunning = true;
    state.logs.push(`DHCPDISCOVER on ${iface}`);
    state.logs.push(`No DHCP server available - using APIPA`);
    state.logs.push(`bound to ${ip} (link-local)`);

    this.configureIP(iface, ip, mask, null);
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
    const mac = this.getMACForIface(iface);
    const clientIdentifier = this.buildClientIdentifier(mac);

    // T1: Renewal (unicast to original server)
    state.renewalTimer = this.timers.setTimeout(() => {
      if (state.state === 'BOUND') {
        const oldS = state.state as string;
        state.state = 'RENEWING';
        this.emitStateChange(iface, oldS, 'RENEWING', 'T1');
        this.getBus().publish({
          topic: 'dhcp.lease.renewing',
          payload: { ...this.deviceRef(), iface, ip: lease.ipAddress },
        });
        state.logs.push('RENEWING - T1 expired, sending DHCPREQUEST to server');
        state.logs.push(`DHCPREQUEST for ${lease.ipAddress} to ${lease.serverIdentifier}`);

        // Try to renew with original server
        for (const ref of this.connectedServers) {
          if (ref.serverIP === lease.serverIdentifier) {
            const ackResult = ref.server.processRequest({
              clientMAC: mac,
              xid: state.xid,
              requestedIP: lease.ipAddress,
              // No serverIdentifier in RENEWING (unicast, RFC 2131 §4.3.2)
              clientIdentifier,
            });
            if (ackResult && ackResult.xid === state.xid) {
              const oldS2 = state.state as string;
              state.state = 'BOUND';
              this.emitStateChange(iface, oldS2, 'BOUND', 'ACK-renew');
              lease.leaseStart = ackResult.binding.leaseStart;
              lease.expiration = ackResult.binding.leaseExpiration;
              lease.leaseDuration = Math.floor((ackResult.binding.leaseExpiration - ackResult.binding.leaseStart) / 1000);
              if (ackResult.renewalTime !== undefined) lease.renewalTime = ackResult.renewalTime;
              if (ackResult.rebindingTime !== undefined) lease.rebindingTime = ackResult.rebindingTime;
              state.logs.push(`DHCPACK - lease renewed`);
              // BUG FIX: Restart timers after successful renewal
              this.setupLeaseTimers(iface, state);
              return;
            }
          }
        }
      }
    }, lease.renewalTime * 1000);

    // T2: Rebinding (broadcast to any server)
    state.rebindingTimer = this.timers.setTimeout(() => {
      if (state.state === 'RENEWING' || state.state === 'BOUND') {
        const oldS = state.state as string;
        state.state = 'REBINDING';
        this.emitStateChange(iface, oldS, 'REBINDING', 'T2');
        this.getBus().publish({
          topic: 'dhcp.lease.rebinding',
          payload: { ...this.deviceRef(), iface, ip: lease.ipAddress },
        });
        state.logs.push('REBINDING - T2 expired, broadcast DHCPREQUEST');
        state.logs.push(`DHCPREQUEST for ${lease.ipAddress} broadcast`);

        // Try any server
        for (const ref of this.connectedServers) {
          const ackResult = ref.server.processRequest({
            clientMAC: mac,
            xid: state.xid,
            requestedIP: lease.ipAddress,
            clientIdentifier,
          });
          if (ackResult && ackResult.xid === state.xid) {
            const oldS2 = state.state as string;
            state.state = 'BOUND';
            this.emitStateChange(iface, oldS2, 'BOUND', 'ACK-rebind');
            lease.leaseStart = ackResult.binding.leaseStart;
            lease.expiration = ackResult.binding.leaseExpiration;
            if (ackResult.renewalTime !== undefined) lease.renewalTime = ackResult.renewalTime;
            if (ackResult.rebindingTime !== undefined) lease.rebindingTime = ackResult.rebindingTime;
            state.logs.push(`DHCPACK - lease rebound`);
            this.setupLeaseTimers(iface, state);
            return;
          }
        }
      }
    }, lease.rebindingTime * 1000);

    // Expiration
    state.expirationTimer = this.timers.setTimeout(() => {
      const oldS = state.state as string;
      const expiredIp = state.lease?.ipAddress ?? '';
      state.state = 'INIT';
      state.lease = null;
      state.processRunning = false;
      state.logs.push('Lease expired - returning to INIT');
      this.clearIP(iface);
      this.leasesExpired++;
      this.emitStateChange(iface, oldS, 'INIT', 'expired');
      this.getBus().publish({
        topic: 'dhcp.lease.expired',
        payload: { ...this.deviceRef(), iface, ip: expiredIp },
      });
    }, lease.leaseDuration * 1000);
  }

  private clearTimers(state: DHCPClientIfaceState): void {
    if (state.renewalTimer) { this.timers.clear(state.renewalTimer); state.renewalTimer = null; }
    if (state.rebindingTimer) { this.timers.clear(state.rebindingTimer); state.rebindingTimer = null; }
    if (state.expirationTimer) { this.timers.clear(state.expirationTimer); state.expirationTimer = null; }
  }
}
