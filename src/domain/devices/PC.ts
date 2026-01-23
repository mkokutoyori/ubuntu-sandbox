/**
 * PC (Personal Computer) Device
 *
 * Represents a computer with:
 * - Single network interface (eth0)
 * - IP stack with ARP support
 * - Frame transmission and reception
 *
 * Design Pattern: Composite
 * - Composes NetworkInterface and ARPService
 *
 * @example
 * ```typescript
 * const pc = new PC('pc1', 'Workstation 1');
 *
 * // Configure network
 * pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
 * pc.setGateway(new IPAddress('192.168.1.1'));
 *
 * // Power on
 * pc.powerOn();
 *
 * // Send frame
 * pc.onFrameTransmit((frame) => {
 *   // Forward frame to network
 * });
 *
 * pc.sendFrame('eth0', frame);
 * ```
 */

import { BaseDevice } from './BaseDevice';
import { NetworkInterface } from './NetworkInterface';
import { ARPService, ARPPacket } from '../network/services/ARPService';
import { ICMPService } from '../network/services/ICMPService';
import { IPAddress } from '../network/value-objects/IPAddress';
import { SubnetMask } from '../network/value-objects/SubnetMask';
import { MACAddress } from '../network/value-objects/MACAddress';
import { EthernetFrame, EtherType } from '../network/entities/EthernetFrame';
import { IPv4Packet, IPProtocol } from '../network/entities/IPv4Packet';
import { ICMPPacket } from '../network/entities/ICMPPacket';

/**
 * Frame callback type
 */
type FrameCallback = (frame: EthernetFrame) => void;

/**
 * PC - Personal Computer device
 */
export class PC extends BaseDevice {
  private interfaces: Map<string, NetworkInterface>;
  private arpService: ARPService;
  private icmpService: ICMPService;
  private hostname: string;
  private gateway?: IPAddress;
  private transmitCallback?: FrameCallback;
  private receiveCallback?: FrameCallback;

  constructor(id: string, name: string) {
    super(id, name, 'pc');

    this.interfaces = new Map();
    this.arpService = new ARPService();
    this.icmpService = new ICMPService();
    this.hostname = name;

    // Create default network interface (eth0)
    const mac = this.generateMAC();
    const nic = new NetworkInterface('eth0', mac);
    this.interfaces.set('eth0', nic);
    this.addPort('eth0');

    // Setup interface callbacks
    this.setupInterfaceCallbacks(nic);
  }

  /**
   * Powers on the PC
   */
  public powerOn(): void {
    this.status = 'online';

    // Bring up all network interfaces
    for (const nic of this.interfaces.values()) {
      nic.up();
    }
  }

  /**
   * Powers off the PC
   */
  public powerOff(): void {
    this.status = 'offline';

    // Bring down all network interfaces
    for (const nic of this.interfaces.values()) {
      nic.down();
    }
  }

  /**
   * Resets the PC
   */
  public reset(): void {
    this.powerOff();
    this.powerOn();
  }

  /**
   * Sets hostname
   *
   * @param hostname - Hostname for the PC
   */
  public setHostname(hostname: string): void {
    this.hostname = hostname;
  }

  /**
   * Returns hostname
   */
  public getHostname(): string {
    return this.hostname;
  }

  /**
   * Gets network interface by name
   *
   * @param name - Interface name
   * @returns NetworkInterface or undefined if not found
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
   * Returns all network interfaces
   *
   * @returns Array of NetworkInterface
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
   * @throws {Error} If interface not found
   */
  public setIPAddress(interfaceName: string, ip: IPAddress, mask: SubnetMask): void {
    const nic = this.interfaces.get(interfaceName);
    if (!nic) {
      throw new Error(`Interface not found: ${interfaceName}`);
    }

    nic.setIPAddress(ip, mask);
  }

