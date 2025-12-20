/**
 * CiscoDevice - Cisco Router and Switch device implementation
 * Extends BaseDevice with Cisco IOS-specific functionality
 */

import { BaseDevice } from '../common/BaseDevice';
import { DeviceConfig, CommandResult, NetworkInterfaceConfig, generateMacAddress } from '../common/types';
import { NetworkStack } from '../common/NetworkStack';
import {
  Packet,
  IPv4Packet,
  ICMPPacket,
  ICMPType,
  EthernetFrame,
  UDPDatagram,
  ETHER_TYPE,
  IP_PROTOCOL,
  BROADCAST_MAC,
  generatePacketId,
} from '../../core/network/packet';
import { ARPService } from '../../core/network/arp';
import { DHCPServer, DHCPPoolConfig, parseDHCPPacket, isDHCPPacket, DHCP_SERVER_PORT, DHCP_CLIENT_PORT } from '../../core/network/dhcp';
import { DNSServer, parseDNSMessage, isDNSPacket, DNS_PORT } from '../../core/network/dns';
import {
  CiscoConfig,
  CiscoTerminalState,
  CiscoDeviceType,
  CiscoInterface,
  CiscoRoute,
  CiscoARPEntry,
  CiscoMACEntry,
  RealDeviceData,
} from '../../terminal/cisco/types';
import {
  createDefaultRouterConfig,
  createDefaultSwitchConfig,
  createDefaultTerminalState,
} from '../../terminal/cisco/state';

export interface CiscoDeviceConfig extends Omit<DeviceConfig, 'type' | 'osType'> {
  type?: 'router-cisco' | 'switch-cisco';
  osType?: 'cisco-ios';
  ciscoType?: CiscoDeviceType;
}

/**
 * CiscoDevice class for both routers and switches
 */
export class CiscoDevice extends BaseDevice {
  private arpService: ARPService;
  private dhcpServer: DHCPServer;
  private dnsServer: DNSServer;
  private ciscoConfig: CiscoConfig;
  private terminalState: CiscoTerminalState;
  private bootTime: Date;
  private ciscoType: CiscoDeviceType;

  // MAC address table for switches
  private macTable: Map<string, CiscoMACEntry> = new Map();

  // VLAN database for switches
  private vlanDatabase: Map<number, Set<string>> = new Map();

  constructor(config: CiscoDeviceConfig) {
    super({
      ...config,
      type: config.type || 'router-cisco',
      osType: 'cisco-ios',
    });

    this.ciscoType = config.ciscoType || (config.type === 'switch-cisco' ? 'switch' : 'router');
    this.bootTime = new Date();

    // Initialize Cisco-specific configuration
    this.ciscoConfig = this.ciscoType === 'switch'
      ? createDefaultSwitchConfig(config.hostname || 'Switch')
      : createDefaultRouterConfig(config.hostname || 'Router');

    this.terminalState = createDefaultTerminalState(this.ciscoConfig.hostname);

    // Initialize ARP service
    this.arpService = new ARPService();
    this.arpService.setPacketSender((packet, interfaceId) => {
      if (this.packetSender) {
        this.packetSender(packet, interfaceId);
      }
    });

    // Initialize DHCP server (for routers)
    this.dhcpServer = new DHCPServer();
    this.dhcpServer.setPacketSender((packet, interfaceId) => {
      if (this.packetSender) {
        this.packetSender(packet, interfaceId);
      }
    });

    // Initialize DNS server
    this.dnsServer = new DNSServer();
    this.dnsServer.setPacketSender((packet, interfaceId) => {
      if (this.packetSender) {
        this.packetSender(packet, interfaceId);
      }
    });

    // Sync interfaces with Cisco config
    this.syncInterfaces();

    // Sync DHCP pools from Cisco config
    this.syncDHCPPools();
  }

