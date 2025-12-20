/**
 * NetworkStack - Common network stack for all devices
 * Handles ARP, routing, and packet processing
 */

import {
  Packet,
  EthernetFrame,
  ARPPacket,
  IPv4Packet,
  ICMPPacket,
  ARPOpcode,
  ICMPType,
  ETHER_TYPE,
  IP_PROTOCOL,
  BROADCAST_MAC,
  createARPRequest,
  createARPReply,
  createICMPEchoReply,
  createICMPEchoRequest,
  generatePacketId
} from '../../core/network/packet';
import { ARPEntry, RouteEntry, NetworkInterfaceConfig, PacketSender } from './types';

export interface NetworkStackConfig {
  interfaces: NetworkInterfaceConfig[];
  hostname: string;
  arpTimeout: number;  // seconds
  defaultTTL: number;
}

// Callback for ping responses
export type PingResponseCallback = (response: {
  success: boolean;
  sourceIP: string;
  sequenceNumber: number;
  ttl: number;
  rtt: number;  // Round trip time in ms
  error?: string;
}) => void;

// Pending ping request
interface PendingPing {
  destinationIP: string;
  sequenceNumber: number;
  identifier: number;
  sentTime: number;
  timeout: ReturnType<typeof setTimeout>;
  callback: PingResponseCallback;
}

export class NetworkStack {
  private interfaces: Map<string, NetworkInterfaceConfig> = new Map();
  private arpTable: Map<string, ARPEntry> = new Map();  // IP -> ARP Entry
  private routingTable: RouteEntry[] = [];
  private hostname: string;
  private arpTimeout: number;
  private defaultTTL: number;
  private packetSender: PacketSender | null = null;
  private pendingARPRequests: Map<string, {
    packet: Packet;
    timeout: NodeJS.Timeout;
    retries: number;
  }> = new Map();
  private pendingPings: Map<string, PendingPing> = new Map();  // key: identifier-sequence
  private pingIdentifier: number = Math.floor(Math.random() * 65535);

  constructor(config: NetworkStackConfig) {
    this.hostname = config.hostname;
    this.arpTimeout = config.arpTimeout || 300;
    this.defaultTTL = config.defaultTTL || 64;

    config.interfaces.forEach(iface => {
      this.interfaces.set(iface.id, { ...iface });
    });
  }

  // Set the callback for sending packets
  setPacketSender(sender: PacketSender): void {
    this.packetSender = sender;
  }

  // Get all interfaces
  getInterfaces(): NetworkInterfaceConfig[] {
    return Array.from(this.interfaces.values());
  }

  // Get interface by ID
  getInterface(id: string): NetworkInterfaceConfig | undefined {
    return this.interfaces.get(id);
  }

  // Get interface by name
  getInterfaceByName(name: string): NetworkInterfaceConfig | undefined {
    for (const iface of this.interfaces.values()) {
      if (iface.name === name) {
        return iface;
      }
    }
    return undefined;
  }

  // Get interface by IP address
  getInterfaceByIP(ip: string): NetworkInterfaceConfig | undefined {
    for (const iface of this.interfaces.values()) {
      if (iface.ipAddress === ip) {
        return iface;
      }
    }
    return undefined;
  }

  // Configure an interface
  configureInterface(id: string, config: Partial<NetworkInterfaceConfig>): boolean {
    const iface = this.interfaces.get(id);
    if (!iface) return false;

    Object.assign(iface, config);

    // If IP was set, add a connected route
    if (config.ipAddress && config.subnetMask) {
      this.addConnectedRoute(iface);
    }

    return true;
  }

  // Add a connected route when interface is configured
  private addConnectedRoute(iface: NetworkInterfaceConfig): void {
    if (!iface.ipAddress || !iface.subnetMask) return;

    const network = this.getNetworkAddress(iface.ipAddress, iface.subnetMask);

    // Remove existing route for this network if any
    this.routingTable = this.routingTable.filter(r =>
      !(r.destination === network && r.interface === iface.name)
    );

    // Add new connected route
    this.routingTable.push({
      destination: network,
      netmask: iface.subnetMask,
      gateway: '0.0.0.0',  // Directly connected
      interface: iface.name,
      metric: 0,
      protocol: 'connected'
    });
  }

