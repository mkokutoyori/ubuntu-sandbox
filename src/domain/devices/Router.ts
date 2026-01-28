/**
 * Router (Layer 3) Device
 *
 * Represents a router with:
 * - Multiple network interfaces
 * - Routing table with static routes
 * - IP packet forwarding
 * - TTL management
 * - ARP resolution per interface
 *
 * Design Pattern: Composite + Strategy
 * - Composes NetworkInterface and ARPService per interface
 * - Uses longest prefix match for routing decisions
 *
 * @example
 * ```typescript
 * const router = new Router('r1', 'Core Router', 4);
 *
 * // Configure interfaces
 * router.setIPAddress('eth0', new IPAddress('10.0.0.1'), new SubnetMask('/24'));
 * router.setIPAddress('eth1', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
 *
 * // Add static route
 * router.addRoute(
 *   new IPAddress('172.16.0.0'),
 *   new SubnetMask('/16'),
 *   new IPAddress('10.0.0.2'),
 *   'eth0'
 * );
 *
 * // Forward packets
 * router.onPacketForward((iface, packet) => {
 *   // Send packet to next hop
 * });
 * ```
 */

import { BaseDevice } from './BaseDevice';
import { NetworkInterface } from './NetworkInterface';
import { ARPService, ARPPacket } from '../network/services/ARPService';
import { DHCPServerService, DHCPServerConfig, DHCPLease } from '../network/services/DHCPService';
import { DHCPPacket, DHCPMessageType } from '../network/entities/DHCPPacket';
import { IPAddress } from '../network/value-objects/IPAddress';
import { SubnetMask } from '../network/value-objects/SubnetMask';
import { MACAddress } from '../network/value-objects/MACAddress';
import { EthernetFrame, EtherType } from '../network/entities/EthernetFrame';
import { IPv4Packet, IPProtocol } from '../network/entities/IPv4Packet';
import { ICMPPacket, ICMPCode } from '../network/entities/ICMPPacket';

/**
 * Route entry in routing table
 */
export interface Route {
  network: IPAddress;
  mask: SubnetMask;
  nextHop?: IPAddress;
  interface: string;
  isDirectlyConnected: boolean;
  metric: number;
}

/**
 * Router statistics
 */
export interface RouterStatistics {
  packetsForwarded: number;
  packetsDropped: number;
  packetsReceived: number;
  ttlExpired: number;
}

/**
 * Packet forward callback
 */
type PacketForwardCallback = (interfaceName: string, packet: IPv4Packet) => void;

/**
 * Packet drop callback
 */
type PacketDropCallback = (reason: string, packet?: IPv4Packet) => void;

/**
 * Frame transmit callback
 */
type FrameTransmitCallback = (interfaceName: string, frame: EthernetFrame) => void;

/**
 * DHCP Server configuration for Router
 */
export interface RouterDHCPConfig {
  interfaceName: string;
  poolStart: IPAddress;
  poolEnd: IPAddress;
  leaseTime?: number; // seconds, default 86400 (24 hours)
  dnsServers?: IPAddress[];
  domainName?: string;
}

/**
 * Router - Layer 3 routing device
 */
export class Router extends BaseDevice {
  private interfaces: Map<string, NetworkInterface>;
  private arpServices: Map<string, ARPService>;
  private dhcpServers: Map<string, DHCPServerService>; // per-interface DHCP servers
  private routingTable: Route[];
  private statistics: RouterStatistics;
  private packetForwardCallback?: PacketForwardCallback;
  private packetDropCallback?: PacketDropCallback;
  private frameTransmitCallback?: FrameTransmitCallback;