  /**
   * Sync NetworkStack interfaces with Cisco config
   */
  private syncInterfaces(): void {
    // Update Cisco config interfaces with actual network stack interfaces
    for (const iface of this.networkStack.getInterfaces()) {
      const ciscoIface = this.ciscoConfig.interfaces.get(iface.name);
      if (ciscoIface) {
        ciscoIface.macAddress = iface.macAddress;
        ciscoIface.ipAddress = iface.ipAddress;
        ciscoIface.subnetMask = iface.subnetMask;
        ciscoIface.isUp = iface.isUp;
        ciscoIface.isAdminDown = !iface.isUp;
      }
    }
  }

  /**
   * Sync DHCP pools from Cisco config to DHCP server
   */
  private syncDHCPPools(): void {
    for (const pool of this.ciscoConfig.dhcpPools) {
      const dhcpPool: DHCPPoolConfig = {
        name: pool.name,
        network: pool.network || '0.0.0.0',
        mask: pool.mask || '255.255.255.0',
        defaultRouter: pool.defaultRouter,
        dnsServer: pool.dnsServer,
        domain: pool.domain,
        leaseTime: pool.leaseTime || 86400,
        excludedAddresses: pool.excludedAddresses || [],
      };
      this.dhcpServer.addPool(dhcpPool);
    }

    // Set DHCP server interface based on first configured interface
    const interfaces = this.networkStack.getInterfaces();
    if (interfaces.length > 0) {
      const iface = interfaces[0];
      if (iface.ipAddress) {
        this.dhcpServer.setInterface(iface.id, iface.ipAddress, iface.macAddress);
        this.dnsServer.setInterface(iface.id, iface.ipAddress, iface.macAddress);
      }
    }
  }

  getOSType(): string {
    return 'cisco-ios';
  }

  getCiscoType(): CiscoDeviceType {
    return this.ciscoType;
  }

  getPrompt(): string {
    const { hostname, mode } = this.terminalState;

    switch (mode) {
      case 'user':
        return `${hostname}>`;
      case 'privileged':
        return `${hostname}#`;
      case 'global-config':
        return `${hostname}(config)#`;
      case 'interface':
        return `${hostname}(config-if)#`;
      case 'line':
        return `${hostname}(config-line)#`;
      case 'router':
        return `${hostname}(config-router)#`;
      case 'vlan':
        return `${hostname}(config-vlan)#`;
      default:
        return `${hostname}#`;
    }
  }

  /**
   * Get Cisco configuration
   */
  getCiscoConfig(): CiscoConfig {
    return this.ciscoConfig;
  }

  /**
   * Get terminal state
   */
  getTerminalState(): CiscoTerminalState {
    return this.terminalState;
  }

  /**
   * Get boot time
   */
  getBootTime(): Date {
    return this.bootTime;
  }

  /**
   * Execute a CLI command
   */
  executeCommand(command: string): CommandResult {
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    // Handle network-specific commands that interact with the simulation
    switch (cmd) {
      case 'ping':
        return this.cmdPing(args);
      case 'arp':
        return this.cmdArp(args);
      case 'show':
        return this.cmdShow(args);
      default:
        // For other commands, return generic response
        // The full CLI is handled by the CiscoTerminal component
        return {
          output: '',
          error: `Command '${cmd}' should be executed via terminal`,
          exitCode: 127,
        };
    }
  }

  // ==================== Network Commands ====================

