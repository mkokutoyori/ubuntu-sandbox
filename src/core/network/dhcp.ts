/**
 * DHCP Service - Dynamic Host Configuration Protocol implementation
 * Supports DHCP server and client functionality for network simulation
 */

import {
  Packet,
  UDPDatagram,
  IPv4Packet,
  EthernetFrame,
  ETHER_TYPE,
  IP_PROTOCOL,
  BROADCAST_MAC,
  generatePacketId,
} from './packet';

// DHCP Message Types
export enum DHCPMessageType {
  DISCOVER = 1,
  OFFER = 2,
  REQUEST = 3,
  DECLINE = 4,
  ACK = 5,
  NAK = 6,
  RELEASE = 7,
  INFORM = 8,
}

// DHCP Ports
export const DHCP_SERVER_PORT = 67;
export const DHCP_CLIENT_PORT = 68;

// DHCP Packet structure
export interface DHCPPacket {
  op: number;              // 1 = BOOTREQUEST, 2 = BOOTREPLY
  htype: number;           // Hardware type (1 = Ethernet)
  hlen: number;            // Hardware address length (6 for MAC)
  hops: number;            // Relay hops
  xid: number;             // Transaction ID
  secs: number;            // Seconds elapsed
  flags: number;           // Broadcast flag
  ciaddr: string;          // Client IP (if known)
  yiaddr: string;          // Your (client) IP address
  siaddr: string;          // Server IP address
  giaddr: string;          // Gateway IP (relay agent)
  chaddr: string;          // Client hardware address (MAC)
  sname: string;           // Server host name
  file: string;            // Boot file name
  options: DHCPOption[];   // DHCP options
}

export interface DHCPOption {
  code: number;
  data: Uint8Array | string | number | string[];
}

// Common DHCP Option Codes
export const DHCP_OPTIONS = {
  SUBNET_MASK: 1,
  ROUTER: 3,
  DNS_SERVER: 6,
  DOMAIN_NAME: 15,
  BROADCAST_ADDRESS: 28,
  REQUESTED_IP: 50,
  LEASE_TIME: 51,
  MESSAGE_TYPE: 53,
  SERVER_IDENTIFIER: 54,
  PARAMETER_REQUEST_LIST: 55,
  RENEWAL_TIME: 58,
  REBINDING_TIME: 59,
  END: 255,
};

// DHCP Lease
export interface DHCPLease {
  ipAddress: string;
  macAddress: string;
  hostname?: string;
  leaseStart: number;
  leaseTime: number;        // in seconds
  state: 'offered' | 'active' | 'expired' | 'released';
  xid?: number;             // Transaction ID for pending offers
}

// DHCP Pool Configuration
export interface DHCPPoolConfig {
  name: string;
  network: string;
  mask: string;
  defaultRouter?: string[];
  dnsServer?: string[];
  domain?: string;
  leaseTime: number;        // in seconds (default 86400 = 1 day)
  excludedAddresses: string[];
}

/**
 * DHCP Server Service
 */
export class DHCPServer {
  private pools: Map<string, DHCPPoolConfig> = new Map();
  private leases: Map<string, DHCPLease> = new Map();  // IP -> Lease
  private macToLease: Map<string, string> = new Map(); // MAC -> IP
  private serverIP: string = '0.0.0.0';
  private serverMAC: string = '00:00:00:00:00:00';
  private packetSender?: (packet: Packet, interfaceId: string) => void;
  private interfaceId: string = '';

  constructor() {}

  /**
   * Set packet sender callback
   */
  setPacketSender(sender: (packet: Packet, interfaceId: string) => void): void {
    this.packetSender = sender;
  }

  /**
   * Set server interface
   */
  setInterface(interfaceId: string, ipAddress: string, macAddress: string): void {
    this.interfaceId = interfaceId;
    this.serverIP = ipAddress;
    this.serverMAC = macAddress;
  }

  /**
   * Add a DHCP pool
   */
  addPool(pool: DHCPPoolConfig): void {
    this.pools.set(pool.name, pool);
  }

  /**
   * Remove a DHCP pool
   */
  removePool(name: string): void {
    this.pools.delete(name);
  }

  /**
   * Get all pools
   */
  getPools(): DHCPPoolConfig[] {
    return Array.from(this.pools.values());
  }

  /**
   * Get all leases
   */
  getLeases(): DHCPLease[] {
    return Array.from(this.leases.values());
  }