  constructor(id: string, name: string, interfaceCount: number = 2) {
    super(id, name, 'router');

    this.interfaces = new Map();
    this.arpServices = new Map();
    this.dhcpServers = new Map();
    this.routingTable = [];
    this.statistics = {
      packetsForwarded: 0,
      packetsDropped: 0,
      packetsReceived: 0,
      ttlExpired: 0
    };

    // Create interfaces
    for (let i = 0; i < interfaceCount; i++) {
      const ifaceName = `eth${i}`;
      const mac = this.generateMAC();
      const nic = new NetworkInterface(ifaceName, mac);
      const arpService = new ARPService();

      this.interfaces.set(ifaceName, nic);
      this.arpServices.set(ifaceName, arpService);
      this.addPort(ifaceName);

      this.setupInterfaceCallbacks(ifaceName, nic);
    }
  }

  /**
   * Powers on the router
   */
  public powerOn(): void {
    this.status = 'online';

    // Bring up all interfaces
    for (const nic of this.interfaces.values()) {
      nic.up();
    }
  }

  /**
   * Powers off the router
   */
  public powerOff(): void {
    this.status = 'offline';

    // Bring down all interfaces
    for (const nic of this.interfaces.values()) {
      nic.down();
    }
  }

  /**
   * Resets the router
   * Clears routing table (except directly connected)
   */
  public reset(): void {
    // Clear static routes (keep directly connected)
    this.routingTable = this.routingTable.filter(r => r.isDirectlyConnected);

    // Clear statistics
    this.statistics = {
      packetsForwarded: 0,
      packetsDropped: 0,
      packetsReceived: 0,
      ttlExpired: 0
    };

    this.powerOff();
    this.powerOn();
  }

  /**
   * Gets network interface
   *
   * @param name - Interface name
   * @returns NetworkInterface or undefined
   */
  public getInterface(name: string): NetworkInterface | undefined {
    return this.interfaces.get(name);
  }

  /**
   * Checks if interface exists
   *
   * @param name - Interface name
   * @returns True if interface exists
   */
  public hasInterface(name: string): boolean {
    return this.interfaces.has(name);
  }

  /**
   * Gets all interfaces
   */
  public getInterfaces(): NetworkInterface[] {
    return Array.from(this.interfaces.values());
  }

  /**
   * Sets IP address on interface
   *
   * @param interfaceName - Interface name
   * @param ip - IP address
   * @param mask - Subnet mask
   */
  public setIPAddress(interfaceName: string, ip: IPAddress, mask: SubnetMask): void {
    const nic = this.interfaces.get(interfaceName);
    if (!nic) {
      throw new Error(`Interface not found: ${interfaceName}`);
    }

    nic.setIPAddress(ip, mask);

    // Add directly connected route
    const networkIP = this.calculateNetworkAddress(ip, mask);
    this.addDirectlyConnectedRoute(networkIP, mask, interfaceName);
  }

  /**
   * Adds route to routing table
   *
   * @param network - Network address
   * @param mask - Subnet mask
   * @param nextHop - Next hop IP
   * @param interfaceName - Output interface
   * @param metric - Route metric (default 1)
   */
  public addRoute(
    network: IPAddress,
    mask: SubnetMask,
    nextHop: IPAddress,
    interfaceName: string,
    metric: number = 1
  ): void {
    // Check if interface exists
    if (!this.interfaces.has(interfaceName)) {
      throw new Error(`Interface not found: ${interfaceName}`);
    }

    const route: Route = {
      network,
      mask,
      nextHop,
      interface: interfaceName,
      isDirectlyConnected: false,
      metric
    };

    this.routingTable.push(route);
  }

  /**
   * Sets default route (0.0.0.0/0)
   *
   * @param nextHop - Next hop IP
   * @param interfaceName - Output interface
   */
  public setDefaultRoute(nextHop: IPAddress, interfaceName: string): void {
    this.addRoute(
      new IPAddress('0.0.0.0'),
      new SubnetMask('/0'),
      nextHop,
      interfaceName,
      10 // Lower priority than specific routes
    );
  }

  /**
   * Removes route from routing table
   *
   * @param network - Network address
   * @param mask - Subnet mask
   */
  public removeRoute(network: IPAddress, mask: SubnetMask): void {
    this.routingTable = this.routingTable.filter(
      r => !(r.network.equals(network) && r.mask.equals(mask))
    );
  }

