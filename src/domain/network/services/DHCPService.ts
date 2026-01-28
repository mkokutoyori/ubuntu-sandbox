/**
 * DHCPService - DHCP Server and Client Services
 *
 * Implements both DHCP server (for routers) and DHCP client (for PCs)
 * following RFC 2131 specifications.
 *
 * Design Patterns:
 * - State Machine (Client): INIT -> SELECTING -> REQUESTING -> BOUND -> RENEWING
 * - Service (DDD): Stateful services managing protocol operations
 * - Observer: Callbacks for state changes and events
 *
 * @example Server:
 * ```typescript
 * const server = new DHCPServerService({
 *   serverIP: new IPAddress('192.168.1.1'),
 *   poolStart: new IPAddress('192.168.1.100'),
 *   poolEnd: new IPAddress('192.168.1.200'),
 *   subnetMask: new IPAddress('255.255.255.0'),
 *   gateway: new IPAddress('192.168.1.1'),
 *   dnsServers: [new IPAddress('8.8.8.8')],
 *   leaseTime: 86400
 * });
 *
 * const offer = server.handleDiscover(discoverPacket);
 * const ack = server.handleRequest(requestPacket);
 * ```
 *
 * @example Client:
 * ```typescript
 * const client = new DHCPClientService(macAddress, 'hostname');
 * const discover = client.createDiscover();
 * // Send discover, receive offer
 * client.handleOffer(offer);
 * const request = client.createRequest();
 * // Send request, receive ack
 * client.handleAck(ack);
 * // Now in BOUND state with lease info
 * ```
 */

import { IPAddress } from '../value-objects/IPAddress';
import { MACAddress } from '../value-objects/MACAddress';
import { DHCPPacket, DHCPMessageType, DHCPOperation, DHCPOption } from '../entities/DHCPPacket';

// ============== Server Types ==============

/**
 * DHCP Server configuration
 */
export interface DHCPServerConfig {
  serverIP: IPAddress;
  poolStart: IPAddress;
  poolEnd: IPAddress;
  subnetMask: IPAddress;
  gateway: IPAddress;
  dnsServers: IPAddress[];
  leaseTime: number; // seconds
  domainName?: string;
}

/**
 * DHCP Lease information
 */
export interface DHCPLease {
  ipAddress: IPAddress;
  macAddress: MACAddress;
  hostname?: string;
  leaseStart: number; // timestamp
  leaseTime: number; // seconds
  expiresAt: number; // timestamp
}

/**
 * DHCP Server statistics
 */
export interface DHCPServerStatistics {
  discoversReceived: number;
  offersSent: number;
  requestsReceived: number;
  acksSent: number;
  naksSent: number;
  releasesReceived: number;
  declinesReceived: number;
  activeLeases: number;
  totalLeasesIssued: number;
}

// ============== Client Types ==============

/**
 * DHCP Client states (RFC 2131 state machine)
 */
export enum DHCPClientState {
  INIT = 'INIT',
  SELECTING = 'SELECTING',
  REQUESTING = 'REQUESTING',
  BOUND = 'BOUND',
  RENEWING = 'RENEWING',
  REBINDING = 'REBINDING'
}

/**
 * Client lease information
 */
export interface DHCPClientLeaseInfo {
  ipAddress: IPAddress;
  subnetMask: IPAddress;
  gateway?: IPAddress;
  dnsServers: IPAddress[];
  serverIP: IPAddress;
  leaseTime: number;
  renewalTime: number;
  rebindingTime: number;
  leaseObtained: number;
  domainName?: string;
}

// ============== DHCP Server Service ==============

/**
 * DHCP Server Service
 * Manages IP address allocation and lease management
 */
export class DHCPServerService {
  private readonly config: DHCPServerConfig;
  private readonly leases: Map<string, DHCPLease>; // MAC -> Lease
  private readonly ipLeases: Map<string, DHCPLease>; // IP -> Lease
  private readonly reservations: Map<string, IPAddress>; // MAC -> IP
  private readonly pendingOffers: Map<string, { ip: IPAddress; timestamp: number }>; // MAC -> offered IP
  private readonly declinedIPs: Set<string>; // IPs that were declined
  private readonly poolStart: number;
  private readonly poolEnd: number;
  private statistics: DHCPServerStatistics;

  constructor(config: DHCPServerConfig) {
    this.config = config;
    this.leases = new Map();
    this.ipLeases = new Map();
    this.reservations = new Map();
    this.pendingOffers = new Map();
    this.declinedIPs = new Set();

    this.poolStart = IPAddress.toNumber(config.poolStart);
    this.poolEnd = IPAddress.toNumber(config.poolEnd);

    this.statistics = {
      discoversReceived: 0,
      offersSent: 0,
      requestsReceived: 0,
      acksSent: 0,
      naksSent: 0,
      releasesReceived: 0,
      declinesReceived: 0,
      activeLeases: 0,
      totalLeasesIssued: 0
    };
  }