  /**
   * Process incoming DHCP packet
   */
  processPacket(dhcpPacket: DHCPPacket, sourceInterface: string): Packet | null {
    const messageType = this.getMessageType(dhcpPacket);

    switch (messageType) {
      case DHCPMessageType.DISCOVER:
        return this.handleDiscover(dhcpPacket, sourceInterface);
      case DHCPMessageType.REQUEST:
        return this.handleRequest(dhcpPacket, sourceInterface);
      case DHCPMessageType.RELEASE:
        return this.handleRelease(dhcpPacket);
      case DHCPMessageType.DECLINE:
        return this.handleDecline(dhcpPacket);
      default:
        return null;
    }
  }

  /**
   * Handle DHCP Discover - respond with Offer
   */
  private handleDiscover(dhcpPacket: DHCPPacket, sourceInterface: string): Packet | null {
    const clientMAC = dhcpPacket.chaddr.toUpperCase();

    // Check if client already has a lease
    let offeredIP = this.macToLease.get(clientMAC);

    if (!offeredIP) {
      // Find an available IP from pools
      offeredIP = this.findAvailableIP(clientMAC);
    }

    if (!offeredIP) {
      // No available IPs
      return null;
    }

    // Find the pool for this IP
    const pool = this.findPoolForIP(offeredIP);
    if (!pool) return null;

    // Create or update lease as 'offered'
    const lease: DHCPLease = {
      ipAddress: offeredIP,
      macAddress: clientMAC,
      leaseStart: Date.now(),
      leaseTime: pool.leaseTime,
      state: 'offered',
      xid: dhcpPacket.xid,
    };
    this.leases.set(offeredIP, lease);
    this.macToLease.set(clientMAC, offeredIP);

    // Build DHCP Offer
    return this.buildDHCPResponse(
      DHCPMessageType.OFFER,
      dhcpPacket,
      offeredIP,
      pool,
      sourceInterface
    );
  }

  /**
   * Handle DHCP Request - respond with ACK or NAK
   */
  private handleRequest(dhcpPacket: DHCPPacket, sourceInterface: string): Packet | null {
    const clientMAC = dhcpPacket.chaddr.toUpperCase();

    // Get requested IP from options or ciaddr
    let requestedIP = this.getRequestedIP(dhcpPacket) || dhcpPacket.ciaddr;

    if (!requestedIP || requestedIP === '0.0.0.0') {
      // Check if we have an offer for this client
      requestedIP = this.macToLease.get(clientMAC);
    }

    if (!requestedIP) {
      return this.buildDHCPNAK(dhcpPacket, sourceInterface);
    }

    const existingLease = this.leases.get(requestedIP);

    // Validate the request
    if (existingLease && existingLease.macAddress !== clientMAC) {
      // IP is leased to another client
      return this.buildDHCPNAK(dhcpPacket, sourceInterface);
    }

    // Validate XID if this is a response to our OFFER (not a renewal)
    // For renewal/rebinding (ciaddr is set), XID validation is less strict
    if (existingLease && existingLease.state === 'offered' && existingLease.xid !== undefined) {
      if (dhcpPacket.xid !== existingLease.xid) {
        // XID mismatch - this REQUEST doesn't match our OFFER
        return this.buildDHCPNAK(dhcpPacket, sourceInterface);
      }
    }

    const pool = this.findPoolForIP(requestedIP);
    if (!pool) {
      return this.buildDHCPNAK(dhcpPacket, sourceInterface);
    }

    // Activate the lease
    const lease: DHCPLease = {
      ipAddress: requestedIP,
      macAddress: clientMAC,
      leaseStart: Date.now(),
      leaseTime: pool.leaseTime,
      state: 'active',
    };
    this.leases.set(requestedIP, lease);
    this.macToLease.set(clientMAC, requestedIP);

    // Build DHCP ACK
    return this.buildDHCPResponse(
      DHCPMessageType.ACK,
      dhcpPacket,
      requestedIP,
      pool,
      sourceInterface
    );
  }

  /**
   * Handle DHCP Release
   */
  private handleRelease(dhcpPacket: DHCPPacket): Packet | null {
    const clientIP = dhcpPacket.ciaddr;
    const lease = this.leases.get(clientIP);

    if (lease && lease.macAddress === dhcpPacket.chaddr.toUpperCase()) {
      lease.state = 'released';
      this.macToLease.delete(lease.macAddress);
      this.leases.delete(clientIP);
    }

    return null; // No response for release
  }

  /**
   * Handle DHCP Decline
   */
  private handleDecline(dhcpPacket: DHCPPacket): Packet | null {
    const requestedIP = this.getRequestedIP(dhcpPacket);
    if (requestedIP) {
      // Mark IP as unavailable (could add to excluded list)
      const lease = this.leases.get(requestedIP);
      if (lease) {
        lease.state = 'expired';
      }
    }
    return null;
  }