  /**
   * Gets all routes
   */
  public getRoutes(): Route[] {
    return [...this.routingTable];
  }

  /**
   * Looks up route for destination IP
   * Uses longest prefix match
   *
   * @param destIP - Destination IP address
   * @returns Route or undefined if no route found
   */
  public lookupRoute(destIP: IPAddress): Route | undefined {
    let bestMatch: Route | undefined;
    let longestPrefix = -1;

    for (const route of this.routingTable) {
      if (this.isInSubnet(destIP, route.network, route.mask)) {
        const prefixLength = route.mask.getCIDR();
        if (prefixLength > longestPrefix) {
          longestPrefix = prefixLength;
          bestMatch = route;
        }
      }
    }

    return bestMatch;
  }

  /**
   * Forwards IP packet
   *
   * @param packet - IPv4 packet to forward
   * @param ingressInterface - Interface where packet was received
   */
  public forwardPacket(packet: IPv4Packet, ingressInterface: string): void {
    this.statistics.packetsReceived++;

    // Check TTL
    if (packet.getTTL() <= 1) {
      this.statistics.ttlExpired++;
      this.statistics.packetsDropped++;
      if (this.packetDropCallback) {
        this.packetDropCallback('TTL expired', packet);
      }

      // Send ICMP Time Exceeded to source
      this.sendICMPTimeExceeded(packet, ingressInterface);

      return;
    }

    // Lookup route
    const route = this.lookupRoute(packet.getDestinationIP());
    if (!route) {
      this.statistics.packetsDropped++;
      if (this.packetDropCallback) {
        this.packetDropCallback('No route to destination', packet);
      }
      return;
    }

    // Decrement TTL
    const forwardedPacket = packet.decrementTTL();

    this.statistics.packetsForwarded++;

    // Call packet forward callback (for testing/monitoring)
    if (this.packetForwardCallback) {
      this.packetForwardCallback(route.interface, forwardedPacket);
    }

    // Determine next hop IP
    const nextHopIP = route.nextHop || packet.getDestinationIP();

    // Resolve next hop MAC
    const nextHopMAC = this.resolveMAC(route.interface, nextHopIP);
    if (!nextHopMAC) {
      // Can't forward without MAC address
      // In real router, would initiate ARP request and queue packet
      return;
    }

    // Get egress interface
    const egressNIC = this.interfaces.get(route.interface);
    if (!egressNIC) {
      return;
    }

    // Encapsulate in Ethernet frame
    const packetBytes = forwardedPacket.toBytes();
    const paddedPayload = Buffer.concat([
      packetBytes,
      Buffer.alloc(Math.max(0, 46 - packetBytes.length))
    ]);

    const frame = new EthernetFrame({
      sourceMAC: egressNIC.getMAC(),
      destinationMAC: nextHopMAC,
      etherType: EtherType.IPv4,
      payload: paddedPayload
    });

    // Transmit frame
    if (this.frameTransmitCallback) {
      this.frameTransmitCallback(route.interface, frame);
    }
  }

  /**
   * Receives frame on interface
   *
   * @param interfaceName - Interface name
   * @param frame - Ethernet frame
   */
  public receiveFrame(interfaceName: string, frame: EthernetFrame): void {
    const nic = this.interfaces.get(interfaceName);
    if (!nic || !nic.isUp()) {
      return;
    }

    // Handle ARP frames
    if (frame.getEtherType() === EtherType.ARP) {
      this.handleARPFrame(interfaceName, frame);
      return;
    }

    // Handle IPv4 frames
    if (frame.getEtherType() === EtherType.IPv4) {
      this.handleIPv4Frame(interfaceName, frame);
      return;
    }
  }

