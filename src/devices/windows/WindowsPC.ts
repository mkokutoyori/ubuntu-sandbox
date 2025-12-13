/**
 * WindowsPC - Windows workstation device
 * Connects the Windows terminal emulator to network simulation
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

export interface WindowsPCConfig extends Omit<DeviceConfig, 'type' | 'osType'> {
  type?: 'windows-pc' | 'windows-server';
  osType?: 'windows';
  windowsVersion?: string;
  build?: string;
}

export class WindowsPC extends BaseDevice {
  private arpService: ARPService;
  private windowsVersion: string;
  private build: string;

  constructor(config: WindowsPCConfig) {
    super(config);
    this.windowsVersion = config.windowsVersion || 'Windows 10 Pro';
    this.build = config.build || '22621.2428';
    this.arpService = new ARPService();

    // Connect ARP service to packet sender
    this.arpService.setPacketSender((packet, interfaceId) => {
      if (this.packetSender) {
        this.packetSender(packet, interfaceId);
      }
    });
  }

  getOSType(): string {
    return 'windows';
  }

  getPrompt(): string {
    return `${this.hostname}>`;
  }

  // Execute a command (for network simulation purposes)
  executeCommand(command: string): CommandResult {
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case 'ipconfig':
        return this.cmdIpconfig(args);
      case 'ping':
        return this.cmdPing(args);
      case 'arp':
        return this.cmdArp(args);
      case 'route':
        return this.cmdRoute(args);
      case 'netstat':
        return this.cmdNetstat(args);
      case 'hostname':
        return this.cmdHostname(args);
      default:
        return { output: '', error: `'${cmd}' is not recognized as an internal or external command.`, exitCode: 1 };
    }
  }

  // ==================== Network Commands ====================

  private cmdIpconfig(args: string[]): CommandResult {
    const interfaces = this.networkStack.getInterfaces();
    const showAll = args.some(a => a.toLowerCase() === '/all');

    let output = '\r\nWindows IP Configuration\r\n';

    if (showAll) {
      output += `\r\n   Host Name . . . . . . . . . . . . : ${this.hostname}`;
      output += `\r\n   Primary Dns Suffix  . . . . . . . : `;
      output += `\r\n   Node Type . . . . . . . . . . . . : Hybrid`;
      output += `\r\n   IP Routing Enabled. . . . . . . . : No`;
      output += `\r\n   WINS Proxy Enabled. . . . . . . . : No\r\n`;
    }

    for (const iface of interfaces) {
      output += `\r\nEthernet adapter ${iface.name}:\r\n`;

      if (!iface.isUp) {
        output += `\r\n   Media State . . . . . . . . . . . : Media disconnected`;
        continue;
      }

      if (showAll) {
        output += `\r\n   Connection-specific DNS Suffix  . : `;
        output += `\r\n   Description . . . . . . . . . . . : Intel(R) Ethernet Controller`;
        output += `\r\n   Physical Address. . . . . . . . . : ${this.formatMac(iface.macAddress)}`;
        output += `\r\n   DHCP Enabled. . . . . . . . . . . : ${iface.ipAddress ? 'No' : 'Yes'}`;
        output += `\r\n   Autoconfiguration Enabled . . . . : Yes`;
      }

      if (iface.ipAddress) {
        output += `\r\n   IPv4 Address. . . . . . . . . . . : ${iface.ipAddress}`;
        output += `\r\n   Subnet Mask . . . . . . . . . . . : ${iface.subnetMask || '255.255.255.0'}`;

        const gateway = this.networkStack.getDefaultGateway();
        if (gateway) {
          output += `\r\n   Default Gateway . . . . . . . . . : ${gateway}`;
        }
      } else {
        output += `\r\n   Autoconfiguration IPv4 Address. . : 169.254.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
        output += `\r\n   Subnet Mask . . . . . . . . . . . : 255.255.0.0`;
        output += `\r\n   Default Gateway . . . . . . . . . : `;
      }
    }

    return { output: output + '\r\n', exitCode: 0 };
  }

  private formatMac(mac: string): string {
    return mac.toUpperCase().replace(/:/g, '-');
  }

  private cmdPing(args: string[]): CommandResult {
    if (args.length === 0) {
      return {
        output: '',
        error: '\r\nUsage: ping [-t] [-a] [-n count] [-l size] [-f] [-i TTL] target_name',
        exitCode: 1
      };
    }

    let count = 4;
    let target = '';

    for (let i = 0; i < args.length; i++) {
      const arg = args[i].toLowerCase();
      if (arg === '-n' && args[i + 1]) {
        count = parseInt(args[i + 1]) || 4;
        i++;
      } else if (arg === '-t') {
        count = 4; // Continuous mode - just do 4
      } else if (!args[i].startsWith('-')) {
        target = args[i];
      }
    }

    if (!target) {
      return {
        output: '',
        error: 'IP address must be specified.',
        exitCode: 1
      };
    }

    // Check if we have an interface with IP
    const interfaces = this.networkStack.getInterfaces().filter(i => i.isUp && i.ipAddress);
    if (interfaces.length === 0) {
      return {
        output: '',
        error: `Ping request could not find host ${target}. Please check the name and try again.`,
        exitCode: 1
      };
    }

    const ip = target.match(/^\d+\.\d+\.\d+\.\d+$/) ? target : '93.184.216.34';

    let output = `\r\nPinging ${target} [${ip}] with 32 bytes of data:\r\n`;

    for (let i = 0; i < Math.min(count, 10); i++) {
      const time = Math.floor(Math.random() * 50) + 10;
      output += `Reply from ${ip}: bytes=32 time=${time}ms TTL=64\r\n`;
    }

    const avgTime = Math.floor(Math.random() * 20) + 20;
    output += `\r\nPing statistics for ${ip}:\r\n`;
    output += `    Packets: Sent = ${count}, Received = ${count}, Lost = 0 (0% loss),\r\n`;
    output += `Approximate round trip times in milli-seconds:\r\n`;
    output += `    Minimum = 10ms, Maximum = 50ms, Average = ${avgTime}ms`;

    return { output: output + '\r\n', exitCode: 0 };
  }

  private cmdArp(args: string[]): CommandResult {
    const showAll = args.some(a => a.toLowerCase() === '-a');
    const showHelp = args.some(a => a === '/?');

    if (showHelp) {
      return {
        output: '\r\nDisplays and modifies the IP-to-Physical address translation tables used by\r\naddress resolution protocol (ARP).\r\n\r\nARP -s inet_addr eth_addr [if_addr]\r\nARP -d inet_addr [if_addr]\r\nARP -a [inet_addr] [-N if_addr] [-v]',
        exitCode: 0
      };
    }

    const arpEntries = this.arpService.getTable();
    const interfaces = this.networkStack.getInterfaces().filter(i => i.isUp && i.ipAddress);

    if (interfaces.length === 0) {
      return { output: '\r\nNo ARP Entries Found.\r\n', exitCode: 0 };
    }

    let output = '';
    for (const iface of interfaces) {
      output += `\r\nInterface: ${iface.ipAddress} --- 0x${Math.floor(Math.random() * 100).toString(16)}\r\n`;
      output += `  Internet Address      Physical Address      Type\r\n`;

      const ifaceEntries = arpEntries.filter(e => e.interface === iface.name);
      for (const entry of ifaceEntries) {
        output += `  ${entry.ipAddress.padEnd(20)} ${this.formatMac(entry.macAddress).padEnd(21)} ${entry.state}\r\n`;
      }

      // Add some default entries
      output += `  ${iface.ipAddress!.split('.').slice(0, 3).join('.')}.255       ff-ff-ff-ff-ff-ff     static\r\n`;
      output += `  224.0.0.22            01-00-5e-00-00-16     static\r\n`;
    }

    return { output: output + '\r\n', exitCode: 0 };
  }

  private cmdRoute(args: string[]): CommandResult {
    const print = args.some(a => a.toLowerCase() === 'print');

    if (print || args.length === 0) {
      const routes = this.networkStack.getRoutingTable();
      const interfaces = this.networkStack.getInterfaces();

      let output = '\r\n===========================================================================\r\n';
      output += 'Interface List\r\n';

      interfaces.forEach((iface, index) => {
        output += ` ${index + 10}...${iface.macAddress.replace(/:/g, ' ')} ......${iface.name}\r\n`;
      });

      output += '  1...........................Software Loopback Interface 1\r\n';
      output += '===========================================================================\r\n\r\n';
      output += 'IPv4 Route Table\r\n';
      output += '===========================================================================\r\n';
      output += 'Active Routes:\r\n';
      output += 'Network Destination        Netmask          Gateway       Interface  Metric\r\n';

      for (const route of routes) {
        output += `${route.destination.padEnd(23)} ${route.netmask.padEnd(17)}${route.gateway.padEnd(14)}${(this.networkStack.getInterfaces().find(i => i.name === route.interface)?.ipAddress || route.interface).padEnd(11)}${route.metric}\r\n`;
      }

      output += '===========================================================================\r\n';
      output += 'Persistent Routes:\r\n';
      output += '  None\r\n';

      return { output: output + '\r\n', exitCode: 0 };
    }

    return { output: '', error: 'The requested operation requires elevation.', exitCode: 1 };
  }

  private cmdNetstat(args: string[]): CommandResult {
    const showAll = args.some(a => a.toLowerCase() === '-a');
    const numeric = args.some(a => a.toLowerCase() === '-n');
    const showPid = args.some(a => a.toLowerCase() === '-o');

    let output = '\r\nActive Connections\r\n\r\n';

    if (showPid) {
      output += '  Proto  Local Address          Foreign Address        State           PID\r\n';
      output += '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       888\r\n';
      output += '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4\r\n';
    } else {
      output += '  Proto  Local Address          Foreign Address        State\r\n';
      output += '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING\r\n';
      output += '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING\r\n';
    }

    return { output: output + '\r\n', exitCode: 0 };
  }

  private cmdHostname(args: string[]): CommandResult {
    return { output: this.hostname.toUpperCase() + '\r\n', exitCode: 0 };
  }

  // ==================== Packet Processing ====================

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

    // Let network stack handle other packets
    return this.networkStack.processIncomingPacket(packet, interfaceId);
  }

  getARPService(): ARPService {
    return this.arpService;
  }
}

// Export factory function
export function createWindowsPC(config: Partial<WindowsPCConfig> & { id: string; name: string }): WindowsPC {
  return new WindowsPC({
    id: config.id,
    name: config.name,
    hostname: config.hostname || config.name.toUpperCase().replace(/[^A-Z0-9]/g, '-'),
    type: 'windows-pc',
    osType: 'windows',
    interfaces: config.interfaces || [
      {
        id: `${config.id}-eth0`,
        name: 'Ethernet',
        type: 'ethernet',
        macAddress: generateMacAddress(),
        isUp: false,
        speed: '1Gbps',
        duplex: 'auto'
      }
    ],
    isPoweredOn: config.isPoweredOn ?? true,
    windowsVersion: config.windowsVersion,
    build: config.build,
    x: config.x ?? 0,
    y: config.y ?? 0
  });
}
