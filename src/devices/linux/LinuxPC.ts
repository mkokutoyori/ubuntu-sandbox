/**
 * LinuxPC - Linux workstation device
 * Connects the existing terminal emulator to network simulation
 */

import { BaseDevice } from '../common/BaseDevice';
import { DeviceConfig, CommandResult, NetworkInterfaceConfig, generateMacAddress } from '../common/types';
import { NetworkStack } from '../common/NetworkStack';
import {
  Packet,
  IPv4Packet,
  ICMPPacket,
  ICMPType,
  ETHER_TYPE,
  IP_PROTOCOL,
  BROADCAST_MAC,
  generatePacketId,
  createICMPEchoRequest
} from '../../core/network/packet';
import { ARPService } from '../../core/network/arp';
import { FileSystem } from '../../terminal/filesystem';

export interface LinuxPCConfig extends Omit<DeviceConfig, 'type' | 'osType'> {
  type?: 'linux-pc' | 'linux-server';
  osType?: 'linux';
  // Additional Linux-specific config
  distribution?: string;
  kernelVersion?: string;
}

export class LinuxPC extends BaseDevice {
  private arpService: ARPService;
  private distribution: string;
  private kernelVersion: string;
  private pingSequence: number = 0;
  private pendingPings: Map<number, {
    target: string;
    startTime: number;
    timeout: NodeJS.Timeout;
    resolve: (result: PingResult) => void;
  }> = new Map();

  // Each device has its own isolated filesystem
  private fileSystem: FileSystem;

  constructor(config: LinuxPCConfig) {
    super(config);
    this.distribution = config.distribution || 'Ubuntu 22.04 LTS';
    this.kernelVersion = config.kernelVersion || '5.15.0-generic';
    this.arpService = new ARPService();

    // Create isolated filesystem for this device
    this.fileSystem = new FileSystem();

    // Update hostname in the filesystem
    const hostnameNode = this.fileSystem.getNode('/etc/hostname');
    if (hostnameNode) {
      hostnameNode.content = this.hostname + '\n';
    }

    // Connect ARP service to packet sender
    this.arpService.setPacketSender((packet, interfaceId) => {
      if (this.packetSender) {
        this.packetSender(packet, interfaceId);
      }
    });
  }

  getOSType(): string {
    return 'linux';
  }

  getPrompt(): string {
    return `${this.hostname}:~$ `;
  }

  // Get the device's isolated filesystem
  getFileSystem(): FileSystem {
    return this.fileSystem;
  }

  // Execute a shell command
  executeCommand(command: string): CommandResult {
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    switch (cmd) {
      case 'ifconfig':
        return this.cmdIfconfig(args);
      case 'ip':
        return this.cmdIP(args);
      case 'ping':
        return this.cmdPing(args);
      case 'arp':
        return this.cmdArp(args);
      case 'route':
        return this.cmdRoute(args);
      case 'hostname':
        return this.cmdHostname(args);
      default:
        return { output: '', error: `${cmd}: command not found`, exitCode: 127 };
    }
  }

  // ==================== Network Commands ====================