  /**
   * Resolves MAC address via ARP
   *
   * @param interfaceName - Interface name
   * @param ip - IP address to resolve
   * @returns MAC address or undefined
   */
  public resolveMAC(interfaceName: string, ip: IPAddress): MACAddress | undefined {
    const arpService = this.arpServices.get(interfaceName);
    if (!arpService) {
      return undefined;
    }

    return arpService.resolve(ip);
  }

  /**
   * Adds ARP entry
   *
   * @param interfaceName - Interface name
   * @param ip - IP address
   * @param mac - MAC address
   */
  public addARPEntry(interfaceName: string, ip: IPAddress, mac: MACAddress): void {
    const arpService = this.arpServices.get(interfaceName);
    if (arpService) {
      arpService.addEntry(ip, mac);
    }
  }

  /**
   * Gets ARP service for interface
   *
   * @param interfaceName - Interface name
   * @returns ARPService or undefined
   */
  public getARPService(interfaceName: string): ARPService {
    const arpService = this.arpServices.get(interfaceName);
    if (!arpService) {
      throw new Error(`No ARP service for interface: ${interfaceName}`);
    }
    return arpService;
  }

  // ============== DHCP Server Methods ==============

  /**
   * Enables DHCP server on an interface
   *
   * @param config - DHCP server configuration
   */
  public enableDHCPServer(config: RouterDHCPConfig): void {
    const nic = this.interfaces.get(config.interfaceName);
    if (!nic) {
      throw new Error(`Interface not found: ${config.interfaceName}`);
    }

    const nicIP = nic.getIPAddress();
    const nicMask = nic.getSubnetMask();

    if (!nicIP || !nicMask) {
      throw new Error(`Interface ${config.interfaceName} must have IP address configured before enabling DHCP`);
    }

    // Create DHCP server config
    const serverConfig: DHCPServerConfig = {
      serverIP: nicIP,
      poolStart: config.poolStart,
      poolEnd: config.poolEnd,
      subnetMask: new IPAddress(nicMask.toString()),
      gateway: nicIP,
      dnsServers: config.dnsServers ?? [new IPAddress('8.8.8.8'), new IPAddress('8.8.4.4')],
      leaseTime: config.leaseTime ?? 86400,
      domainName: config.domainName
    };

    const dhcpServer = new DHCPServerService(serverConfig);
    this.dhcpServers.set(config.interfaceName, dhcpServer);
  }

  /**
   * Disables DHCP server on an interface
   *
   * @param interfaceName - Interface name
   */
  public disableDHCPServer(interfaceName: string): void {
    this.dhcpServers.delete(interfaceName);
  }

  /**
   * Checks if DHCP server is enabled on interface
   *
   * @param interfaceName - Interface name
   * @returns True if DHCP server is enabled
   */
  public isDHCPServerEnabled(interfaceName: string): boolean {
    return this.dhcpServers.has(interfaceName);
  }

  /**
   * Gets DHCP server for interface
   *
   * @param interfaceName - Interface name
   * @returns DHCPServerService or undefined
   */
  public getDHCPServer(interfaceName: string): DHCPServerService | undefined {
    return this.dhcpServers.get(interfaceName);
  }

  /**
   * Gets all DHCP leases across all interfaces
   *
   * @returns Array of leases with interface info
   */
  public getAllDHCPLeases(): { interface: string; lease: DHCPLease }[] {
    const allLeases: { interface: string; lease: DHCPLease }[] = [];

    for (const [ifaceName, dhcpServer] of this.dhcpServers) {
      for (const lease of dhcpServer.getActiveLeases()) {
        allLeases.push({ interface: ifaceName, lease });
      }
    }

    return allLeases;
  }

  /**
   * Adds DHCP reservation
   *
   * @param interfaceName - Interface name
   * @param mac - MAC address
   * @param ip - Reserved IP address
   */
  public addDHCPReservation(interfaceName: string, mac: MACAddress, ip: IPAddress): void {
    const dhcpServer = this.dhcpServers.get(interfaceName);
    if (!dhcpServer) {
      throw new Error(`DHCP server not enabled on interface: ${interfaceName}`);
    }
    dhcpServer.addReservation(mac, ip);
  }