  // ==================== ARP Table Management ====================

  // Get ARP table
  getARPTable(): ARPEntry[] {
    return Array.from(this.arpTable.values());
  }

  // Add/Update ARP entry
  addARPEntry(ip: string, mac: string, interfaceName: string, isStatic: boolean = false): void {
    this.arpTable.set(ip, {
      ipAddress: ip,
      macAddress: mac,
      interface: interfaceName,
      type: isStatic ? 'static' : 'dynamic',
      age: 0
    });
  }

  // Remove ARP entry
  removeARPEntry(ip: string): boolean {
    return this.arpTable.delete(ip);
  }

  // Clear all dynamic ARP entries
  clearDynamicARPEntries(): void {
    for (const [ip, entry] of this.arpTable.entries()) {
      if (entry.type === 'dynamic') {
        this.arpTable.delete(ip);
      }
    }
  }

  // Lookup MAC address for IP
  lookupARP(ip: string): string | undefined {
    const entry = this.arpTable.get(ip);
    return entry?.macAddress;
  }

  // Send ARP request
  sendARPRequest(targetIP: string, sourceInterface: NetworkInterfaceConfig): void {
    if (!sourceInterface.ipAddress || !this.packetSender) return;

    const arpPacket = createARPRequest(
      sourceInterface.macAddress,
      sourceInterface.ipAddress,
      targetIP
    );

    const frame: EthernetFrame = {
      destinationMAC: BROADCAST_MAC,
      sourceMAC: sourceInterface.macAddress,
      etherType: ETHER_TYPE.ARP,
      payload: arpPacket
    };

    const packet: Packet = {
      id: generatePacketId(),
      timestamp: Date.now(),
      frame,
      hops: [],
      status: 'in_transit'
    };

    this.packetSender(packet, sourceInterface.id);
  }

  // Process incoming ARP packet
  processARPPacket(arpPacket: ARPPacket, incomingInterface: NetworkInterfaceConfig): Packet | null {
    // Learn sender's MAC address (ARP learning)
    this.addARPEntry(
      arpPacket.senderIP,
      arpPacket.senderMAC,
      incomingInterface.name,
      false
    );

    // Check if the ARP is for us
    if (!incomingInterface.ipAddress || arpPacket.targetIP !== incomingInterface.ipAddress) {
      return null;  // Not for us
    }

    // If it's a request, send a reply
    if (arpPacket.opcode === ARPOpcode.REQUEST) {
      const replyPacket = createARPReply(
        incomingInterface.macAddress,
        incomingInterface.ipAddress,
        arpPacket.senderMAC,
        arpPacket.senderIP
      );

      const frame: EthernetFrame = {
        destinationMAC: arpPacket.senderMAC,
        sourceMAC: incomingInterface.macAddress,
        etherType: ETHER_TYPE.ARP,
        payload: replyPacket
      };

      return {
        id: generatePacketId(),
        timestamp: Date.now(),
        frame,
        hops: [],
        status: 'in_transit'
      };
    }

    // If it's a reply, the ARP table was already updated above
    // Check if we had a pending request
    const pendingRequest = this.pendingARPRequests.get(arpPacket.senderIP);
    if (pendingRequest) {
      clearTimeout(pendingRequest.timeout);
      this.pendingARPRequests.delete(arpPacket.senderIP);
      // Could trigger sending the waiting packet here
    }

    return null;
  }

  // ==================== Ping / ICMP Echo ====================

