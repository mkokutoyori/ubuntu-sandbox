/**
 * WindowsPC - Windows workstation/server with terminal
 *
 * Extends EndHost (which provides the full L2/L3 network stack).
 * This class only implements Windows-specific terminal commands and
 * output formatting.
 *
 * Supported commands:
 *   ipconfig                                           — show IP config
 *   netsh interface ip set address "name" static ...   — configure IP
 *   ping [-n count] <destination>                      — ICMP echo
 *   arp -a                                             — show ARP table
 *   tracert <destination>                              — trace route
 *   route add 0.0.0.0 mask 0.0.0.0 <gateway>          — set default route
 */

import { EndHost, PingResult } from './EndHost';
import { Port } from '../hardware/Port';
import { IPAddress, SubnetMask, DeviceType } from '../core/types';

export class WindowsPC extends EndHost {
  protected readonly defaultTTL = 128;

  constructor(type: DeviceType = 'windows-pc', name: string = 'WindowsPC', x: number = 0, y: number = 0) {
    super(type, name, x, y);
    this.createPorts();
  }

  private createPorts(): void {
    for (let i = 0; i < 4; i++) {
      this.addPort(new Port(`eth${i}`, 'ethernet'));
    }
  }

  // ─── Terminal ──────────────────────────────────────────────────