  /**
   * Sets default gateway
   *
   * @param gateway - Gateway IP address
   */
  public setGateway(gateway: IPAddress): void {
    this.gateway = gateway;

    // Set gateway on primary interface (eth0)
    const nic = this.interfaces.get('eth0');
    if (nic) {
      nic.setGateway(gateway);
    }
  }

  /**
   * Creates ARP request for target IP
   *
   * @param targetIP - Target IP to resolve
   * @returns ARP request packet
   */
  public createARPRequest(targetIP: IPAddress): ARPPacket {
    const nic = this.interfaces.get('eth0')!;
    const sourceIP = nic.getIPAddress();
    const sourceMAC = nic.getMAC();

    if (!sourceIP) {
      throw new Error('Interface has no IP address');
    }

    return this.arpService.createRequest(sourceIP, sourceMAC, targetIP);
  }

  /**
   * Resolves IP address to MAC address using ARP cache
   *
   * @param ip - IP address to resolve
   * @returns MAC address or undefined if not in cache
   */
  public resolveMAC(ip: IPAddress): MACAddress | undefined {
    return this.arpService.resolve(ip);
  }

  /**
   * Adds entry to ARP cache
   *
   * @param ip - IP address
   * @param mac - MAC address
   */
  public addARPEntry(ip: IPAddress, mac: MACAddress): void {
    this.arpService.addEntry(ip, mac);
  }

  /**
   * Processes ARP packet
   *
   * @param packet - ARP packet to process
   */
  public processARPPacket(packet: ARPPacket): void {
    this.arpService.processPacket(packet);
  }

  /**
   * Returns ARP service (for testing)
   */
  public getARPService(): ARPService {
    return this.arpService;
  }

  /**
   * Sends frame on interface
   *
   * @param interfaceName - Interface name
   * @param frame - Ethernet frame to send
   * @throws {Error} If interface not found
   */
  public sendFrame(interfaceName: string, frame: EthernetFrame): void {
    const nic = this.interfaces.get(interfaceName);
    if (!nic) {
      throw new Error(`Interface not found: ${interfaceName}`);
    }

    nic.transmit(frame);
  }

  /**
   * Receives frame on interface
   *
   * @param interfaceName - Interface name
   * @param frame - Ethernet frame received
   */
  public receiveFrame(interfaceName: string, frame: EthernetFrame): void {
    const nic = this.interfaces.get(interfaceName);
    if (!nic) {
      return; // Silently drop
    }

    nic.receive(frame);
  }

  /**
   * Registers callback for transmitted frames
   *
   * @param callback - Function to call when frame is transmitted
   */
  public onFrameTransmit(callback: FrameCallback): void {
    this.transmitCallback = callback;
  }

  /**
   * Registers callback for received frames
   *
   * @param callback - Function to call when frame is received
   */
  public onFrameReceive(callback: FrameCallback): void {
    this.receiveCallback = callback;
  }

  /**
   * Generates random MAC address for interface
   *
   * @returns Random MAC address
   */
  private generateMAC(): MACAddress {
    // Generate locally administered MAC (bit 1 of first octet = 1)
    const bytes = new Array(6);
    bytes[0] = 0x02; // Locally administered
    for (let i = 1; i < 6; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }

    const macStr = bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
    return new MACAddress(macStr);
  }

  /**
   * Sets up callbacks for network interface
   *
   * @param nic - Network interface
   */
  private setupInterfaceCallbacks(nic: NetworkInterface): void {
    // Handle transmitted frames
    nic.onTransmit((frame) => {
      if (this.transmitCallback) {
        this.transmitCallback(frame);
      }
    });

    // Handle received frames
    nic.onReceive((frame) => {
      // Process ARP frames
      if (frame.getEtherType() === EtherType.ARP) {
        this.handleARPFrame(frame);
      }

      // Process IPv4 frames
      if (frame.getEtherType() === EtherType.IPv4) {
        this.handleIPv4Frame(frame);
      }

      // Forward to application layer
      if (this.receiveCallback) {
        this.receiveCallback(frame);
      }
    });
  }