  /**
   * Find an available IP address from pools
   */
  private findAvailableIP(clientMAC: string): string | null {
    for (const pool of this.pools.values()) {
      const availableIP = this.getNextAvailableIP(pool);
      if (availableIP) {
        return availableIP;
      }
    }
    return null;
  }

  /**
   * Get next available IP from a pool
   */
  private getNextAvailableIP(pool: DHCPPoolConfig): string | null {
    const networkParts = pool.network.split('.').map(Number);
    const maskParts = pool.mask.split('.').map(Number);

    // Calculate network range
    const networkStart = this.ipToNumber(pool.network);
    const hostBits = 32 - this.netmaskToPrefix(pool.mask);
    const networkEnd = networkStart + Math.pow(2, hostBits) - 1;

    // Start from network + 1, end at broadcast - 1
    for (let ip = networkStart + 1; ip < networkEnd; ip++) {
      const ipStr = this.numberToIP(ip);

      // Check if excluded
      if (pool.excludedAddresses.includes(ipStr)) {
        continue;
      }

      // Check if already leased
      const lease = this.leases.get(ipStr);
      if (!lease || lease.state === 'released' || lease.state === 'expired') {
        return ipStr;
      }
    }

    return null;
  }

  /**
   * Find pool for a given IP
   */
  private findPoolForIP(ip: string): DHCPPoolConfig | null {
    const ipNum = this.ipToNumber(ip);

    for (const pool of this.pools.values()) {
      const networkNum = this.ipToNumber(pool.network);
      const maskNum = this.ipToNumber(pool.mask);

      if ((ipNum & maskNum) === (networkNum & maskNum)) {
        return pool;
      }
    }

    return null;
  }

  /**
   * Build DHCP response packet
   */
  private buildDHCPResponse(
    messageType: DHCPMessageType,
    request: DHCPPacket,
    offeredIP: string,
    pool: DHCPPoolConfig,
    sourceInterface: string
  ): Packet {
    // Calculate T1 and T2 times per RFC 2131
    const t1Time = Math.floor(pool.leaseTime * 0.5);    // 50% of lease
    const t2Time = Math.floor(pool.leaseTime * 0.875);  // 87.5% of lease

    const options: DHCPOption[] = [
      { code: DHCP_OPTIONS.MESSAGE_TYPE, data: messageType },
      { code: DHCP_OPTIONS.SERVER_IDENTIFIER, data: this.serverIP },
      { code: DHCP_OPTIONS.LEASE_TIME, data: pool.leaseTime },
      { code: DHCP_OPTIONS.RENEWAL_TIME, data: t1Time },
      { code: DHCP_OPTIONS.REBINDING_TIME, data: t2Time },
      { code: DHCP_OPTIONS.SUBNET_MASK, data: pool.mask },
    ];

    if (pool.defaultRouter && pool.defaultRouter.length > 0) {
      options.push({ code: DHCP_OPTIONS.ROUTER, data: pool.defaultRouter });
    }

    if (pool.dnsServer && pool.dnsServer.length > 0) {
      options.push({ code: DHCP_OPTIONS.DNS_SERVER, data: pool.dnsServer });
    }

    if (pool.domain) {
      options.push({ code: DHCP_OPTIONS.DOMAIN_NAME, data: pool.domain });
    }

    options.push({ code: DHCP_OPTIONS.END, data: new Uint8Array(0) });

    const dhcpResponse: DHCPPacket = {
      op: 2, // BOOTREPLY
      htype: 1,
      hlen: 6,
      hops: 0,
      xid: request.xid,
      secs: 0,
      flags: request.flags,
      ciaddr: '0.0.0.0',
      yiaddr: offeredIP,
      siaddr: this.serverIP,
      giaddr: request.giaddr,
      chaddr: request.chaddr,
      sname: '',
      file: '',
      options,
    };

    return this.createDHCPPacket(
      dhcpResponse,
      this.serverIP,
      request.flags & 0x8000 ? '255.255.255.255' : offeredIP,
      this.serverMAC,
      request.flags & 0x8000 ? BROADCAST_MAC : request.chaddr,
      sourceInterface
    );
  }