  // ============== Configuration Getters ==============

  public getServerIP(): IPAddress {
    return this.config.serverIP;
  }

  public getPoolStart(): IPAddress {
    return this.config.poolStart;
  }

  public getPoolEnd(): IPAddress {
    return this.config.poolEnd;
  }

  public getSubnetMask(): IPAddress {
    return this.config.subnetMask;
  }

  public getPoolSize(): number {
    return this.poolEnd - this.poolStart + 1;
  }

  public getAvailableCount(): number {
    let available = this.getPoolSize();

    // Subtract active leases
    available -= this.leases.size;

    // Subtract declined IPs
    available -= this.declinedIPs.size;

    return Math.max(0, available);
  }

  // ============== DHCP Message Handlers ==============

  /**
   * Handles DHCP DISCOVER message
   * Returns OFFER or null if no IP available
   */
  public handleDiscover(discover: DHCPPacket): DHCPPacket | null {
    this.statistics.discoversReceived++;

    const clientMAC = discover.getClientMAC();
    const macKey = clientMAC.toString();

    // Clean expired pending offers
    this.cleanPendingOffers();

    // Check for existing pending offer for this client
    const existingOffer = this.pendingOffers.get(macKey);
    if (existingOffer) {
      this.statistics.offersSent++;
      return this.createOfferPacket(discover, existingOffer.ip);
    }

    // Find an IP for this client
    const ip = this.allocateIP(clientMAC, discover.getRequestedIP());
    if (!ip) {
      return null; // Pool exhausted
    }

    // Store pending offer
    this.pendingOffers.set(macKey, {
      ip,
      timestamp: Date.now()
    });

    this.statistics.offersSent++;
    return this.createOfferPacket(discover, ip);
  }

  /**
   * Handles DHCP REQUEST message
   * Returns ACK, NAK, or null (not for this server)
   */
  public handleRequest(request: DHCPPacket): DHCPPacket | null {
    this.statistics.requestsReceived++;

    const clientMAC = request.getClientMAC();
    const macKey = clientMAC.toString();
    const requestedIP = request.getRequestedIP();
    const serverID = request.getServerIdentifier();

    // Check if request is for this server
    if (serverID && !serverID.equals(this.config.serverIP)) {
      // Request is for another server, ignore
      return null;
    }

    // Validate the request
    const pendingOffer = this.pendingOffers.get(macKey);

    // Check if we have a pending offer for this client
    if (!pendingOffer && !this.leases.has(macKey)) {
      // No pending offer and no existing lease - send NAK
      this.statistics.naksSent++;
      return DHCPPacket.createNak(request, this.config.serverIP, 'No lease available');
    }

    // Determine the IP to assign
    let assignedIP: IPAddress;

    if (pendingOffer && requestedIP && pendingOffer.ip.equals(requestedIP)) {
      // Valid request for offered IP
      assignedIP = pendingOffer.ip;
    } else if (this.leases.has(macKey)) {
      // Renewal request
      const existingLease = this.leases.get(macKey)!;
      assignedIP = existingLease.ipAddress;
    } else if (pendingOffer) {
      // Use pending offer IP
      assignedIP = pendingOffer.ip;
    } else {
      // Invalid request
      this.statistics.naksSent++;
      return DHCPPacket.createNak(request, this.config.serverIP, 'Invalid request');
    }

    // Create lease
    const hostname = request.getHostname();
    const now = Date.now();
    const lease: DHCPLease = {
      ipAddress: assignedIP,
      macAddress: clientMAC,
      hostname,
      leaseStart: now,
      leaseTime: this.config.leaseTime,
      expiresAt: now + (this.config.leaseTime * 1000)
    };

    // Store lease
    this.leases.set(macKey, lease);
    this.ipLeases.set(assignedIP.toString(), lease);

    // Remove pending offer
    this.pendingOffers.delete(macKey);

    // Update statistics
    this.statistics.acksSent++;
    this.statistics.activeLeases = this.leases.size;
    this.statistics.totalLeasesIssued++;

    return DHCPPacket.createAck(
      request,
      assignedIP,
      this.config.serverIP,
      this.config.subnetMask,
      this.config.gateway,
      this.config.dnsServers,
      this.config.leaseTime
    );
  }