  private cmdIfconfig(args: string[]): CommandResult {
    const interfaces = this.networkStack.getInterfaces();

    if (args.length === 0) {
      // Show all interfaces
      let output = '';
      for (const iface of interfaces) {
        if (iface.isUp) {
          output += this.formatInterface(iface) + '\n\n';
        }
      }
      return { output: output.trim(), exitCode: 0 };
    }

    const ifaceName = args[0];
    const iface = this.networkStack.getInterfaceByName(ifaceName);

    if (!iface) {
      return { output: '', error: `ifconfig: ${ifaceName}: error fetching interface information: Device not found`, exitCode: 1 };
    }

    // Check for interface commands
    if (args.includes('up')) {
      this.networkStack.configureInterface(iface.id, { isUp: true });
      return { output: '', exitCode: 0 };
    }

    if (args.includes('down')) {
      this.networkStack.configureInterface(iface.id, { isUp: false });
      return { output: '', exitCode: 0 };
    }

    // Check for IP address configuration
    const ipIndex = args.findIndex(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    if (ipIndex !== -1) {
      const ip = args[ipIndex];
      let netmask = '255.255.255.0';

      // Check for netmask
      const netmaskIndex = args.indexOf('netmask');
      if (netmaskIndex !== -1 && args[netmaskIndex + 1]) {
        netmask = args[netmaskIndex + 1];
      }

      if (!this.networkStack.isValidIP(ip)) {
        return { output: '', error: `ifconfig: ${ip}: Invalid argument`, exitCode: 1 };
      }

      this.networkStack.configureInterface(iface.id, {
        ipAddress: ip,
        subnetMask: netmask,
        isUp: true
      });
      return { output: '', exitCode: 0 };
    }

    // Show specific interface
    return { output: this.formatInterface(iface), exitCode: 0 };
  }

  private formatInterface(iface: NetworkInterfaceConfig): string {
    const flags = iface.isUp ? 'UP,BROADCAST,RUNNING,MULTICAST' : 'BROADCAST,MULTICAST';
    const lines = [
      `${iface.name}: flags=4163<${flags}>  mtu 1500`,
    ];

    if (iface.ipAddress) {
      const broadcast = this.networkStack.getBroadcastAddress(iface.ipAddress, iface.subnetMask || '255.255.255.0');
      lines.push(`        inet ${iface.ipAddress}  netmask ${iface.subnetMask || '255.255.255.0'}  broadcast ${broadcast}`);
    }

    lines.push(`        ether ${iface.macAddress.toLowerCase()}  txqueuelen 1000  (Ethernet)`);
    lines.push(`        RX packets 0  bytes 0 (0.0 B)`);
    lines.push(`        RX errors 0  dropped 0  overruns 0  frame 0`);
    lines.push(`        TX packets 0  bytes 0 (0.0 B)`);
    lines.push(`        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0`);

    return lines.join('\n');
  }

  private cmdIP(args: string[]): CommandResult {
    if (args.length === 0) {
      return {
        output: `Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }
where  OBJECT := { link | address | addr | route | neigh | arp }`,
        exitCode: 0
      };
    }

    const object = args[0];
    const subArgs = args.slice(1);

    switch (object) {
      case 'addr':
      case 'address':
      case 'a':
        return this.cmdIPAddr(subArgs);
      case 'link':
      case 'l':
        return this.cmdIPLink(subArgs);
      case 'route':
      case 'r':
        return this.cmdIPRoute(subArgs);
      case 'neigh':
      case 'neighbor':
      case 'arp':
        return this.cmdIPNeigh(subArgs);
      default:
        return { output: '', error: `ip: unknown object "${object}"`, exitCode: 1 };
    }
  }

  private cmdIPAddr(args: string[]): CommandResult {
    const interfaces = this.networkStack.getInterfaces();
    let output = '';

    interfaces.forEach((iface, index) => {
      const state = iface.isUp ? 'UP' : 'DOWN';
      output += `${index + 1}: ${iface.name}: <BROADCAST,MULTICAST,${state}> mtu 1500 qdisc fq_codel state ${state} group default qlen 1000\n`;
      output += `    link/ether ${iface.macAddress.toLowerCase()} brd ff:ff:ff:ff:ff:ff\n`;

      if (iface.ipAddress) {
        const prefix = this.networkStack.netmaskToPrefix(iface.subnetMask || '255.255.255.0');
        const broadcast = this.networkStack.getBroadcastAddress(iface.ipAddress, iface.subnetMask || '255.255.255.0');
        output += `    inet ${iface.ipAddress}/${prefix} brd ${broadcast} scope global ${iface.name}\n`;
        output += `       valid_lft forever preferred_lft forever\n`;
      }
    });

    return { output: output.trim(), exitCode: 0 };
  }

  private cmdIPLink(args: string[]): CommandResult {
    const interfaces = this.networkStack.getInterfaces();
    let output = '';

    interfaces.forEach((iface, index) => {
      const state = iface.isUp ? 'UP' : 'DOWN';
      output += `${index + 1}: ${iface.name}: <BROADCAST,MULTICAST,${state}> mtu 1500 qdisc fq_codel state ${state} mode DEFAULT group default qlen 1000\n`;
      output += `    link/ether ${iface.macAddress.toLowerCase()} brd ff:ff:ff:ff:ff:ff\n`;
    });

    return { output: output.trim(), exitCode: 0 };
  }

  private cmdIPRoute(args: string[]): CommandResult {
    const routes = this.networkStack.getRoutingTable();

    if (args.length === 0 || args[0] === 'show' || args[0] === 'list') {
      if (routes.length === 0) {
        return { output: '', exitCode: 0 };
      }

      let output = '';
      for (const route of routes) {
        const prefix = this.networkStack.netmaskToPrefix(route.netmask);
        if (route.destination === '0.0.0.0') {
          output += `default via ${route.gateway} dev ${route.interface} proto ${route.protocol} metric ${route.metric}\n`;
        } else {
          if (route.gateway === '0.0.0.0') {
            output += `${route.destination}/${prefix} dev ${route.interface} proto kernel scope link src ${this.networkStack.getInterfaceByName(route.interface)?.ipAddress || ''} metric ${route.metric}\n`;
          } else {
            output += `${route.destination}/${prefix} via ${route.gateway} dev ${route.interface} proto ${route.protocol} metric ${route.metric}\n`;
          }
        }
      }

      return { output: output.trim(), exitCode: 0 };
    }

    if (args[0] === 'add') {
      // ip route add <network>/<prefix> via <gateway> dev <interface>
      return this.addRoute(args.slice(1));
    }

    if (args[0] === 'del' || args[0] === 'delete') {
      return this.delRoute(args.slice(1));
    }

    return { output: '', exitCode: 0 };
  }

  private addRoute(args: string[]): CommandResult {
    // Parse: <dest>[/<prefix>] via <gateway> [dev <interface>]
    let dest = '';
    let prefix = 24;
    let gateway = '';
    let interfaceName = '';

    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'via') {
        gateway = args[++i] || '';
      } else if (args[i] === 'dev') {
        interfaceName = args[++i] || '';
      } else if (!args[i].startsWith('-') && !dest) {
        const parts = args[i].split('/');
        dest = parts[0];
        if (parts[1]) {
          prefix = parseInt(parts[1]);
        }
      }
    }