  /**
   * Build DHCP NAK packet
   */
  private buildDHCPNAK(request: DHCPPacket, sourceInterface: string): Packet {
    const options: DHCPOption[] = [
      { code: DHCP_OPTIONS.MESSAGE_TYPE, data: DHCPMessageType.NAK },
      { code: DHCP_OPTIONS.SERVER_IDENTIFIER, data: this.serverIP },
      { code: DHCP_OPTIONS.END, data: new Uint8Array(0) },
    ];

    const dhcpNAK: DHCPPacket = {
      op: 2,
      htype: 1,
      hlen: 6,
      hops: 0,
      xid: request.xid,
      secs: 0,
      flags: 0x8000, // Broadcast
      ciaddr: '0.0.0.0',
      yiaddr: '0.0.0.0',
      siaddr: this.serverIP,
      giaddr: request.giaddr,
      chaddr: request.chaddr,
      sname: '',
      file: '',
      options,
    };

    return this.createDHCPPacket(
      dhcpNAK,
      this.serverIP,
      '255.255.255.255',
      this.serverMAC,
      BROADCAST_MAC,
      sourceInterface
    );
  }

  /**
   * Create DHCP packet with full network encapsulation
   */
  private createDHCPPacket(
    dhcp: DHCPPacket,
    sourceIP: string,
    destIP: string,
    sourceMAC: string,
    destMAC: string,
    interfaceId: string
  ): Packet {
    const udp: UDPDatagram = {
      sourcePort: DHCP_SERVER_PORT,
      destinationPort: DHCP_CLIENT_PORT,
      length: 0, // Will be calculated
      checksum: 0,
      payload: this.serializeDHCPPacket(dhcp),
    };

    const ipv4: IPv4Packet = {
      version: 4,
      headerLength: 20,
      dscp: 0,
      totalLength: 0,
      identification: Math.floor(Math.random() * 65535),
      flags: 0,
      fragmentOffset: 0,
      ttl: 64,
      protocol: IP_PROTOCOL.UDP,
      headerChecksum: 0,
      sourceIP,
      destinationIP: destIP,
      payload: udp,
    };

    const frame: EthernetFrame = {
      destinationMAC: destMAC,
      sourceMAC: sourceMAC,
      etherType: ETHER_TYPE.IPv4,
      payload: ipv4,
    };

    return {
      id: generatePacketId(),
      timestamp: Date.now(),
      frame,
      hops: [],
      status: 'in_transit',
    };
  }

  /**
   * Serialize DHCP packet to bytes (simplified)
   */
  private serializeDHCPPacket(dhcp: DHCPPacket): Uint8Array {
    // Simplified - in real implementation would be full binary encoding
    const encoder = new TextEncoder();
    return encoder.encode(JSON.stringify(dhcp));
  }

  /**
   * Get message type from DHCP options
   */
  private getMessageType(dhcp: DHCPPacket): DHCPMessageType | null {
    const option = dhcp.options.find(o => o.code === DHCP_OPTIONS.MESSAGE_TYPE);
    if (option) {
      return option.data as DHCPMessageType;
    }
    return null;
  }

  /**
   * Get requested IP from DHCP options
   */
  private getRequestedIP(dhcp: DHCPPacket): string | null {
    const option = dhcp.options.find(o => o.code === DHCP_OPTIONS.REQUESTED_IP);
    if (option) {
      return option.data as string;
    }
    return null;
  }

  // Helper functions
  private ipToNumber(ip: string): number {
    const parts = ip.split('.').map(Number);
    return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  }

  private numberToIP(num: number): string {
    return [
      (num >>> 24) & 255,
      (num >>> 16) & 255,
      (num >>> 8) & 255,
      num & 255,
    ].join('.');
  }

  private netmaskToPrefix(mask: string): number {
    const num = this.ipToNumber(mask);
    let count = 0;
    let n = num;
    while (n) {
      count += n & 1;
      n >>>= 1;
    }
    return count;
  }
}

/**
 * DHCP Client Service
 */
export class DHCPClient {
  private state: 'init' | 'selecting' | 'requesting' | 'bound' | 'renewing' | 'rebinding' = 'init';
  private xid: number = 0;
  private leasedIP: string = '';
  private serverIP: string = '';
  private subnetMask: string = '';
  private defaultGateway: string = '';
  private dnsServers: string[] = [];
  private leaseTime: number = 0;
  private leaseStart: number = 0;
  private macAddress: string;
  private hostname: string;
  private packetSender?: (packet: Packet, interfaceId: string) => void;
  private interfaceId: string = '';
  private onLeaseObtained?: (lease: DHCPClientLease) => void;
  private onLeaseExpired?: () => void;

  // Renewal (T1) and Rebinding (T2) times in seconds
  // T1 = 50% of lease time, T2 = 87.5% of lease time (RFC 2131)
  private t1Time: number = 0;  // Renewal time
  private t2Time: number = 0;  // Rebinding time