  /**
   * Handles DHCP RELEASE message
   */
  public handleRelease(release: DHCPPacket): void {
    this.statistics.releasesReceived++;

    const clientMAC = release.getClientMAC();
    const macKey = clientMAC.toString();
    const clientIP = release.getClientIP();

    // Find and remove lease
    const lease = this.leases.get(macKey);
    if (lease && clientIP && lease.ipAddress.equals(clientIP)) {
      this.leases.delete(macKey);
      this.ipLeases.delete(clientIP.toString());
      this.statistics.activeLeases = this.leases.size;
    }
  }

  /**
   * Handles DHCP DECLINE message
   * Marks IP as unavailable due to conflict
   */
  public handleDecline(decline: DHCPPacket): void {
    this.statistics.declinesReceived++;

    const requestedIP = decline.getRequestedIP();
    const clientMAC = decline.getClientMAC();
    const macKey = clientMAC.toString();

    if (requestedIP) {
      // Mark IP as declined (unavailable)
      this.declinedIPs.add(requestedIP.toString());

      // Remove any pending offer or lease
      this.pendingOffers.delete(macKey);

      const lease = this.leases.get(macKey);
      if (lease && lease.ipAddress.equals(requestedIP)) {
        this.leases.delete(macKey);
        this.ipLeases.delete(requestedIP.toString());
        this.statistics.activeLeases = this.leases.size;
      }
    }
  }

  // ============== IP Allocation ==============

  /**
   * Allocates an IP address for a client
   */
  private allocateIP(clientMAC: MACAddress, requestedIP?: IPAddress): IPAddress | null {
    const macKey = clientMAC.toString();

    // Check for reservation
    const reserved = this.reservations.get(macKey);
    if (reserved) {
      return reserved;
    }

    // Check for existing lease (renewal)
    const existingLease = this.leases.get(macKey);
    if (existingLease) {
      return existingLease.ipAddress;
    }

    // Check if requested IP is valid and available
    if (requestedIP && this.isIPInPool(requestedIP) && this.isIPAvailable(requestedIP)) {
      return requestedIP;
    }

    // Find next available IP
    return this.findNextAvailableIP();
  }

  /**
   * Checks if IP is within the pool range
   */
  private isIPInPool(ip: IPAddress): boolean {
    const ipNum = IPAddress.toNumber(ip);
    return ipNum >= this.poolStart && ipNum <= this.poolEnd;
  }