  /**
   * Send an ICMP Echo Request (ping) to a destination IP
   * @param destinationIP Target IP address
   * @param callback Called when reply is received or timeout occurs
   * @param timeoutMs Timeout in milliseconds (default 1000)
   * @returns true if ping was sent, false if no route or interface
   */
  sendPing(
    destinationIP: string,
    callback: PingResponseCallback,
    timeoutMs: number = 1000
  ): boolean {
    // Find the outgoing interface based on routing
    const route = this.lookupRoute(destinationIP);
    let outInterface: NetworkInterfaceConfig | undefined;

    if (route) {
      outInterface = this.getInterfaceByName(route.interface);
    } else {
      // Try to find an interface in the same subnet
      for (const iface of this.interfaces.values()) {
        if (iface.ipAddress && iface.subnetMask && iface.isUp) {
          if (this.isIPInNetwork(destinationIP, this.getNetworkAddress(iface.ipAddress, iface.subnetMask), iface.subnetMask)) {
            outInterface = iface;
            break;
          }
        }
      }
    }

    if (!outInterface || !outInterface.ipAddress || !outInterface.isUp) {
      callback({
        success: false,
        sourceIP: destinationIP,
        sequenceNumber: 0,
        ttl: 0,
        rtt: 0,
        error: 'Network is unreachable'
      });
      return false;
    }

    // Check if we need to do ARP first
    const destMAC = this.lookupARP(destinationIP);

    const sequenceNumber = this.pendingPings.size + 1;
    const identifier = this.pingIdentifier;

    // Create the ping key
    const pingKey = `${identifier}-${sequenceNumber}`;

    // Set up timeout
    const timeout = setTimeout(() => {
      const pending = this.pendingPings.get(pingKey);
      if (pending) {
        this.pendingPings.delete(pingKey);
        callback({
          success: false,
          sourceIP: destinationIP,
          sequenceNumber: pending.sequenceNumber,
          ttl: 0,
          rtt: 0,
          error: 'Request timed out'
        });
      }
    }, timeoutMs);

    // Store pending ping
    this.pendingPings.set(pingKey, {
      destinationIP,
      sequenceNumber,
      identifier,
      sentTime: Date.now(),
      timeout,
      callback
    });

    // If we don't have the MAC, send ARP first
    if (!destMAC) {
      // Store the ping to send after ARP resolves
      this.sendARPRequest(destinationIP, outInterface);

      // Wait a bit for ARP to resolve, then send the ping
      setTimeout(() => {
        const resolvedMAC = this.lookupARP(destinationIP);
        if (resolvedMAC) {
          this.sendICMPEchoRequest(destinationIP, resolvedMAC, outInterface!, identifier, sequenceNumber);
        }
      }, 100);

      return true;
    }

    // Send the ICMP Echo Request
    this.sendICMPEchoRequest(destinationIP, destMAC, outInterface, identifier, sequenceNumber);
    return true;
  }

  /**
   * Send an ICMP Echo Request packet
   */
  private sendICMPEchoRequest(
    destinationIP: string,
    destinationMAC: string,
    outInterface: NetworkInterfaceConfig,
    identifier: number,
    sequenceNumber: number
  ): void {
    if (!this.packetSender || !outInterface.ipAddress) return;

    const icmpPacket = createICMPEchoRequest(identifier, sequenceNumber);

    const ipPacket: IPv4Packet = {
      version: 4,
      headerLength: 20,
      dscp: 0,
      totalLength: 0,
      identification: Math.floor(Math.random() * 65535),
      flags: 0,
      fragmentOffset: 0,
      ttl: this.defaultTTL,
      protocol: IP_PROTOCOL.ICMP,
      headerChecksum: 0,
      sourceIP: outInterface.ipAddress,
      destinationIP: destinationIP,
      payload: icmpPacket
    };

    const frame: EthernetFrame = {
      destinationMAC,
      sourceMAC: outInterface.macAddress,
      etherType: ETHER_TYPE.IPv4,
      payload: ipPacket
    };

    const packet: Packet = {
      id: generatePacketId(),
      timestamp: Date.now(),
      frame,
      hops: [],
      status: 'in_transit'
    };

    this.packetSender(packet, outInterface.id);
  }