  /**
   * Removes DHCP reservation
   *
   * @param interfaceName - Interface name
   * @param mac - MAC address
   */
  public removeDHCPReservation(interfaceName: string, mac: MACAddress): void {
    const dhcpServer = this.dhcpServers.get(interfaceName);
    if (dhcpServer) {
      dhcpServer.removeReservation(mac);
    }
  }

  /**
   * Handles DHCP packet received on interface
   *
   * @param interfaceName - Interface name
   * @param dhcpPacket - DHCP packet
   * @returns Response packet or null
   */
  public handleDHCPPacket(interfaceName: string, dhcpPacket: DHCPPacket): DHCPPacket | null {
    const dhcpServer = this.dhcpServers.get(interfaceName);
    if (!dhcpServer) {
      return null; // DHCP not enabled on this interface
    }

    const messageType = dhcpPacket.getMessageType();

    switch (messageType) {
      case DHCPMessageType.DISCOVER:
        return dhcpServer.handleDiscover(dhcpPacket);

      case DHCPMessageType.REQUEST:
        return dhcpServer.handleRequest(dhcpPacket);

      case DHCPMessageType.RELEASE:
        dhcpServer.handleRelease(dhcpPacket);
        return null;

      case DHCPMessageType.DECLINE:
        dhcpServer.handleDecline(dhcpPacket);
        return null;

      default:
        return null;
    }
  }

  /**
   * Sends DHCP response to client
   *
   * @param interfaceName - Interface name
   * @param response - DHCP response packet
   * @param clientMAC - Client MAC address
   */
  public sendDHCPResponse(interfaceName: string, response: DHCPPacket, clientMAC: MACAddress): void {
    const nic = this.interfaces.get(interfaceName);
    if (!nic || !nic.getIPAddress()) {
      return;
    }

    // DHCP responses are broadcast or unicast depending on broadcast flag
    const destMAC = response.isBroadcast() ? MACAddress.BROADCAST : clientMAC;
    const destIP = response.isBroadcast()
      ? new IPAddress('255.255.255.255')
      : (response.getYourIP() ?? new IPAddress('255.255.255.255'));

    // Serialize DHCP packet
    const dhcpBytes = response.toBytes();

    // Create UDP header (simplified: source port 67, dest port 68)
    const udpHeader = this.createUDPHeader(67, 68, dhcpBytes.length);
    const udpPayload = Buffer.concat([udpHeader, dhcpBytes]);

    // Create IP packet
    const ipPacket = new IPv4Packet({
      sourceIP: nic.getIPAddress()!,
      destinationIP: destIP,
      protocol: 17, // UDP
      ttl: 64,
      payload: udpPayload
    });

    // Create Ethernet frame
    const packetBytes = ipPacket.toBytes();
    const paddedPayload = Buffer.concat([
      packetBytes,
      Buffer.alloc(Math.max(0, 46 - packetBytes.length))
    ]);

    const frame = new EthernetFrame({
      sourceMAC: nic.getMAC(),
      destinationMAC: destMAC,
      etherType: EtherType.IPv4,
      payload: paddedPayload
    });

    // Transmit frame
    if (this.frameTransmitCallback) {
      this.frameTransmitCallback(interfaceName, frame);
    }
  }

  /**
   * Creates simplified UDP header
   */
  private createUDPHeader(srcPort: number, dstPort: number, dataLength: number): Buffer {
    const header = Buffer.alloc(8);
    header.writeUInt16BE(srcPort, 0);  // Source port
    header.writeUInt16BE(dstPort, 2);  // Destination port
    header.writeUInt16BE(8 + dataLength, 4); // Length (header + data)
    header.writeUInt16BE(0, 6);        // Checksum (0 = not used)
    return header;
  }

  /**
   * Registers callback for packet forwarding
   *
   * @param callback - Callback function
   */
  public onPacketForward(callback: PacketForwardCallback): void {
    this.packetForwardCallback = callback;
  }