  /**
   * Handles ARP frame
   *
   * @param frame - Ethernet frame containing ARP packet
   */
  private handleARPFrame(frame: EthernetFrame): void {
    try {
      const payload = frame.getPayload();
      const arpPacket = this.arpService.deserializePacket(payload);

      // Process ARP packet (updates cache)
      this.arpService.processPacket(arpPacket);

      // If it's a request for our IP, send reply
      if (arpPacket.operation === 'request') {
        const nic = this.interfaces.get('eth0')!;
        const ourIP = nic.getIPAddress();

        if (ourIP && arpPacket.targetIP.equals(ourIP)) {
          const reply = this.arpService.createReply(
            ourIP,
            nic.getMAC(),
            arpPacket.senderIP,
            arpPacket.senderMAC
          );

          // Send ARP reply
          const replyBytes = this.arpService.serializePacket(reply);
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

          this.sendFrame('eth0', replyFrame);
        }
      }
    } catch (error) {
      // Silently drop malformed ARP packets
    }
  }

  /**
   * Handles IPv4 frame
   *
   * @param frame - Ethernet frame containing IPv4 packet
   */
  private handleIPv4Frame(frame: EthernetFrame): void {
    try {
      const payload = frame.getPayload();
      const ipPacket = IPv4Packet.fromBytes(payload);

      // Only process ICMP packets
      if (ipPacket.getProtocol() !== IPProtocol.ICMP) {
        return;
      }

      const icmpPacket = ICMPPacket.fromBytes(ipPacket.getPayload());

      // Handle Echo Request - send Echo Reply
      if (icmpPacket.isEchoRequest()) {
        this.sendEchoReply(ipPacket.getSourceIP(), icmpPacket);
      }

      // Handle Echo Reply - notify ICMP service
      if (icmpPacket.isEchoReply()) {
        this.icmpService.handleEchoReply(ipPacket.getSourceIP(), icmpPacket);
      }
    } catch (error) {
      // Silently drop malformed IPv4/ICMP packets
    }
  }

  /**
   * Sends ICMP Echo Reply
   *
   * @param destination - Destination IP (original source)
   * @param request - Original Echo Request packet
   */
  private sendEchoReply(destination: IPAddress, request: ICMPPacket): void {
    const nic = this.interfaces.get('eth0');
    if (!nic || !nic.getIPAddress()) {
      return;
    }

    // Create Echo Reply
    const reply = ICMPPacket.createEchoReply(request);

    // Encapsulate in IP packet
    const replyBytes = reply.toBytes();
    const ipPacket = new IPv4Packet({
      sourceIP: nic.getIPAddress()!,
      destinationIP: destination,
      protocol: IPProtocol.ICMP,
      ttl: 64,
      payload: replyBytes
    });

    // Determine next hop (use gateway if destination is not on local network)
    let nextHop = destination;
    if (this.gateway) {
      const ourMask = nic.getSubnetMask();
      if (ourMask) {
        const ourNetwork = (nic.getIPAddress()!.toNumber() & ourMask.toNumber()) >>> 0;
        const destNetwork = (destination.toNumber() & ourMask.toNumber()) >>> 0;

        // If destination is on different network, use gateway
        if (ourNetwork !== destNetwork) {
          nextHop = this.gateway;
        }
      }
    }

    // Resolve next hop MAC
    const destMAC = this.resolveMAC(nextHop);
    if (!destMAC) {
      // Can't send without MAC - in real implementation would queue and send ARP request
      return;
    }

    // Encapsulate in Ethernet frame
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

    this.sendFrame('eth0', frame);
  }

  /**
   * Returns ICMP service instance
   */
  public getICMPService(): ICMPService {
    return this.icmpService;
  }

  /**
   * Returns gateway IP
   */
  public getGateway(): IPAddress | undefined {
    return this.gateway;
  }
}
