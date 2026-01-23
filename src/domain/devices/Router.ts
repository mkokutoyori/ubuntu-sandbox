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
 * Router - Layer 3 routing device
 */
export class Router extends BaseDevice {
  private interfaces: Map<string, NetworkInterface>;
  private arpServices: Map<string, ARPService>;
  private routingTable: Route[];
  private statistics: RouterStatistics;
  private packetForwardCallback?: PacketForwardCallback;
  private packetDropCallback?: PacketDropCallback;
  private frameTransmitCallback?: FrameTransmitCallback;

  constructor(id: string, name: string, interfaceCount: number = 2) {
    super(id, name, 'router');

    this.interfaces = new Map();
    this.arpServices = new Map();
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

      this.forwardPacket(packet, interfaceName);
    } catch (error) {
      // Silently drop malformed packets
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