  /**
   * Registers callback for packet drops
   *
   * @param callback - Callback function
   */
  public onPacketDrop(callback: PacketDropCallback): void {
    this.packetDropCallback = callback;
  }

  /**
   * Registers callback for frame transmission
   *
   * @param callback - Callback function
   */
  public onFrameTransmit(callback: FrameTransmitCallback): void {
    this.frameTransmitCallback = callback;
  }

  /**
   * Returns statistics
   */
  public getStatistics(): Readonly<RouterStatistics> {
    return { ...this.statistics };
  }

  /**
   * Handles IPv4 frame
   */
  private handleIPv4Frame(interfaceName: string, frame: EthernetFrame): void {
    try {
      const payload = frame.getPayload();
      const packet = IPv4Packet.fromBytes(payload);

      // Check if this is a DHCP packet (UDP, dest port 67)
      if (packet.getProtocol() === 17) { // UDP
        const udpPayload = packet.getPayload();
        if (udpPayload.length >= 8) {
          const destPort = udpPayload.readUInt16BE(2);
          if (destPort === 67) {
            // DHCP server port - handle DHCP request
            this.handleDHCPFrame(interfaceName, packet, udpPayload, frame.getSourceMAC());
            return;
          }
        }
      }

      // Check if packet is destined for router itself
      const nic = this.interfaces.get(interfaceName);
      if (nic && nic.getIPAddress()?.equals(packet.getDestinationIP())) {
        // Packet is for us - don't forward
        return;
      }

      this.forwardPacket(packet, interfaceName);
    } catch (error) {
      // Silently drop malformed packets
    }
  }

  /**
   * Handles DHCP frame
   */
  private handleDHCPFrame(
    interfaceName: string,
    ipPacket: IPv4Packet,
    udpPayload: Buffer,
    clientMAC: MACAddress
  ): void {
    try {
      // Skip UDP header (8 bytes) to get DHCP data
      const dhcpData = udpPayload.subarray(8);

      if (dhcpData.length < 240) {
        return; // Too small for DHCP
      }

      const dhcpPacket = DHCPPacket.fromBytes(dhcpData);
      const response = this.handleDHCPPacket(interfaceName, dhcpPacket);

      if (response) {
        this.sendDHCPResponse(interfaceName, response, clientMAC);
      }
    } catch (error) {
      // Silently drop malformed DHCP packets
    }
  }

  /**
   * Handles ARP frame
   */
  private handleARPFrame(interfaceName: string, frame: EthernetFrame): void {
    const arpService = this.arpServices.get(interfaceName);
    if (!arpService) {
      return;
    }

    const nic = this.interfaces.get(interfaceName);
    if (!nic) {
      return;
    }

    try {
      const payload = frame.getPayload();
      const arpPacket = arpService.deserializePacket(payload);

      // Process packet (updates cache)
      arpService.processPacket(arpPacket);

      // If it's a request for our IP, send reply
      if (arpPacket.operation === 'request') {
        const ourIP = nic.getIPAddress();

        if (ourIP && arpPacket.targetIP.equals(ourIP)) {
          const reply = arpService.createReply(
            ourIP,
            nic.getMAC(),
            arpPacket.senderIP,
            arpPacket.senderMAC
          );

          // Send ARP reply
          const replyBytes = arpService.serializePacket(reply);
          const paddedPayload = Buffer.concat([
            replyBytes,
            Buffer.alloc(Math.max(0, 46 - replyBytes.length))
          ]);

          const replyFrame = new EthernetFrame({
            sourceMAC: nic.getMAC(),
            destinationMAC: arpPacket.senderMAC,
            etherType: EtherType.ARP,
            payload: paddedPayload
          });

          if (this.frameTransmitCallback) {
            this.frameTransmitCallback(interfaceName, replyFrame);
          }
        }
      }
    } catch (error) {
      // Silently drop malformed ARP packets
    }
  }