  /**
   * Checks if IP is available for allocation
   */
  private isIPAvailable(ip: IPAddress): boolean {
    const ipKey = ip.toString();

    // Check if declined
    if (this.declinedIPs.has(ipKey)) {
      return false;
    }

    // Check if already leased
    if (this.ipLeases.has(ipKey)) {
      return false;
    }

    // Check if reserved for another client
    for (const [, reservedIP] of this.reservations) {
      if (reservedIP.equals(ip)) {
        return false;
      }
    }

    // Check pending offers
    for (const [, offer] of this.pendingOffers) {
      if (offer.ip.equals(ip)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Finds the next available IP in the pool
   */
  private findNextAvailableIP(): IPAddress | null {
    for (let ipNum = this.poolStart; ipNum <= this.poolEnd; ipNum++) {
      const ip = IPAddress.fromNumber(ipNum);
      if (this.isIPAvailable(ip)) {
        return ip;
      }
    }
    return null;
  }

  // ============== Helper Methods ==============

  /**
   * Creates OFFER packet
   */
  private createOfferPacket(discover: DHCPPacket, offeredIP: IPAddress): DHCPPacket {
    return DHCPPacket.createOffer(
      discover,
      offeredIP,
      this.config.serverIP,
      this.config.subnetMask,
      this.config.gateway,
      this.config.dnsServers,
      this.config.leaseTime
    );
  }

  /**
   * Cleans expired pending offers (30 second timeout)
   */
  private cleanPendingOffers(): void {
    const now = Date.now();
    const timeout = 30000; // 30 seconds

    for (const [mac, offer] of this.pendingOffers) {
      if (now - offer.timestamp > timeout) {
        this.pendingOffers.delete(mac);
      }
    }
  }

  /**
   * Cleans expired leases
   */
  public cleanExpiredLeases(): void {
    const now = Date.now();

    for (const [mac, lease] of this.leases) {
      if (now >= lease.expiresAt) {
        this.leases.delete(mac);
        this.ipLeases.delete(lease.ipAddress.toString());
      }
    }

    this.statistics.activeLeases = this.leases.size;
  }

  // ============== Lease Management ==============

  /**
   * Gets lease by MAC address
   */
  public getLease(mac: MACAddress): DHCPLease | undefined {
    return this.leases.get(mac.toString());
  }

  /**
   * Gets lease by IP address
   */
  public getLeaseByIP(ip: IPAddress): DHCPLease | undefined {
    return this.ipLeases.get(ip.toString());
  }

  /**
   * Gets all active leases
   */
  public getActiveLeases(): DHCPLease[] {
    return Array.from(this.leases.values());
  }

  // ============== Reservations ==============

  /**
   * Adds a static IP reservation
   */
  public addReservation(mac: MACAddress, ip: IPAddress): void {
    this.reservations.set(mac.toString(), ip);
  }

  /**
   * Removes a static IP reservation
   */
  public removeReservation(mac: MACAddress): void {
    this.reservations.delete(mac.toString());
  }

  /**
   * Gets all reservations
   */
  public getReservations(): Map<string, IPAddress> {
    return new Map(this.reservations);
  }

  // ============== Statistics ==============

  /**
   * Gets server statistics
   */
  public getStatistics(): Readonly<DHCPServerStatistics> {
    return { ...this.statistics };
  }

  /**
   * Resets statistics
   */
  public resetStatistics(): void {
    this.statistics = {
      discoversReceived: 0,
      offersSent: 0,
      requestsReceived: 0,
      acksSent: 0,
      naksSent: 0,
      releasesReceived: 0,
      declinesReceived: 0,
      activeLeases: this.leases.size,
      totalLeasesIssued: 0
    };
  }
}

// ============== DHCP Client Service ==============

/**
 * DHCP Client Service
 * Implements DHCP client state machine for obtaining IP configuration
 */
export class DHCPClientService {
  private readonly macAddress: MACAddress;
  private readonly hostname?: string;
  private state: DHCPClientState;
  private transactionId: number;
  private selectedOffer: DHCPPacket | null;
  private leaseInfo: DHCPClientLeaseInfo | null;
  private discoverStartTime: number;
  private retryCount: number;
  private readonly discoverTimeout: number; // milliseconds

  constructor(macAddress: MACAddress, hostname?: string, discoverTimeout: number = 10000) {
    this.macAddress = macAddress;
    this.hostname = hostname;
    this.state = DHCPClientState.INIT;
    this.transactionId = 0;
    this.selectedOffer = null;
    this.leaseInfo = null;
    this.discoverStartTime = 0;
    this.retryCount = 0;
    this.discoverTimeout = discoverTimeout;
  }

  // ============== State Getters ==============

  public getState(): DHCPClientState {
    return this.state;
  }

  public getTransactionId(): number {
    return this.transactionId;
  }

  public getSelectedOffer(): DHCPPacket | null {
    return this.selectedOffer;
  }

  public getLeaseInfo(): DHCPClientLeaseInfo | null {
    return this.leaseInfo;
  }

  public getRetryCount(): number {
    return this.retryCount;
  }

  // ============== State Transitions ==============

  /**
   * Starts DHCP discovery process
   */
  public startDiscover(): void {
    this.state = DHCPClientState.SELECTING;
    this.transactionId = this.generateTransactionId();
    this.selectedOffer = null;
    this.discoverStartTime = Date.now();
  }

  /**
   * Starts lease renewal
   */
  public startRenewal(): void {
    if (this.state === DHCPClientState.BOUND && this.leaseInfo) {
      this.state = DHCPClientState.RENEWING;
    }
  }

  /**
   * Releases current lease
   */
  public release(): void {
    this.state = DHCPClientState.INIT;
    this.leaseInfo = null;
    this.selectedOffer = null;
  }

  /**
   * Resets to INIT state
   */
  public reset(): void {
    this.state = DHCPClientState.INIT;
    this.transactionId = 0;
    this.selectedOffer = null;
    this.leaseInfo = null;
    this.retryCount = 0;
  }

  // ============== Packet Creation ==============

  /**
   * Creates DHCP DISCOVER packet
   */
  public createDiscover(): DHCPPacket {
    if (this.transactionId === 0) {
      this.transactionId = this.generateTransactionId();
    }

    const discover = DHCPPacket.createDiscover(
      this.macAddress,
      this.hostname,
      this.leaseInfo?.ipAddress // Request previous IP if available
    );

    // Store transaction ID from generated discover
    this.transactionId = discover.getTransactionId();

    return discover;
  }

  /**
   * Creates DHCP REQUEST packet
   */
  public createRequest(): DHCPPacket | null {
    if (!this.selectedOffer) {
      return null;
    }

    return DHCPPacket.createRequest(this.selectedOffer, this.macAddress);
  }

  /**
   * Creates DHCP RELEASE packet
   */
  public createRelease(): DHCPPacket | null {
    if (this.state !== DHCPClientState.BOUND || !this.leaseInfo) {
      return null;
    }

    return DHCPPacket.createRelease(
      this.leaseInfo.ipAddress,
      this.macAddress,
      this.leaseInfo.serverIP
    );
  }

  /**
   * Creates DHCP REQUEST for renewal
   */
  public createRenewRequest(): DHCPPacket | null {
    if (!this.leaseInfo) {
      return null;
    }

    // Renewal request includes current IP in ciaddr
    return new DHCPPacket({
      operation: DHCPOperation.BOOTREQUEST,
      transactionId: this.generateTransactionId(),
      clientMAC: this.macAddress,
      clientIP: this.leaseInfo.ipAddress,
      messageType: DHCPMessageType.REQUEST,
      broadcast: false, // Renewal is unicast
      options: [
        {
          code: DHCPOption.SERVER_IDENTIFIER,
          data: this.leaseInfo.serverIP.toBytes()
        }
      ]
    });
  }

  // ============== Message Handlers ==============

  /**
   * Handles received DHCP OFFER
   */
  public handleOffer(offer: DHCPPacket): boolean {
    // Must be in SELECTING state
    if (this.state !== DHCPClientState.SELECTING) {
      return false;
    }

    // Verify transaction ID matches
    if (offer.getTransactionId() !== this.transactionId) {
      return false;
    }

    // Verify message type
    if (offer.getMessageType() !== DHCPMessageType.OFFER) {
      return false;
    }

    // Accept this offer
    this.selectedOffer = offer;
    this.state = DHCPClientState.REQUESTING;

    return true;
  }

  /**
   * Handles received DHCP ACK
   */
  public handleAck(ack: DHCPPacket): boolean {
    // Must be in REQUESTING or RENEWING state
    if (this.state !== DHCPClientState.REQUESTING && this.state !== DHCPClientState.RENEWING) {
      return false;
    }

    // Verify message type
    if (ack.getMessageType() !== DHCPMessageType.ACK) {
      return false;
    }

    // Extract lease information
    const yourIP = ack.getYourIP();
    const subnetMask = ack.getSubnetMask();
    const serverID = ack.getServerIdentifier() ?? ack.getServerIP();

    if (!yourIP || !subnetMask || !serverID) {
      return false;
    }

    const leaseTime = ack.getLeaseTime() ?? 86400;

    this.leaseInfo = {
      ipAddress: yourIP,
      subnetMask,
      gateway: ack.getRouter(),
      dnsServers: ack.getDNSServers(),
      serverIP: serverID,
      leaseTime,
      renewalTime: Math.floor(leaseTime / 2),
      rebindingTime: Math.floor(leaseTime * 0.875),
      leaseObtained: Date.now(),
      domainName: ack.getDomainName()
    };

    this.state = DHCPClientState.BOUND;
    this.retryCount = 0;

    return true;
  }

  /**
   * Handles received DHCP NAK
   */
  public handleNak(nak: DHCPPacket): boolean {
    // Verify message type
    if (nak.getMessageType() !== DHCPMessageType.NAK) {
      return false;
    }

    // Reset to INIT state
    this.state = DHCPClientState.INIT;
    this.selectedOffer = null;

    return true;
  }

  // ============== Timeout Handling ==============

  /**
   * Checks if DISCOVER has timed out
   */
  public isDiscoverTimeout(): boolean {
    if (this.state !== DHCPClientState.SELECTING) {
      return false;
    }

    return Date.now() - this.discoverStartTime > this.discoverTimeout;
  }

  /**
   * Checks if lease needs renewal
   */
  public needsRenewal(): boolean {
    if (!this.leaseInfo || this.state !== DHCPClientState.BOUND) {
      return false;
    }

    const elapsed = (Date.now() - this.leaseInfo.leaseObtained) / 1000;
    return elapsed >= this.leaseInfo.renewalTime;
  }

  /**
   * Checks if lease has expired
   */
  public isLeaseExpired(): boolean {
    if (!this.leaseInfo) {
      return false;
    }

    const elapsed = (Date.now() - this.leaseInfo.leaseObtained) / 1000;
    return elapsed >= this.leaseInfo.leaseTime;
  }

  /**
   * Increments retry count
   */
  public incrementRetry(): void {
    this.retryCount++;
  }

  /**
   * Resets retry count
   */
  public resetRetry(): void {
    this.retryCount = 0;
  }

  // ============== Private Helpers ==============

  /**
   * Generates random transaction ID
   */
  private generateTransactionId(): number {
    return Math.floor(Math.random() * 0xFFFFFFFF);
  }
}