  /**
   * Process ICMP Echo Reply (called from processLocalPacket)
   */
  private processICMPEchoReply(icmpPacket: ICMPPacket, sourceIP: string, ttl: number): void {
    const pingKey = `${icmpPacket.identifier}-${icmpPacket.sequenceNumber}`;
    const pending = this.pendingPings.get(pingKey);

    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingPings.delete(pingKey);

      const rtt = Date.now() - pending.sentTime;
      pending.callback({
        success: true,
        sourceIP,
        sequenceNumber: pending.sequenceNumber,
        ttl,
        rtt
      });
    }
  }

  // ==================== Routing Table Management ====================

  // Get routing table
  getRoutingTable(): RouteEntry[] {
    return [...this.routingTable];
  }

  // Add a static route
  addStaticRoute(destination: string, netmask: string, gateway: string, interfaceName: string, metric: number = 1): boolean {
    // Check if route already exists
    const existingIndex = this.routingTable.findIndex(r =>
      r.destination === destination && r.netmask === netmask
    );

    if (existingIndex !== -1) {
      return false;  // Route already exists
    }

    this.routingTable.push({
      destination,
      netmask,
      gateway,
      interface: interfaceName,
      metric,
      protocol: 'static'
    });

    // Sort by prefix length (longest prefix match)
    this.routingTable.sort((a, b) => {
      const prefixA = this.netmaskToPrefix(a.netmask);
      const prefixB = this.netmaskToPrefix(b.netmask);
      return prefixB - prefixA;  // Longer prefix first
    });

    return true;
  }

  // Remove a route
  removeRoute(destination: string, netmask: string): boolean {
    const initialLength = this.routingTable.length;
    this.routingTable = this.routingTable.filter(r =>
      !(r.destination === destination && r.netmask === netmask)
    );
    return this.routingTable.length < initialLength;
  }

  // Lookup route for destination IP (longest prefix match)
  lookupRoute(destinationIP: string): RouteEntry | null {
    for (const route of this.routingTable) {
      if (this.isIPInNetwork(destinationIP, route.destination, route.netmask)) {
        return route;
      }
    }
    return null;
  }

  // ==================== Packet Processing ====================

  // Process incoming packet
  processIncomingPacket(packet: Packet, incomingInterfaceId: string): Packet | null {
    const incomingInterface = this.interfaces.get(incomingInterfaceId);
    if (!incomingInterface || !incomingInterface.isUp) {
      return null;  // Interface down or doesn't exist
    }

    const frame = packet.frame;

    // Check if frame is for us (our MAC or broadcast)
    if (frame.destinationMAC.toUpperCase() !== incomingInterface.macAddress.toUpperCase() &&
        frame.destinationMAC.toUpperCase() !== BROADCAST_MAC) {
      return null;  // Not for us
    }

    let responsePacket: Packet | null = null;

    // Handle ARP packets
    if (frame.etherType === ETHER_TYPE.ARP) {
      const arpPacket = frame.payload as ARPPacket;
      responsePacket = this.processARPPacket(arpPacket, incomingInterface);
    }

    // Handle IPv4 packets
    else if (frame.etherType === ETHER_TYPE.IPv4) {
      const ipPacket = frame.payload as IPv4Packet;
      responsePacket = this.processIPv4Packet(ipPacket, incomingInterface);
    }

    // If we have a response packet, send it
    if (responsePacket && this.packetSender) {
      this.packetSender(responsePacket, incomingInterfaceId);
    }

    return responsePacket;
  }

  // Process IPv4 packet
  private processIPv4Packet(ipPacket: IPv4Packet, incomingInterface: NetworkInterfaceConfig): Packet | null {
    // Check TTL
    if (ipPacket.ttl <= 0) {
      return this.createICMPTimeExceeded(ipPacket, incomingInterface);
    }

    // Check if destination is one of our interfaces
    for (const iface of this.interfaces.values()) {
      if (iface.ipAddress === ipPacket.destinationIP) {
        // Packet is for us
        return this.processLocalPacket(ipPacket, iface);
      }
    }

    // Not for us - would need to route (not implemented for end hosts)
    return null;
  }

  // Process packet destined for this device
  private processLocalPacket(ipPacket: IPv4Packet, localInterface: NetworkInterfaceConfig): Packet | null {
    // Handle ICMP
    if (ipPacket.protocol === IP_PROTOCOL.ICMP) {
      const icmpPacket = ipPacket.payload as ICMPPacket;

      // Handle Echo Request (ping) - respond with Echo Reply
      if (icmpPacket.type === ICMPType.ECHO_REQUEST) {
        return this.createICMPEchoReply(ipPacket, localInterface);
      }

      // Handle Echo Reply (response to our ping)
      if (icmpPacket.type === ICMPType.ECHO_REPLY) {
        this.processICMPEchoReply(icmpPacket, ipPacket.sourceIP, ipPacket.ttl);
        return null;
      }
    }

    // Other protocols would be handled by upper layers
    return null;
  }

  // Create ICMP Echo Reply
  private createICMPEchoReply(requestIP: IPv4Packet, outInterface: NetworkInterfaceConfig): Packet | null {
    if (!outInterface.ipAddress) return null;

    const icmpRequest = requestIP.payload as ICMPPacket;
    const icmpReply = createICMPEchoReply(icmpRequest);

    const replyIP: IPv4Packet = {
      version: 4,
      headerLength: 20,
      dscp: 0,
      totalLength: 0,
      identification: Math.floor(Math.random() * 65535),
      flags: 0,
      fragmentOffset: 0,
      ttl: this.defaultTTL,
      protocol: IP_PROTOCOL.ICMP,
      headerChecksum: 0,
      sourceIP: outInterface.ipAddress,
      destinationIP: requestIP.sourceIP,
      payload: icmpReply
    };

    // Need to find MAC address for destination
    const destMAC = this.lookupARP(requestIP.sourceIP);
    if (!destMAC) {
      // Need to do ARP first
      this.sendARPRequest(requestIP.sourceIP, outInterface);
      return null;
    }

    const frame: EthernetFrame = {
      destinationMAC: destMAC,
      sourceMAC: outInterface.macAddress,
      etherType: ETHER_TYPE.IPv4,
      payload: replyIP
    };

    return {
      id: generatePacketId(),
      timestamp: Date.now(),
      frame,
      hops: [],
      status: 'in_transit'
    };
  }

  // Create ICMP Time Exceeded
  private createICMPTimeExceeded(originalIP: IPv4Packet, outInterface: NetworkInterfaceConfig): Packet | null {
    // Implementation would create ICMP Time Exceeded message
    return null;
  }

  // ==================== Helper Functions ====================

  // Check if IP is in network
  isIPInNetwork(ip: string, network: string, netmask: string): boolean {
    const ipNum = this.ipToNumber(ip);
    const networkNum = this.ipToNumber(network);
    const maskNum = this.ipToNumber(netmask);

    return (ipNum & maskNum) === (networkNum & maskNum);
  }

  // Get network address from IP and netmask
  getNetworkAddress(ip: string, netmask: string): string {
    const ipNum = this.ipToNumber(ip);
    const maskNum = this.ipToNumber(netmask);
    return this.numberToIP(ipNum & maskNum);
  }

  // Get broadcast address from IP and netmask
  getBroadcastAddress(ip: string, netmask: string): string {
    const ipNum = this.ipToNumber(ip);
    const maskNum = this.ipToNumber(netmask);
    const invertedMask = ~maskNum >>> 0;
    return this.numberToIP((ipNum & maskNum) | invertedMask);
  }

  // Convert IP string to number
  ipToNumber(ip: string): number {
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }

  // Convert number to IP string
  numberToIP(num: number): string {
    return [
      (num >>> 24) & 255,
      (num >>> 16) & 255,
      (num >>> 8) & 255,
      num & 255
    ].join('.');
  }

  // Convert netmask to prefix length
  netmaskToPrefix(netmask: string): number {
    const num = this.ipToNumber(netmask);
    let count = 0;
    let n = num;
    while (n) {
      count += n & 1;
      n >>>= 1;
    }
    return count;
  }

  // Convert prefix length to netmask
  prefixToNetmask(prefix: number): string {
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return this.numberToIP(mask);
  }

  // Validate IP address format
  isValidIP(ip: string): boolean {
    const pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!pattern.test(ip)) return false;

    const parts = ip.split('.').map(Number);
    return parts.every(part => part >= 0 && part <= 255);
  }

  // Validate netmask
  isValidNetmask(netmask: string): boolean {
    if (!this.isValidIP(netmask)) return false;

    const num = this.ipToNumber(netmask);
    // Valid netmask should be continuous 1s followed by continuous 0s
    const inverted = ~num >>> 0;
    return (inverted & (inverted + 1)) === 0;
  }
}