  /**
   * Sends ICMP Time Exceeded message to packet source
   *
   * @param originalPacket - Original packet that expired
   * @param ingressInterface - Interface where packet was received
   */
  private sendICMPTimeExceeded(originalPacket: IPv4Packet, ingressInterface: string): void {
    const sourceIP = originalPacket.getSourceIP();

    // Get ingress interface
    const ingressNIC = this.interfaces.get(ingressInterface);
    if (!ingressNIC || !ingressNIC.getIPAddress()) {
      return; // Can't send without configured interface
    }

    // Create ICMP Time Exceeded packet
    // Include first 8 bytes of IP header + 8 bytes of data from original packet
    const originalBytes = originalPacket.toBytes();
    const icmpData = originalBytes.subarray(0, Math.min(28, originalBytes.length));

    const icmpPacket = ICMPPacket.createTimeExceeded(icmpData, ICMPCode.TTL_EXCEEDED);

    // Encapsulate in IP packet
    const icmpBytes = icmpPacket.toBytes();
    const ipPacket = new IPv4Packet({
      sourceIP: ingressNIC.getIPAddress()!,
      destinationIP: sourceIP,
      protocol: IPProtocol.ICMP,
      ttl: 64,
      payload: icmpBytes
    });

    // Resolve source MAC
    const sourceMac = this.resolveMAC(ingressInterface, sourceIP);
    if (!sourceMac) {
      // Can't send without MAC resolution
      return;
    }

    // Encapsulate in Ethernet frame
    const packetBytes = ipPacket.toBytes();
    const paddedPayload = Buffer.concat([
      packetBytes,
      Buffer.alloc(Math.max(0, 46 - packetBytes.length))
    ]);

    const frame = new EthernetFrame({
      sourceMAC: ingressNIC.getMAC(),
      destinationMAC: sourceMac,
      etherType: EtherType.IPv4,
      payload: paddedPayload
    });

    // Send back via ingress interface
    if (this.frameTransmitCallback) {
      this.frameTransmitCallback(ingressInterface, frame);
    }
  }

  /**
   * Adds directly connected route
   */
  private addDirectlyConnectedRoute(network: IPAddress, mask: SubnetMask, interfaceName: string): void {
    // Remove existing directly connected route for this interface
    this.routingTable = this.routingTable.filter(
      r => !(r.interface === interfaceName && r.isDirectlyConnected)
    );

    const route: Route = {
      network,
      mask,
      interface: interfaceName,
      isDirectlyConnected: true,
      metric: 0
    };

    this.routingTable.push(route);
  }

  /**
   * Calculates network address from IP and mask
   */
  private calculateNetworkAddress(ip: IPAddress, mask: SubnetMask): IPAddress {
    const ipNum = ip.toNumber();
    const maskNum = mask.toNumber();
    const networkNum = (ipNum & maskNum) >>> 0; // >>> 0 converts to unsigned 32-bit

    return IPAddress.fromNumber(networkNum);
  }

  /**
   * Checks if IP is in subnet
   */
  private isInSubnet(ip: IPAddress, network: IPAddress, mask: SubnetMask): boolean {
    const ipNum = ip.toNumber();
    const networkNum = network.toNumber();
    const maskNum = mask.toNumber();

    return ((ipNum & maskNum) >>> 0) === networkNum;
  }

  /**
   * Generates random MAC address
   */
  private generateMAC(): MACAddress {
    const bytes = new Array(6);
    bytes[0] = 0x02; // Locally administered
    for (let i = 1; i < 6; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }

    const macStr = bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
    return new MACAddress(macStr);
  }

  /**
   * Sets up interface callbacks
   */
  private setupInterfaceCallbacks(interfaceName: string, nic: NetworkInterface): void {
    nic.onTransmit((frame) => {
      if (this.frameTransmitCallback) {
        this.frameTransmitCallback(interfaceName, frame);
      }
    });

    nic.onReceive((frame) => {
      this.receiveFrame(interfaceName, frame);
    });
  }
}