  // Timer IDs for cleanup
  private renewalTimer?: ReturnType<typeof setTimeout>;
  private rebindingTimer?: ReturnType<typeof setTimeout>;
  private expirationTimer?: ReturnType<typeof setTimeout>;

  constructor(macAddress: string, hostname: string = '') {
    this.macAddress = macAddress.toUpperCase();
    this.hostname = hostname;
  }

  /**
   * Set packet sender callback
   */
  setPacketSender(sender: (packet: Packet, interfaceId: string) => void): void {
    this.packetSender = sender;
  }

  /**
   * Set interface for DHCP operations
   */
  setInterface(interfaceId: string): void {
    this.interfaceId = interfaceId;
  }

  /**
   * Set callback for when lease is obtained
   */
  setOnLeaseObtained(callback: (lease: DHCPClientLease) => void): void {
    this.onLeaseObtained = callback;
  }

  /**
   * Set callback for when lease expires
   */
  setOnLeaseExpired(callback: () => void): void {
    this.onLeaseExpired = callback;
  }

  /**
   * Stop all timers (cleanup)
   */
  stopTimers(): void {
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = undefined;
    }
    if (this.rebindingTimer) {
      clearTimeout(this.rebindingTimer);
      this.rebindingTimer = undefined;
    }
    if (this.expirationTimer) {
      clearTimeout(this.expirationTimer);
      this.expirationTimer = undefined;
    }
  }

  /**
   * Start lease timers (T1, T2, expiration)
   */
  private startLeaseTimers(): void {
    this.stopTimers();

    if (this.leaseTime <= 0) {
      return;
    }

    // Calculate T1 (50% of lease) and T2 (87.5% of lease) if not provided by server
    if (this.t1Time <= 0) {
      this.t1Time = Math.floor(this.leaseTime * 0.5);
    }
    if (this.t2Time <= 0) {
      this.t2Time = Math.floor(this.leaseTime * 0.875);
    }

    // T1 - Renewal timer (unicast to original server)
    this.renewalTimer = setTimeout(() => {
      this.initiateRenewal();
    }, this.t1Time * 1000);

    // T2 - Rebinding timer (broadcast to any server)
    this.rebindingTimer = setTimeout(() => {
      this.initiateRebinding();
    }, this.t2Time * 1000);

    // Lease expiration timer
    this.expirationTimer = setTimeout(() => {
      this.handleLeaseExpiration();
    }, this.leaseTime * 1000);
  }

  /**
   * Initiate lease renewal (T1 expired)
   * Sends unicast REQUEST to the original DHCP server
   */
  private initiateRenewal(): void {
    if (this.state !== 'bound') {
      return;
    }

    this.state = 'renewing';
    const packet = this.createRenewalRequest(false);

    if (this.packetSender && packet) {
      this.packetSender(packet, this.interfaceId);
    }
  }

  /**
   * Initiate lease rebinding (T2 expired)
   * Broadcasts REQUEST to any DHCP server
   */
  private initiateRebinding(): void {
    if (this.state !== 'bound' && this.state !== 'renewing') {
      return;
    }

    this.state = 'rebinding';
    const packet = this.createRenewalRequest(true);

    if (this.packetSender && packet) {
      this.packetSender(packet, this.interfaceId);
    }
  }

  /**
   * Handle lease expiration
   */
  private handleLeaseExpiration(): void {
    this.stopTimers();
    this.state = 'init';
    const expiredIP = this.leasedIP;
    this.leasedIP = '';
    this.serverIP = '';
    this.subnetMask = '';
    this.defaultGateway = '';
    this.dnsServers = [];
    this.leaseTime = 0;
    this.t1Time = 0;
    this.t2Time = 0;

    if (this.onLeaseExpired) {
      this.onLeaseExpired();
    }
  }

  /**
   * Create renewal/rebinding request packet
   * @param broadcast - true for rebinding (broadcast), false for renewal (unicast)
   */
  private createRenewalRequest(broadcast: boolean): Packet {
    this.xid = Math.floor(Math.random() * 0xFFFFFFFF);

    const options: DHCPOption[] = [
      { code: DHCP_OPTIONS.MESSAGE_TYPE, data: DHCPMessageType.REQUEST },
      { code: DHCP_OPTIONS.END, data: new Uint8Array(0) },
    ];

    const dhcpRequest: DHCPPacket = {
      op: 1, // BOOTREQUEST
      htype: 1,
      hlen: 6,
      hops: 0,
      xid: this.xid,
      secs: 0,
      flags: broadcast ? 0x8000 : 0, // Broadcast flag only for rebinding
      ciaddr: this.leasedIP, // Client's current IP (renewal/rebinding uses ciaddr)
      yiaddr: '0.0.0.0',
      siaddr: '0.0.0.0',
      giaddr: '0.0.0.0',
      chaddr: this.macAddress,
      sname: '',
      file: '',
      options,
    };

    // Create packet with appropriate addressing
    const udp: UDPDatagram = {
      sourcePort: DHCP_CLIENT_PORT,
      destinationPort: DHCP_SERVER_PORT,
      length: 0,
      checksum: 0,
      payload: this.serializeDHCPPacket(dhcpRequest),
    };

    const ipv4: IPv4Packet = {
      version: 4,
      headerLength: 20,
      dscp: 0,
      totalLength: 0,
      identification: Math.floor(Math.random() * 65535),
      flags: 0,
      fragmentOffset: 0,
      ttl: 64,
      protocol: IP_PROTOCOL.UDP,
      headerChecksum: 0,
      sourceIP: this.leasedIP,
      destinationIP: broadcast ? '255.255.255.255' : this.serverIP,
      payload: udp,
    };

    const frame: EthernetFrame = {
      destinationMAC: broadcast ? BROADCAST_MAC : 'FF:FF:FF:FF:FF:FF', // Would need ARP for unicast in real impl
      sourceMAC: this.macAddress,
      etherType: ETHER_TYPE.IPv4,
      payload: ipv4,
    };

    return {
      id: generatePacketId(),
      timestamp: Date.now(),
      frame,
      hops: [],
      status: 'in_transit',
    };
  }

  /**
   * Manually trigger lease renewal (for testing or user commands)
   */
  renew(): Packet | null {
    if (this.state !== 'bound' && this.state !== 'renewing' && this.state !== 'rebinding') {
      return null;
    }

    this.state = 'renewing';
    return this.createRenewalRequest(false);
  }

  /**
   * Get remaining lease time in seconds
   */
  getRemainingLeaseTime(): number {
    if (this.state !== 'bound' && this.state !== 'renewing' && this.state !== 'rebinding') {
      return 0;
    }

    const elapsed = (Date.now() - this.leaseStart) / 1000;
    const remaining = this.leaseTime - elapsed;
    return Math.max(0, Math.floor(remaining));
  }

  /**
   * Get T1 (renewal) time in seconds
   */
  getT1Time(): number {
    return this.t1Time;
  }

  /**
   * Get T2 (rebinding) time in seconds
   */
  getT2Time(): number {
    return this.t2Time;
  }

  /**
   * Start DHCP discovery process
   */
  discover(): Packet {
    this.state = 'selecting';
    this.xid = Math.floor(Math.random() * 0xFFFFFFFF);

    const options: DHCPOption[] = [
      { code: DHCP_OPTIONS.MESSAGE_TYPE, data: DHCPMessageType.DISCOVER },
      { code: DHCP_OPTIONS.PARAMETER_REQUEST_LIST, data: new Uint8Array([
        DHCP_OPTIONS.SUBNET_MASK,
        DHCP_OPTIONS.ROUTER,
        DHCP_OPTIONS.DNS_SERVER,
        DHCP_OPTIONS.DOMAIN_NAME,
      ])},
      { code: DHCP_OPTIONS.END, data: new Uint8Array(0) },
    ];

    const dhcpDiscover: DHCPPacket = {
      op: 1, // BOOTREQUEST
      htype: 1,
      hlen: 6,
      hops: 0,
      xid: this.xid,
      secs: 0,
      flags: 0x8000, // Broadcast flag
      ciaddr: '0.0.0.0',
      yiaddr: '0.0.0.0',
      siaddr: '0.0.0.0',
      giaddr: '0.0.0.0',
      chaddr: this.macAddress,
      sname: '',
      file: '',
      options,
    };

    return this.createDHCPPacket(dhcpDiscover);
  }

  /**
   * Process incoming DHCP packet
   */
  processPacket(dhcpPacket: DHCPPacket): Packet | null {
    // Verify this is for us (MAC address check)
    if (dhcpPacket.chaddr.toUpperCase() !== this.macAddress) {
      return null;
    }

    // Verify XID matches our transaction (RFC 2131 requires this)
    // Only validate if we're in an active state expecting a response
    if (this.state !== 'init' && dhcpPacket.xid !== this.xid) {
      // XID mismatch - this response is not for our current transaction
      return null;
    }

    const messageType = this.getMessageType(dhcpPacket);

    switch (messageType) {
      case DHCPMessageType.OFFER:
        return this.handleOffer(dhcpPacket);
      case DHCPMessageType.ACK:
        return this.handleAck(dhcpPacket);
      case DHCPMessageType.NAK:
        return this.handleNak(dhcpPacket);
      default:
        return null;
    }
  }

  /**
   * Handle DHCP Offer - send Request
   */
  private handleOffer(dhcpPacket: DHCPPacket): Packet | null {
    if (this.state !== 'selecting') {
      return null;
    }

    // Accept the first offer
    this.state = 'requesting';
    const offeredIP = dhcpPacket.yiaddr;
    const serverID = this.getServerIdentifier(dhcpPacket);

    const options: DHCPOption[] = [
      { code: DHCP_OPTIONS.MESSAGE_TYPE, data: DHCPMessageType.REQUEST },
      { code: DHCP_OPTIONS.REQUESTED_IP, data: offeredIP },
    ];

    if (serverID) {
      options.push({ code: DHCP_OPTIONS.SERVER_IDENTIFIER, data: serverID });
    }

    options.push({ code: DHCP_OPTIONS.END, data: new Uint8Array(0) });

    const dhcpRequest: DHCPPacket = {
      op: 1,
      htype: 1,
      hlen: 6,
      hops: 0,
      xid: this.xid,
      secs: 0,
      flags: 0x8000,
      ciaddr: '0.0.0.0',
      yiaddr: '0.0.0.0',
      siaddr: '0.0.0.0',
      giaddr: '0.0.0.0',
      chaddr: this.macAddress,
      sname: '',
      file: '',
      options,
    };

    return this.createDHCPPacket(dhcpRequest);
  }

  /**
   * Handle DHCP ACK - lease obtained or renewed
   */
  private handleAck(dhcpPacket: DHCPPacket): Packet | null {
    const wasRenewing = this.state === 'renewing' || this.state === 'rebinding';

    this.state = 'bound';
    // For renewal/rebinding, yiaddr may be 0.0.0.0 (keep existing IP)
    if (dhcpPacket.yiaddr && dhcpPacket.yiaddr !== '0.0.0.0') {
      this.leasedIP = dhcpPacket.yiaddr;
    }
    if (dhcpPacket.siaddr && dhcpPacket.siaddr !== '0.0.0.0') {
      this.serverIP = dhcpPacket.siaddr;
    }
    this.leaseStart = Date.now();

    // Reset T1/T2 before extracting (they may be in options)
    this.t1Time = 0;
    this.t2Time = 0;

    // Extract options
    for (const option of dhcpPacket.options) {
      switch (option.code) {
        case DHCP_OPTIONS.SUBNET_MASK:
          this.subnetMask = option.data as string;
          break;
        case DHCP_OPTIONS.ROUTER:
          const routers = option.data as string[];
          this.defaultGateway = routers[0] || '';
          break;
        case DHCP_OPTIONS.DNS_SERVER:
          this.dnsServers = option.data as string[];
          break;
        case DHCP_OPTIONS.LEASE_TIME:
          this.leaseTime = option.data as number;
          break;
        case DHCP_OPTIONS.RENEWAL_TIME:
          this.t1Time = option.data as number;
          break;
        case DHCP_OPTIONS.REBINDING_TIME:
          this.t2Time = option.data as number;
          break;
      }
    }

    // Start lease timers (T1, T2, expiration)
    this.startLeaseTimers();

    // Notify lease obtained (also fires on renewal)
    if (this.onLeaseObtained) {
      this.onLeaseObtained({
        ipAddress: this.leasedIP,
        subnetMask: this.subnetMask,
        defaultGateway: this.defaultGateway,
        dnsServers: this.dnsServers,
        leaseTime: this.leaseTime,
        dhcpServer: this.serverIP,
      });
    }

    return null;
  }

  /**
   * Handle DHCP NAK - request denied
   */
  private handleNak(_dhcpPacket: DHCPPacket): Packet | null {
    // Stop all lease timers
    this.stopTimers();

    this.state = 'init';
    this.leasedIP = '';
    this.serverIP = '';
    this.subnetMask = '';
    this.defaultGateway = '';
    this.dnsServers = [];
    this.leaseTime = 0;
    this.t1Time = 0;
    this.t2Time = 0;

    // Restart discovery
    return this.discover();
  }

  /**
   * Release the current lease
   */
  release(): Packet | null {
    if (this.state !== 'bound' && this.state !== 'renewing' && this.state !== 'rebinding') {
      return null;
    }

    // Stop all lease timers
    this.stopTimers();

    const options: DHCPOption[] = [
      { code: DHCP_OPTIONS.MESSAGE_TYPE, data: DHCPMessageType.RELEASE },
      { code: DHCP_OPTIONS.SERVER_IDENTIFIER, data: this.serverIP },
      { code: DHCP_OPTIONS.END, data: new Uint8Array(0) },
    ];

    const dhcpRelease: DHCPPacket = {
      op: 1,
      htype: 1,
      hlen: 6,
      hops: 0,
      xid: Math.floor(Math.random() * 0xFFFFFFFF),
      secs: 0,
      flags: 0,
      ciaddr: this.leasedIP,
      yiaddr: '0.0.0.0',
      siaddr: '0.0.0.0',
      giaddr: '0.0.0.0',
      chaddr: this.macAddress,
      sname: '',
      file: '',
      options,
    };

    this.state = 'init';
    this.leasedIP = '';
    this.serverIP = '';
    this.subnetMask = '';
    this.defaultGateway = '';
    this.dnsServers = [];
    this.leaseTime = 0;
    this.t1Time = 0;
    this.t2Time = 0;

    return this.createDHCPPacket(dhcpRelease);
  }

  /**
   * Get current lease info
   */
  getLease(): DHCPClientLease | null {
    if (this.state !== 'bound') {
      return null;
    }

    return {
      ipAddress: this.leasedIP,
      subnetMask: this.subnetMask,
      defaultGateway: this.defaultGateway,
      dnsServers: this.dnsServers,
      leaseTime: this.leaseTime,
      dhcpServer: this.serverIP,
    };
  }

  /**
   * Get current state
   */
  getState(): string {
    return this.state;
  }

  /**
   * Create DHCP packet with network encapsulation
   */
  private createDHCPPacket(dhcp: DHCPPacket): Packet {
    const udp: UDPDatagram = {
      sourcePort: DHCP_CLIENT_PORT,
      destinationPort: DHCP_SERVER_PORT,
      length: 0,
      checksum: 0,
      payload: this.serializeDHCPPacket(dhcp),
    };

    const ipv4: IPv4Packet = {
      version: 4,
      headerLength: 20,
      dscp: 0,
      totalLength: 0,
      identification: Math.floor(Math.random() * 65535),
      flags: 0,
      fragmentOffset: 0,
      ttl: 64,
      protocol: IP_PROTOCOL.UDP,
      headerChecksum: 0,
      sourceIP: '0.0.0.0',
      destinationIP: '255.255.255.255',
      payload: udp,
    };

    const frame: EthernetFrame = {
      destinationMAC: BROADCAST_MAC,
      sourceMAC: this.macAddress,
      etherType: ETHER_TYPE.IPv4,
      payload: ipv4,
    };

    return {
      id: generatePacketId(),
      timestamp: Date.now(),
      frame,
      hops: [],
      status: 'in_transit',
    };
  }

  private serializeDHCPPacket(dhcp: DHCPPacket): Uint8Array {
    const encoder = new TextEncoder();
    return encoder.encode(JSON.stringify(dhcp));
  }

  private getMessageType(dhcp: DHCPPacket): DHCPMessageType | null {
    const option = dhcp.options.find(o => o.code === DHCP_OPTIONS.MESSAGE_TYPE);
    return option ? option.data as DHCPMessageType : null;
  }

  private getServerIdentifier(dhcp: DHCPPacket): string | null {
    const option = dhcp.options.find(o => o.code === DHCP_OPTIONS.SERVER_IDENTIFIER);
    return option ? option.data as string : null;
  }
}

// Lease info returned to client
export interface DHCPClientLease {
  ipAddress: string;
  subnetMask: string;
  defaultGateway: string;
  dnsServers: string[];
  leaseTime: number;
  dhcpServer: string;
}

/**
 * Parse DHCP packet from UDP payload
 */
export function parseDHCPPacket(payload: Uint8Array): DHCPPacket | null {
  try {
    const decoder = new TextDecoder();
    const json = decoder.decode(payload);
    return JSON.parse(json) as DHCPPacket;
  } catch {
    return null;
  }
}

/**
 * Check if a UDP packet is DHCP
 */
export function isDHCPPacket(udp: UDPDatagram): boolean {
  return (
    (udp.sourcePort === DHCP_CLIENT_PORT && udp.destinationPort === DHCP_SERVER_PORT) ||
    (udp.sourcePort === DHCP_SERVER_PORT && udp.destinationPort === DHCP_CLIENT_PORT)
  );
}