  private cmdPing(args: string[]): CommandResult {
    if (args.length === 0) {
      return { output: '', error: '% Incomplete command.', exitCode: 1 };
    }

    const target = args[0];
    const count = 5;

    // Find outgoing interface
    const interfaces = this.networkStack.getInterfaces().filter(i => i.isUp && i.ipAddress);
    if (interfaces.length === 0) {
      return {
        output: '',
        error: '% No source IP address available for ping',
        exitCode: 1,
      };
    }

    // Simulate ping response
    const lines: string[] = [
      `Type escape sequence to abort.`,
      `Sending ${count}, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:`,
    ];

    let successes = 0;
    let responses = '';

    for (let i = 0; i < count; i++) {
      if (Math.random() > 0.2) {
        responses += '!';
        successes++;
      } else {
        responses += '.';
      }
    }

    lines.push(responses);
    lines.push(`Success rate is ${Math.round((successes / count) * 100)} percent (${successes}/${count})`);

    if (successes > 0) {
      const minTime = 1 + Math.floor(Math.random() * 10);
      const maxTime = minTime + Math.floor(Math.random() * 20);
      const avgTime = Math.floor((minTime + maxTime) / 2);
      lines.push(`round-trip min/avg/max = ${minTime}/${avgTime}/${maxTime} ms`);
    }

    return { output: lines.join('\n'), exitCode: successes > 0 ? 0 : 1 };
  }

  private cmdArp(args: string[]): CommandResult {
    const entries = this.arpService.getTable();

    const lines: string[] = [
      'Protocol  Address          Age (min)  Hardware Addr   Type   Interface',
    ];

    for (const entry of entries) {
      lines.push(
        `Internet  ${entry.ipAddress.padEnd(17)}${String(entry.age || 0).padEnd(11)}${entry.macAddress.padEnd(16)}ARPA   ${entry.interface}`
      );
    }

    return { output: lines.join('\n'), exitCode: 0 };
  }