  async executeCommand(command: string): Promise<string> {
    if (!this.isPoweredOn) return 'Device is powered off';

    const parts = command.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case 'ipconfig': return this.cmdIpconfig(parts.slice(1));
      case 'netsh':    return this.cmdNetsh(parts.slice(1));
      case 'ifconfig': return this.cmdIfconfig(parts.slice(1));
      case 'ping':     return this.cmdPing(parts.slice(1));
      case 'arp':      return this.cmdArp(parts.slice(1));
      case 'tracert':
      case 'traceroute': return this.cmdTracert(parts.slice(1));
      case 'route':    return this.cmdRoute(parts.slice(1));
      default: return `'${cmd}' is not recognized as an internal or external command.`;
    }
  }

  // ─── ipconfig ──────────────────────────────────────────────────

  private cmdIpconfig(args: string[]): string {
    const lines: string[] = [
      'Windows IP Configuration',
      '',
    ];
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      const displayName = port.getName().replace(/^eth/, 'Ethernet ');
      lines.push(`Ethernet adapter ${displayName}:`);
      lines.push(`   Connection-specific DNS Suffix  . :`);
      if (ip) {
        lines.push(`   IPv4 Address. . . . . . . . . . . : ${ip}`);
        lines.push(`   Subnet Mask . . . . . . . . . . . : ${mask || '255.255.255.0'}`);
        lines.push(`   Default Gateway . . . . . . . . . : ${this.defaultGateway || ''}`);
      } else {
        lines.push(`   Media State . . . . . . . . . . . : Media disconnected`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  // ─── netsh ─────────────────────────────────────────────────────

  private cmdNetsh(args: string[]): string {
    const joined = args.join(' ');
    const match = joined.match(/interface\s+ip\s+set\s+address\s+"?(\w+[\s\w]*\w*)"?\s+static\s+([\d.]+)\s+([\d.]+)(?:\s+([\d.]+))?/i);
    if (!match) return 'Usage: netsh interface ip set address "name" static <ip> <mask> [gateway]';

    const ifName = match[1].trim();
    // Map Windows names: "Ethernet 0" → "eth0", "Ethernet0" → "eth0"
    const portName = ifName.replace(/^Ethernet\s*/i, 'eth');
    const port = this.ports.get(portName);
    if (!port) return `The interface "${ifName}" was not found.`;

    try {
      port.configureIP(new IPAddress(match[2]), new SubnetMask(match[3]));
      if (match[4]) {
        this.setDefaultGateway(new IPAddress(match[4]));
      }
      return 'Ok.';
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }

  // ─── ifconfig (compatibility) ──────────────────────────────────

  private cmdIfconfig(args: string[]): string {
    if (args.length < 2) return 'Usage: ifconfig <interface> <ip> [netmask <mask>]';
    const port = this.ports.get(args[0]);
    if (!port) return `ifconfig: interface ${args[0]} not found`;

    let maskStr = '255.255.255.0';
    const nmIdx = args.indexOf('netmask');
    if (nmIdx !== -1 && args[nmIdx + 1]) maskStr = args[nmIdx + 1];

    try {
      port.configureIP(new IPAddress(args[1]), new SubnetMask(maskStr));
      return '';
    } catch (e: any) {
      return `ifconfig: ${e.message}`;
    }
  }

  // ─── route ─────────────────────────────────────────────────────

  private cmdRoute(args: string[]): string {
    // route add 0.0.0.0 mask 0.0.0.0 <gateway>
    // route add default <gateway>  (simplified)
    if (args.length >= 2 && args[0].toLowerCase() === 'add') {
      // Simplified: route add default <gw>
      if (args[1] === 'default' && args[2]) {
        try {
          this.setDefaultGateway(new IPAddress(args[2]));
          return ' OK!';
        } catch (e: any) {
          return `The route addition failed: ${e.message}`;
        }
      }
      // Full: route add 0.0.0.0 mask 0.0.0.0 <gw>
      if (args.length >= 5 && args[2].toLowerCase() === 'mask') {
        try {
          this.setDefaultGateway(new IPAddress(args[4]));
          return ' OK!';
        } catch (e: any) {
          return `The route addition failed: ${e.message}`;
        }
      }
    }

    // route print (show routing table)
    if (args.length === 0 || args[0].toLowerCase() === 'print') {
      const lines = [
        '===========================================================================',
        'Active Routes:',
        'Network Destination        Netmask          Gateway         Interface  Metric',
      ];
      for (const [, port] of this.ports) {
        const ip = port.getIPAddress();
        const mask = port.getSubnetMask();
        if (ip && mask) {
          const maskOctets = mask.getOctets();
          const ipOctets = ip.getOctets();
          const network = ipOctets.map((o, i) => o & maskOctets[i]).join('.');
          lines.push(`  ${network.padEnd(24)} ${mask.toString().padEnd(16)} On-link         ${ip.toString().padEnd(14)} 1`);
        }
      }
      if (this.defaultGateway) {
        lines.push(`  0.0.0.0                  0.0.0.0          ${this.defaultGateway.toString().padEnd(15)} On-link         1`);
      }
      lines.push('===========================================================================');
      return lines.join('\n');
    }

    return 'Usage: route { print | add <dest> mask <mask> <gateway> }';
  }

  // ─── ping ──────────────────────────────────────────────────────

  private async cmdPing(args: string[]): Promise<string> {
    let count = 4;
    let targetStr = '';

    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '-n' || args[i] === '-c') && args[i + 1]) { count = parseInt(args[i + 1], 10); i++; }
      else if (!args[i].startsWith('-')) { targetStr = args[i]; }
    }

    if (!targetStr) return 'Usage: ping [-n count] <destination>';

    let targetIP: IPAddress;
    try { targetIP = new IPAddress(targetStr); }
    catch { return `Ping request could not find host ${targetStr}. Please check the name and try again.`; }

    const results = await this.executePingSequence(targetIP, count);
    return this.formatPingOutput(targetIP, count, results);
  }

  private formatPingOutput(targetIP: IPAddress, count: number, results: PingResult[]): string {
    const lines: string[] = [];
    lines.push(`Pinging ${targetIP} with 32 bytes of data:`);
    lines.push('');

    const received = results.filter(r => r.success);
    const lost = count - received.length;

    if (results.length === 0) {
      for (let i = 0; i < count; i++) lines.push('PING: transmit failed. General failure.');
    } else {
      for (const r of results) {
        if (r.success) {
          const ms = r.rttMs < 1 ? '<1ms' : `${Math.round(r.rttMs)}ms`;
          lines.push(`Reply from ${r.fromIP}: bytes=32 time=${ms} TTL=${r.ttl}`);
        } else {
          lines.push('Request timed out.');
        }
      }
    }

    lines.push('');
    lines.push(`Ping statistics for ${targetIP}:`);
    lines.push(`    Packets: Sent = ${count}, Received = ${received.length}, Lost = ${lost} (${Math.round((lost / count) * 100)}% loss),`);

    if (received.length > 0) {
      const rtts = received.map(r => Math.round(r.rttMs));
      const min = Math.min(...rtts);
      const max = Math.max(...rtts);
      const avg = Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length);
      lines.push('Approximate round trip times in milli-seconds:');
      lines.push(`    Minimum = ${min}ms, Maximum = ${max}ms, Average = ${avg}ms`);
    }

    return lines.join('\n');
  }

  // ─── arp ───────────────────────────────────────────────────────

  private cmdArp(args: string[]): string {
    if (this.arpTable.size === 0) return 'No ARP Entries Found.';
    const lines = [
      '',
      'Interface: --- 0x1',
      '  Internet Address      Physical Address      Type',
    ];
    for (const [ip, entry] of this.arpTable) {
      const mac = entry.mac.toString().replace(/:/g, '-');
      lines.push(`  ${ip.padEnd(22)}${mac.padEnd(22)}dynamic`);
    }
    return lines.join('\n');
  }

  // ─── tracert ───────────────────────────────────────────────────

  private async cmdTracert(args: string[]): Promise<string> {
    if (args.length === 0) return 'Usage: tracert <destination>';

    let targetIP: IPAddress;
    try { targetIP = new IPAddress(args[0]); }
    catch { return `Unable to resolve target system name ${args[0]}.`; }

    const hops = await this.executeTraceroute(targetIP);

    if (hops.length === 0) {
      return `Unable to resolve target system name ${args[0]}.`;
    }

    const lines = [
      `Tracing route to ${targetIP} over a maximum of 30 hops:`,
      '',
    ];
    for (const hop of hops) {
      if (hop.timeout) {
        lines.push(`  ${hop.hop}     *        *        *     Request timed out.`);
      } else {
        const ms = Math.round(hop.rttMs!);
        lines.push(`  ${hop.hop}    ${ms} ms    ${ms} ms    ${ms} ms  ${hop.ip}`);
      }
    }
    lines.push('');
    lines.push('Trace complete.');
    return lines.join('\n');
  }

  // ─── OS Info ───────────────────────────────────────────────────

  getOSType(): string { return 'windows'; }
}