    if (!dest) {
      return { output: '', error: 'ip: missing destination', exitCode: 2 };
    }

    const netmask = this.networkStack.prefixToNetmask(prefix);

    // Find interface if not specified
    if (!interfaceName && gateway) {
      const route = this.networkStack.lookupRoute(gateway);
      if (route) {
        interfaceName = route.interface;
      }
    }

    if (!interfaceName) {
      const ifaces = this.networkStack.getInterfaces().filter(i => i.isUp && i.ipAddress);
      if (ifaces.length > 0) {
        interfaceName = ifaces[0].name;
      }
    }

    const success = this.networkStack.addStaticRoute(dest, netmask, gateway || '0.0.0.0', interfaceName);
    if (!success) {
      return { output: '', error: 'RTNETLINK answers: File exists', exitCode: 2 };
    }

    return { output: '', exitCode: 0 };
  }

  private delRoute(args: string[]): CommandResult {
    // Parse: <dest>[/<prefix>]
    if (args.length === 0) {
      return { output: '', error: 'ip: missing destination', exitCode: 2 };
    }

    const parts = args[0].split('/');
    const dest = parts[0];
    const prefix = parts[1] ? parseInt(parts[1]) : 24;
    const netmask = this.networkStack.prefixToNetmask(prefix);

    const success = this.networkStack.removeRoute(dest, netmask);
    if (!success) {
      return { output: '', error: 'RTNETLINK answers: No such process', exitCode: 2 };
    }

    return { output: '', exitCode: 0 };
  }

  private cmdIPNeigh(args: string[]): CommandResult {
    const arpEntries = this.arpService.getTable();

    if (args.length === 0 || args[0] === 'show') {
      if (arpEntries.length === 0) {
        return { output: '', exitCode: 0 };
      }

      let output = '';
      for (const entry of arpEntries) {
        output += `${entry.ipAddress} dev ${entry.interface} lladdr ${entry.macAddress.toLowerCase()} ${entry.state.toUpperCase()}\n`;
      }

      return { output: output.trim(), exitCode: 0 };
    }

    return { output: '', exitCode: 0 };
  }

  private cmdArp(args: string[]): CommandResult {
    if (args.includes('-a') || args.length === 0) {
      return { output: this.arpService.formatTable(), exitCode: 0 };
    }

    if (args.includes('-d') && args.length >= 2) {
      // Delete ARP entry
      const ipIndex = args.indexOf('-d') + 1;
      const ip = args[ipIndex];
      this.arpService.removeEntry(ip);
      return { output: '', exitCode: 0 };
    }

    if (args.includes('-s') && args.length >= 3) {
      // Add static ARP entry: arp -s <ip> <mac>
      const ipIndex = args.indexOf('-s') + 1;
      const ip = args[ipIndex];
      const mac = args[ipIndex + 1];
      this.arpService.addStaticEntry(ip, mac, 'eth0');
      return { output: '', exitCode: 0 };
    }

    return { output: '', exitCode: 0 };
  }

  private cmdRoute(args: string[]): CommandResult {
    if (args.includes('-n') || args.length === 0) {
      const routes = this.networkStack.getRoutingTable();

      let output = 'Kernel IP routing table\n';
      output += 'Destination     Gateway         Genmask         Flags Metric Ref    Use Iface\n';

      for (const route of routes) {
        const flags = route.gateway === '0.0.0.0' ? 'U' : 'UG';
        output += `${route.destination.padEnd(16)}${route.gateway.padEnd(16)}${route.netmask.padEnd(16)}${flags.padEnd(6)}${String(route.metric).padEnd(7)}0      0 ${route.interface}\n`;
      }

      return { output, exitCode: 0 };
    }

    return { output: '', exitCode: 0 };
  }

  private cmdHostname(args: string[]): CommandResult {
    if (args.includes('-I')) {
      const interfaces = this.networkStack.getInterfaces();
      const ips = interfaces
        .filter(i => i.ipAddress && i.isUp)
        .map(i => i.ipAddress)
        .join(' ');
      return { output: ips || '', exitCode: 0 };
    }

    if (args.length > 0 && !args[0].startsWith('-')) {
      this.hostname = args[0];
      return { output: '', exitCode: 0 };
    }

    return { output: this.hostname, exitCode: 0 };
  }

  private cmdPing(args: string[]): CommandResult {
    // Note: This is a synchronous simulation for display
    // Real async ping would need different architecture

    if (args.length === 0) {
      return { output: '', error: 'ping: usage error: Destination address required', exitCode: 1 };
    }

    let count = 4;
    let target = '';

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' && args[i + 1]) {
        count = parseInt(args[++i]) || 4;
      } else if (!args[i].startsWith('-')) {
        target = args[i];
      }
    }

    if (!target) {
      return { output: '', error: 'ping: usage error: Destination address required', exitCode: 1 };
    }

    // Validate target is a valid IP address
    if (!this.networkStack.isValidIP(target)) {
      return { output: '', error: `ping: ${target}: Name or service not known`, exitCode: 2 };
    }

    // Find outgoing interfaces with IP
    const interfaces = this.networkStack.getInterfaces().filter(i => i.isUp && i.ipAddress);
    if (interfaces.length === 0) {
      return { output: '', error: `ping: connect: Network is unreachable`, exitCode: 1 };
    }

    // Check if target is our own IP (localhost ping) or loopback
    const isLocalIP = interfaces.some(i => i.ipAddress === target);
    if (isLocalIP || target === '127.0.0.1' || target.startsWith('127.')) {
      return this.simulatePingSuccess(target, count, true);
    }

    // Check if we have a route to the target
    const route = this.networkStack.lookupRoute(target);
    if (!route) {
      return { output: '', error: `ping: connect: Network is unreachable`, exitCode: 1 };
    }

    // Get the outgoing interface
    const outInterface = this.networkStack.getInterfaceByName(route.interface);
    if (!outInterface || !outInterface.isUp || !outInterface.ipAddress) {
      return { output: '', error: `ping: connect: Network is unreachable`, exitCode: 1 };
    }

    // Check if target is on the same subnet (directly connected)
    const isDirectlyConnected = this.networkStack.isIPInNetwork(
      target,
      this.networkStack.getNetworkAddress(outInterface.ipAddress, outInterface.subnetMask || '255.255.255.0'),
      outInterface.subnetMask || '255.255.255.0'
    );

    if (isDirectlyConnected) {
      // For directly connected networks, simulate success
      // In a full simulation, we'd check if the target device exists
      return this.simulatePingSuccess(target, count, false);
    }

    // For routed traffic, check if we have a gateway
    if (route.gateway && route.gateway !== '0.0.0.0') {
      // We have a gateway - simulate success (in real sim, we'd trace the path)
      return this.simulatePingSuccess(target, count, false);
    }

    // No valid path to destination - simulate timeout
    return this.simulatePingTimeout(target, count);
  }

  private simulatePingSuccess(target: string, count: number, isLocal: boolean): CommandResult {
    const lines = [`PING ${target} (${target}) 56(84) bytes of data.`];
    const ttl = isLocal ? 64 : 64 - Math.floor(Math.random() * 10);
    const baseTime = isLocal ? 0.01 : 10;
    const timeVariance = isLocal ? 0.05 : 40;

    const times: number[] = [];
    for (let i = 0; i < Math.min(count, 10); i++) {
      const time = baseTime + Math.random() * timeVariance;
      times.push(time);
      lines.push(`64 bytes from ${target}: icmp_seq=${i + 1} ttl=${ttl} time=${time.toFixed(isLocal ? 3 : 1)} ms`);
    }

    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    const mdev = Math.sqrt(times.reduce((sum, t) => sum + Math.pow(t - avgTime, 2), 0) / times.length);

    lines.push('');
    lines.push(`--- ${target} ping statistics ---`);
    lines.push(`${count} packets transmitted, ${count} received, 0% packet loss, time ${count * 1000}ms`);
    lines.push(`rtt min/avg/max/mdev = ${minTime.toFixed(3)}/${avgTime.toFixed(3)}/${maxTime.toFixed(3)}/${mdev.toFixed(3)} ms`);

    return { output: lines.join('\n'), exitCode: 0 };
  }

  private simulatePingTimeout(target: string, count: number): CommandResult {
    const lines = [`PING ${target} (${target}) 56(84) bytes of data.`];

    // No response output for timed out packets

    lines.push('');
    lines.push(`--- ${target} ping statistics ---`);
    lines.push(`${count} packets transmitted, 0 received, 100% packet loss, time ${count * 1000}ms`);

    return { output: lines.join('\n'), exitCode: 1 };
  }

  // ==================== Packet Processing ====================

  // Process incoming packet with ARP handling
  processPacket(packet: Packet, interfaceId: string): Packet | null {
    if (!this.isPoweredOn) {
      return null;
    }

    const iface = this.networkStack.getInterface(interfaceId);
    if (!iface || !iface.isUp) {
      return null;
    }

    const frame = packet.frame;

    // Check if frame is for us
    if (frame.destinationMAC !== iface.macAddress &&
        frame.destinationMAC !== BROADCAST_MAC) {
      return null;
    }

    // Handle ARP
    if (frame.etherType === ETHER_TYPE.ARP && iface.ipAddress) {
      const arpReply = this.arpService.processPacket(
        frame.payload as any,
        iface.name,
        iface.ipAddress,
        iface.macAddress
      );

      if (arpReply) {
        return arpReply;
      }
    }

    // Let network stack handle other packets (IPv4, ICMP, etc.)
    return this.networkStack.processIncomingPacket(packet, interfaceId);
  }

  // Get ARP service for external access
  getARPService(): ARPService {
    return this.arpService;
  }
}

// Ping result interface
export interface PingResult {
  success: boolean;
  target: string;
  time: number;  // ms
  ttl: number;
  sequence: number;
  error?: string;
}

// Export factory function
export function createLinuxPC(config: Partial<LinuxPCConfig> & { id: string; name: string }): LinuxPC {
  return new LinuxPC({
    id: config.id,
    name: config.name,
    hostname: config.hostname || config.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
    type: 'linux-pc',
    osType: 'linux',
    interfaces: config.interfaces || [
      {
        id: `${config.id}-eth0`,
        name: 'eth0',
        type: 'ethernet',
        macAddress: generateMacAddress(),
        isUp: false,
        speed: '1Gbps',
        duplex: 'auto'
      }
    ],
    isPoweredOn: config.isPoweredOn ?? true,
    distribution: config.distribution,
    kernelVersion: config.kernelVersion,
    x: config.x ?? 0,
    y: config.y ?? 0
  });
}