  private cmdShow(args: string[]): CommandResult {
    if (args.length === 0) {
      return { output: '', error: '% Incomplete command.', exitCode: 1 };
    }

    const subCmd = args[0].toLowerCase();

    switch (subCmd) {
      case 'arp':
        return this.cmdArp([]);

      case 'ip':
        if (args[1] === 'interface' || args[1] === 'int') {
          return this.showIPInterface(args.slice(2));
        }
        if (args[1] === 'route') {
          return this.showIPRoute();
        }
        break;

      case 'interfaces':
        return this.showInterfaces(args.slice(1));

      case 'mac':
        if (args[1] === 'address-table') {
          return this.showMACTable();
        }
        break;

      case 'vlan':
        return this.showVlan();
    }

    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  private showIPInterface(args: string[]): CommandResult {
    if (args.length === 0 || args[0] === 'brief') {
      const lines: string[] = [
        'Interface              IP-Address      OK? Method Status                Protocol',
      ];

      for (const iface of this.networkStack.getInterfaces()) {
        const ip = iface.ipAddress || 'unassigned';
        const status = iface.isUp ? 'up' : 'down';
        lines.push(
          `${iface.name.padEnd(23)}${ip.padEnd(16)}YES manual  ${status.padEnd(22)}${status}`
        );
      }

      return { output: lines.join('\n'), exitCode: 0 };
    }

    return { output: '', exitCode: 0 };
  }

  private showIPRoute(): CommandResult {
    const routes = this.networkStack.getRoutingTable();

    const lines: string[] = [
      'Codes: C - connected, S - static, R - RIP, M - mobile, B - BGP',
      '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
      '',
      'Gateway of last resort is not set',
      '',
    ];

    for (const route of routes) {
      const code = route.protocol === 'connected' ? 'C' : 'S';
      lines.push(
        `${code}    ${route.destination}/${this.networkStack.netmaskToPrefix(route.netmask)} is directly connected, ${route.interface}`
      );
    }

    return { output: lines.join('\n'), exitCode: 0 };
  }

  private showInterfaces(args: string[]): CommandResult {
    const lines: string[] = [];

    for (const iface of this.networkStack.getInterfaces()) {
      const status = iface.isUp ? 'up' : 'down';
      lines.push(`${iface.name} is ${status}, line protocol is ${status}`);
      lines.push(`  Hardware is ${iface.type}, address is ${iface.macAddress}`);
      if (iface.ipAddress) {
        lines.push(`  Internet address is ${iface.ipAddress}/${this.networkStack.netmaskToPrefix(iface.subnetMask || '255.255.255.0')}`);
      }
      lines.push(`  MTU 1500 bytes, BW 1000000 Kbit/sec, DLY 10 usec`);
      lines.push('');
    }

    return { output: lines.join('\n'), exitCode: 0 };
  }

  private showMACTable(): CommandResult {
    if (this.ciscoType !== 'switch') {
      return { output: '', error: '% Invalid input detected', exitCode: 1 };
    }

    const lines: string[] = [
      '          Mac Address Table',
      '-------------------------------------------',
      '',
      'Vlan    Mac Address       Type        Ports',
      '----    -----------       --------    -----',
    ];

    for (const [mac, entry] of this.macTable) {
      lines.push(
        ` ${String(entry.vlan).padEnd(7)} ${entry.macAddress.padEnd(17)} ${entry.type.padEnd(11)} ${entry.ports}`
      );
    }

    lines.push('');
    lines.push(`Total Mac Addresses for this criterion: ${this.macTable.size}`);

    return { output: lines.join('\n'), exitCode: 0 };
  }

  private showVlan(): CommandResult {
    if (this.ciscoType !== 'switch') {
      return { output: '', error: '% Invalid input detected', exitCode: 1 };
    }

    const lines: string[] = [
      'VLAN Name                             Status    Ports',
      '---- -------------------------------- --------- -------------------------------',
    ];

    for (const [id, vlan] of this.ciscoConfig.vlans) {
      const ports: string[] = [];
      for (const [ifName, iface] of this.ciscoConfig.interfaces) {
        if (iface.accessVlan === id) {
          ports.push(this.getShortInterfaceName(ifName));
        }
      }

      lines.push(
        `${String(id).padEnd(5)}${vlan.name.padEnd(33)}${vlan.state.padEnd(10)}${ports.slice(0, 4).join(', ')}`
      );
    }

    return { output: lines.join('\n'), exitCode: 0 };
  }

  private getShortInterfaceName(name: string): string {
    return name
      .replace('GigabitEthernet', 'Gi')
      .replace('FastEthernet', 'Fa')
      .replace('Serial', 'Se')
      .replace('Loopback', 'Lo');
  }

  // ==================== Packet Processing ====================

  /**
   * Process incoming packet
   */
  processPacket(packet: Packet, interfaceId: string): Packet | null {
    if (!this.isPoweredOn) {
      return null;
    }

    const iface = this.networkStack.getInterface(interfaceId);
    if (!iface || !iface.isUp) {
      return null;
    }

    const frame = packet.frame;

    // Switch-specific: MAC learning and forwarding
    if (this.ciscoType === 'switch') {
      return this.processSwitchPacket(packet, interfaceId);
    }

    // Router-specific: Layer 3 processing
    return this.processRouterPacket(packet, interfaceId);
  }

  /**
   * Switch packet processing - Layer 2 forwarding
   */
  private processSwitchPacket(packet: Packet, interfaceId: string): Packet | null {
    const frame = packet.frame;
    const iface = this.networkStack.getInterface(interfaceId);
    if (!iface) return null;

    const ciscoIface = this.ciscoConfig.interfaces.get(iface.name);
    const vlanId = ciscoIface?.accessVlan || 1;

    // MAC learning (case-insensitive)
    if (frame.sourceMAC.toUpperCase() !== BROADCAST_MAC) {
      this.macTable.set(frame.sourceMAC.toUpperCase(), {
        vlan: vlanId,
        macAddress: frame.sourceMAC.toUpperCase(),
        type: 'DYNAMIC',
        ports: iface.name,
      });
    }

    // Check if destination is us (VLAN interface or management)
    if (frame.destinationMAC.toUpperCase() === iface.macAddress.toUpperCase()) {
      return this.networkStack.processIncomingPacket(packet, interfaceId);
    }

    // Forwarding decision
    if (frame.destinationMAC.toUpperCase() === BROADCAST_MAC) {
      // Flood to all ports in same VLAN except source
      // In simulation, we return null as flooding is handled by network layer
      return null;
    }

    // Unicast - lookup MAC table (case-insensitive)
    const entry = this.macTable.get(frame.destinationMAC.toUpperCase());
    if (entry && entry.vlan === vlanId) {
      // Forward to specific port
      if (this.packetSender) {
        const destIface = this.networkStack.getInterfaceByName(entry.ports);
        if (destIface && destIface.id !== interfaceId) {
          this.packetSender(packet, destIface.id);
        }
      }
    }

    return null;
  }

  /**
   * Router packet processing - Layer 3 forwarding
   */
  private processRouterPacket(packet: Packet, interfaceId: string): Packet | null {
    const frame = packet.frame;
    const iface = this.networkStack.getInterface(interfaceId);

    if (!iface) return null;

    // Check if frame is for us (case-insensitive MAC comparison)
    if (frame.destinationMAC.toUpperCase() !== iface.macAddress.toUpperCase() &&
        frame.destinationMAC.toUpperCase() !== BROADCAST_MAC) {
      return null;
    }

    // Handle ARP
    if (frame.etherType === ETHER_TYPE.ARP && iface.ipAddress) {
      const arpPacket = frame.payload as any;

      // Learn sender's MAC in both ARPService and NetworkStack
      this.arpService.addDynamicEntry(arpPacket.senderIP, arpPacket.senderMAC, iface.name);
      this.networkStack.addARPEntry(arpPacket.senderIP, arpPacket.senderMAC, iface.name, false);

      const arpReply = this.arpService.processPacket(
        arpPacket,
        iface.name,
        iface.ipAddress,
        iface.macAddress
      );
      // Send ARP reply via packetSender
      if (arpReply && this.packetSender) {
        this.packetSender(arpReply, interfaceId);
      }
      return null;  // Response sent via callback
    }

    // Handle IPv4
    if (frame.etherType === ETHER_TYPE.IPv4) {
      const ipPacket = frame.payload as IPv4Packet;

      // Handle UDP for DHCP and DNS
      if (ipPacket.protocol === IP_PROTOCOL.UDP) {
        const udpPacket = ipPacket.payload as UDPDatagram;

        // Handle DHCP (server receives on port 67)
        if (isDHCPPacket(udpPacket) && udpPacket.destinationPort === DHCP_SERVER_PORT) {
          const dhcpPacket = parseDHCPPacket(udpPacket.payload);
          if (dhcpPacket) {
            const response = this.dhcpServer.processPacket(dhcpPacket, interfaceId);
            if (response && this.packetSender) {
              this.packetSender(response, interfaceId);
            }
          }
          return null;
        }

        // Handle DNS (server receives on port 53)
        if (isDNSPacket(udpPacket) && udpPacket.destinationPort === DNS_PORT) {
          const dnsMessage = parseDNSMessage(udpPacket.payload);
          if (dnsMessage && !dnsMessage.header.flags.qr) {
            const response = this.dnsServer.processQuery(
              dnsMessage,
              ipPacket.sourceIP,
              frame.sourceMAC,
              interfaceId
            );
            if (response && this.packetSender) {
              this.packetSender(response, interfaceId);
            }
          }
          return null;
        }
      }

      // Check if packet is for us
      const destIP = ipPacket.destinationIP;
      const isForUs = this.networkStack
        .getInterfaces()
        .some(i => i.ipAddress === destIP) || destIP === '255.255.255.255';

      if (isForUs) {
        // Process locally (ICMP, etc.)
        return this.networkStack.processIncomingPacket(packet, interfaceId);
      }

      // Route packet
      return this.routePacket(packet, interfaceId);
    }

    return this.networkStack.processIncomingPacket(packet, interfaceId);
  }

  /**
   * Route a packet to its destination
   * This is the core Layer 3 forwarding function
   */
  private routePacket(packet: Packet, sourceInterfaceId: string): Packet | null {
    const originalIP = packet.frame.payload as IPv4Packet;

    // Decrement TTL
    if (originalIP.ttl <= 1) {
      // TTL expired - send ICMP Time Exceeded
      this.sendICMPTimeExceeded(originalIP, sourceInterfaceId);
      return null;
    }

    // Create a copy of the IP packet with decremented TTL
    const routedIP: IPv4Packet = {
      ...originalIP,
      ttl: originalIP.ttl - 1
    };

    // Lookup route
    const route = this.networkStack.lookupRoute(routedIP.destinationIP);
    if (!route) {
      // No route - send ICMP Destination Unreachable
      this.sendICMPDestUnreachable(originalIP, sourceInterfaceId, 'network');
      return null;
    }

    // Get outgoing interface
    const outIface = this.networkStack.getInterfaceByName(route.interface);
    if (!outIface || !outIface.isUp) {
      this.sendICMPDestUnreachable(originalIP, sourceInterfaceId, 'network');
      return null;
    }

    // Don't route back out the same interface (split horizon)
    if (outIface.id === sourceInterfaceId) {
      return null;
    }

    // Determine next hop IP (gateway or direct)
    const nextHopIP = route.gateway !== '0.0.0.0' ? route.gateway : routedIP.destinationIP;

    // Lookup MAC for next hop
    let nextHopMAC = this.networkStack.lookupARP(nextHopIP);

    if (!nextHopMAC) {
      // Need to do ARP for next hop
      this.networkStack.sendARPRequest(nextHopIP, outIface);

      // Queue packet for later sending (simplified: just drop for now, but trigger ARP)
      // In production, we'd queue this and retry after ARP completes
      // For now, we'll check if we have any cached ARP entry
      nextHopMAC = this.arpService.lookup(nextHopIP);

      if (!nextHopMAC) {
        // Schedule retry after ARP (simplified approach)
        setTimeout(() => {
          const resolvedMAC = this.networkStack.lookupARP(nextHopIP) || this.arpService.lookup(nextHopIP);
          if (resolvedMAC) {
            this.forwardRoutedPacket(routedIP, outIface, resolvedMAC);
          }
        }, 100);
        return null;
      }
    }

    // Forward the packet
    this.forwardRoutedPacket(routedIP, outIface, nextHopMAC);
    return null;
  }

  /**
   * Forward a routed IP packet with new Ethernet frame
   */
  private forwardRoutedPacket(
    ipPacket: IPv4Packet,
    outInterface: NetworkInterfaceConfig,
    destinationMAC: string
  ): void {
    if (!this.packetSender) return;

    // Create new Ethernet frame with router's MAC as source
    const newFrame: EthernetFrame = {
      destinationMAC: destinationMAC,
      sourceMAC: outInterface.macAddress,
      etherType: ETHER_TYPE.IPv4,
      payload: ipPacket
    };

    const newPacket: Packet = {
      id: generatePacketId(),
      timestamp: Date.now(),
      frame: newFrame,
      hops: [],
      status: 'in_transit'
    };

    this.packetSender(newPacket, outInterface.id);
  }

  /**
   * Send ICMP Time Exceeded message
   */
  private sendICMPTimeExceeded(originalIP: IPv4Packet, incomingInterfaceId: string): void {
    const inIface = this.networkStack.getInterface(incomingInterfaceId);
    if (!inIface || !inIface.ipAddress || !this.packetSender) return;

    // Get source MAC from ARP
    const sourceMAC = this.networkStack.lookupARP(originalIP.sourceIP);
    if (!sourceMAC) return;

    const icmpPacket: ICMPPacket = {
      type: ICMPType.TIME_EXCEEDED,
      code: 0, // TTL exceeded in transit
      checksum: 0,
      identifier: 0,
      sequenceNumber: 0,
      data: undefined
    };

    const responseIP: IPv4Packet = {
      version: 4,
      headerLength: 20,
      dscp: 0,
      totalLength: 0,
      identification: Math.floor(Math.random() * 65535),
      flags: 0,
      fragmentOffset: 0,
      ttl: 64,
      protocol: IP_PROTOCOL.ICMP,
      headerChecksum: 0,
      sourceIP: inIface.ipAddress,
      destinationIP: originalIP.sourceIP,
      payload: icmpPacket
    };

    const frame: EthernetFrame = {
      destinationMAC: sourceMAC,
      sourceMAC: inIface.macAddress,
      etherType: ETHER_TYPE.IPv4,
      payload: responseIP
    };

    const packet: Packet = {
      id: generatePacketId(),
      timestamp: Date.now(),
      frame,
      hops: [],
      status: 'in_transit'
    };

    this.packetSender(packet, incomingInterfaceId);
  }

  /**
   * Send ICMP Destination Unreachable message
   */
  private sendICMPDestUnreachable(
    originalIP: IPv4Packet,
    incomingInterfaceId: string,
    _reason: 'network' | 'host' | 'port'
  ): void {
    const inIface = this.networkStack.getInterface(incomingInterfaceId);
    if (!inIface || !inIface.ipAddress || !this.packetSender) return;

    // Get source MAC from ARP
    const sourceMAC = this.networkStack.lookupARP(originalIP.sourceIP);
    if (!sourceMAC) return;

    const icmpPacket: ICMPPacket = {
      type: ICMPType.DESTINATION_UNREACHABLE,
      code: 0, // Network unreachable
      checksum: 0,
      identifier: 0,
      sequenceNumber: 0,
      data: undefined
    };

    const responseIP: IPv4Packet = {
      version: 4,
      headerLength: 20,
      dscp: 0,
      totalLength: 0,
      identification: Math.floor(Math.random() * 65535),
      flags: 0,
      fragmentOffset: 0,
      ttl: 64,
      protocol: IP_PROTOCOL.ICMP,
      headerChecksum: 0,
      sourceIP: inIface.ipAddress,
      destinationIP: originalIP.sourceIP,
      payload: icmpPacket
    };

    const frame: EthernetFrame = {
      destinationMAC: sourceMAC,
      sourceMAC: inIface.macAddress,
      etherType: ETHER_TYPE.IPv4,
      payload: responseIP
    };

    const packet: Packet = {
      id: generatePacketId(),
      timestamp: Date.now(),
      frame,
      hops: [],
      status: 'in_transit'
    };

    this.packetSender(packet, incomingInterfaceId);
  }

  /**
   * Get ARP service
   */
  getARPService(): ARPService {
    return this.arpService;
  }

  /**
   * Get DHCP server
   */
  getDHCPServer(): DHCPServer {
    return this.dhcpServer;
  }

  /**
   * Get DNS server
   */
  getDNSServer(): DNSServer {
    return this.dnsServer;
  }

  /**
   * Add DHCP pool
   */
  addDHCPPool(pool: DHCPPoolConfig): void {
    this.dhcpServer.addPool(pool);
  }

  /**
   * Get DHCP leases
   */
  getDHCPLeases(): Array<{ ipAddress: string; macAddress: string; state: string }> {
    return this.dhcpServer.getLeases().map(lease => ({
      ipAddress: lease.ipAddress,
      macAddress: lease.macAddress,
      state: lease.state,
    }));
  }

  /**
   * Get real device data for CLI display
   * Returns current state from NetworkStack for accurate show commands
   */
  getRealDeviceData(): RealDeviceData {
    // Get interfaces from NetworkStack
    const interfaces = this.networkStack.getInterfaces().map(iface => ({
      id: iface.id,
      name: iface.name,
      type: iface.type || 'GigabitEthernet',
      macAddress: iface.macAddress,
      ipAddress: iface.ipAddress,
      subnetMask: iface.subnetMask,
      isUp: iface.isUp,
    }));

    // Get routing table from NetworkStack
    const routingTable = this.networkStack.getRoutingTable().map(route => ({
      destination: route.destination,
      netmask: route.netmask,
      gateway: route.gateway,
      interface: route.interface,
      metric: route.metric || 0,
      protocol: route.protocol || 'connected',
    }));

    // Get ARP table from both ARPService and NetworkStack
    const arpEntries = this.arpService.getTable();
    const arpTable = arpEntries.map(entry => ({
      ipAddress: entry.ipAddress,
      macAddress: entry.macAddress,
      interface: entry.interface,
      age: entry.age,
    }));

    // Get MAC table for switches
    const macTable = Array.from(this.macTable.values()).map(entry => ({
      vlan: entry.vlan,
      macAddress: entry.macAddress,
      type: entry.type,
      ports: entry.ports,
    }));

    return {
      interfaces,
      routingTable,
      arpTable,
      macTable: this.ciscoType === 'switch' ? macTable : undefined,
    };
  }

  /**
   * Configure interface IP address
   */
  configureIP(interfaceName: string, ipAddress: string, subnetMask: string): boolean {
    const ciscoIface = this.ciscoConfig.interfaces.get(interfaceName);
    if (!ciscoIface) return false;

    ciscoIface.ipAddress = ipAddress;
    ciscoIface.subnetMask = subnetMask;

    // Also update network stack
    const iface = this.networkStack.getInterfaceByName(interfaceName);
    if (iface) {
      this.networkStack.configureInterface(iface.id, {
        ipAddress,
        subnetMask,
      });
    }

    return true;
  }

  /**
   * Set interface admin state
   */
  setInterfaceState(interfaceName: string, up: boolean): boolean {
    const ciscoIface = this.ciscoConfig.interfaces.get(interfaceName);
    if (!ciscoIface) return false;

    ciscoIface.isAdminDown = !up;
    ciscoIface.isUp = up;

    // Also update network stack
    const iface = this.networkStack.getInterfaceByName(interfaceName);
    if (iface) {
      this.networkStack.configureInterface(iface.id, { isUp: up });
    }

    return true;
  }

  /**
   * Add static route
   */
  addStaticRoute(
    network: string,
    mask: string,
    nextHop: string,
    interfaceName?: string
  ): boolean {
    this.ciscoConfig.staticRoutes.push({
      protocol: 'S',
      network,
      mask,
      nextHop,
      interface: interfaceName,
      administrativeDistance: 1,
    });

    // Also add to network stack
    return this.networkStack.addStaticRoute(network, mask, nextHop, interfaceName || '');
  }

  /**
   * Serialize device state
   */
  serialize(): DeviceConfig {
    return {
      ...super.serialize(),
      config: {
        ciscoConfig: {
          hostname: this.ciscoConfig.hostname,
          deviceType: this.ciscoConfig.deviceType,
          // Add more config as needed
        },
      },
    };
  }
}

/**
 * Create a Cisco router
 */
export function createCiscoRouter(config: Partial<CiscoDeviceConfig> & { id: string; name: string }): CiscoDevice {
  return new CiscoDevice({
    id: config.id,
    name: config.name,
    hostname: config.hostname || config.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
    type: 'router-cisco',
    osType: 'cisco-ios',
    ciscoType: 'router',
    interfaces: config.interfaces || [],
    isPoweredOn: config.isPoweredOn ?? true,
    x: config.x ?? 0,
    y: config.y ?? 0
  });
}

/**
 * Create a Cisco switch
 */
export function createCiscoSwitch(config: Partial<CiscoDeviceConfig> & { id: string; name: string }): CiscoDevice {
  return new CiscoDevice({
    id: config.id,
    name: config.name,
    hostname: config.hostname || config.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
    type: 'switch-cisco',
    osType: 'cisco-ios',
    ciscoType: 'switch',
    interfaces: config.interfaces || [],
    isPoweredOn: config.isPoweredOn ?? true,
    x: config.x ?? 0,
    y: config.y ?? 0
  });
}
