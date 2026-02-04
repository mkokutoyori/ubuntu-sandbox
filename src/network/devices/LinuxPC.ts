/**
 * LinuxPC - Linux workstation/server with terminal
 *
 * Extends EndHost (which provides the full L2/L3 network stack).
 * This class only implements Linux-specific terminal commands and
 * output formatting.
 *
 * Supported commands:
 *   ifconfig <iface> <ip> [netmask <mask>]   — configure interface
 *   ip addr                                   — show IP addresses
 *   ip route [add default via <gw>]           — show/set routes
 *   ping [-c count] <destination>             — ICMP echo
 *   arp [-a]                                  — show ARP table
 *   hostname [name]                           — show/set hostname
 *   traceroute <destination>                  — trace route
 */

import { EndHost, PingResult } from './EndHost';
import { Port } from '../hardware/Port';
import { IPAddress, SubnetMask, DeviceType } from '../core/types';

export class LinuxPC extends EndHost {
  protected readonly defaultTTL = 64;

  constructor(type: DeviceType = 'linux-pc', name: string = 'LinuxPC', x: number = 0, y: number = 0) {
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
    const cmd = parts[0];

    switch (cmd) {
      case 'ifconfig': return this.cmdIfconfig(parts.slice(1));
      case 'ip':       return this.cmdIp(parts.slice(1));
      case 'ping':     return this.cmdPing(parts.slice(1));
      case 'arp':      return this.cmdArp(parts.slice(1));
      case 'hostname':
        if (parts.length > 1) { this.hostname = parts[1]; return ''; }
        return this.hostname;
      case 'traceroute': return this.cmdTraceroute(parts.slice(1));
      default: return `${cmd}: command not found`;
    }
  }

  // ─── ifconfig ──────────────────────────────────────────────────

  private cmdIfconfig(args: string[]): string {
    if (args.length === 0) return this.showAllInterfaces();

    const ifName = args[0];
    const port = this.ports.get(ifName);
    if (!port) return `ifconfig: interface ${ifName} not found`;

    if (args.length === 1) return this.formatInterface(port);

    // ifconfig eth0 192.168.1.10 [netmask 255.255.255.0]
    const ipStr = args[1];
    let maskStr = '255.255.255.0';
    const nmIdx = args.indexOf('netmask');
    if (nmIdx !== -1 && args[nmIdx + 1]) maskStr = args[nmIdx + 1];

    try {
      port.configureIP(new IPAddress(ipStr), new SubnetMask(maskStr));
      return '';
    } catch (e: any) {
      return `ifconfig: ${e.message}`;
    }
  }

  private showAllInterfaces(): string {
    const lines: string[] = [];
    for (const [, port] of this.ports) {
      lines.push(this.formatInterface(port));
      lines.push('');
    }
    return lines.join('\n');
  }

  private formatInterface(port: Port): string {
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    const mac = port.getMAC();
    const status = port.getIsUp() && port.isConnected() ? 'UP,BROADCAST,RUNNING,MULTICAST' : 'UP,BROADCAST,MULTICAST';
    return [
      `${port.getName()}: flags=4163<${status}>  mtu 1500`,
      ip ? `        inet ${ip}  netmask ${mask || '255.255.255.0'}` : '        inet (not configured)',
      `        ether ${mac}`,
      `        RX packets 0  bytes 0 (0.0 B)`,
      `        TX packets 0  bytes 0 (0.0 B)`,
    ].join('\n');
  }

  // ─── ip (modern iproute2) ──────────────────────────────────────

  private cmdIp(args: string[]): string {
    if (args.length === 0) return 'Usage: ip { addr | route | neigh }';

    switch (args[0]) {
      case 'addr':
      case 'address':
      case 'a':
        return this.cmdIpAddr();
      case 'route':
      case 'r':
        return this.cmdIpRoute(args.slice(1));
      case 'neigh':
      case 'neighbor':
      case 'n':
        return this.cmdIpNeigh();
      default:
        return `ip: unknown subcommand '${args[0]}'`;
    }
  }

  private cmdIpAddr(): string {
    const lines: string[] = [];
    let idx = 1;
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      const mac = port.getMAC();
      const state = port.isConnected() ? 'UP' : 'DOWN';
      lines.push(`${idx}: ${port.getName()}: <BROADCAST,MULTICAST,${state}> mtu 1500 state ${state}`);
      lines.push(`    link/ether ${mac} brd ff:ff:ff:ff:ff:ff`);
      if (ip && mask) {
        lines.push(`    inet ${ip}/${mask.toCIDR()} scope global ${port.getName()}`);
      }
      idx++;
    }
    return lines.join('\n');
  }

  private cmdIpRoute(args: string[]): string {
    // ip route add default via <gateway>
    if (args.length >= 4 && args[0] === 'add' && args[1] === 'default' && args[2] === 'via') {
      try {
        this.setDefaultGateway(new IPAddress(args[3]));
        return '';
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    // ip route del default
    if (args.length >= 2 && args[0] === 'del' && args[1] === 'default') {
      this.clearDefaultGateway();
      return '';
    }

    // ip route (show)
    const lines: string[] = [];
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (ip && mask) {
        const maskOctets = mask.getOctets();
        const ipOctets = ip.getOctets();
        const network = ipOctets.map((o, i) => o & maskOctets[i]).join('.');
        lines.push(`${network}/${mask.toCIDR()} dev ${port.getName()} proto kernel scope link src ${ip}`);
      }
    }
    if (this.defaultGateway) {
      // Find which interface the gateway is on
      for (const [, port] of this.ports) {
        const ip = port.getIPAddress();
        const mask = port.getSubnetMask();
        if (ip && mask && ip.isInSameSubnet(this.defaultGateway, mask)) {
          lines.push(`default via ${this.defaultGateway} dev ${port.getName()}`);
          break;
        }
      }
    }
    return lines.length > 0 ? lines.join('\n') : 'No routes configured';
  }

  private cmdIpNeigh(): string {
    if (this.arpTable.size === 0) return '';
    const lines: string[] = [];
    for (const [ip, entry] of this.arpTable) {
      lines.push(`${ip} dev ${entry.iface} lladdr ${entry.mac} REACHABLE`);
    }
    return lines.join('\n');
  }

  // ─── ping ──────────────────────────────────────────────────────

  private async cmdPing(args: string[]): Promise<string> {
    let count = 4;
    let targetStr = '';

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' && args[i + 1]) { count = parseInt(args[i + 1], 10); i++; }
      else if (!args[i].startsWith('-')) { targetStr = args[i]; }
    }

    if (!targetStr) return 'Usage: ping [-c count] <destination>';

    let targetIP: IPAddress;
    try { targetIP = new IPAddress(targetStr); }
    catch { return `ping: ${targetStr}: Name or service not known`; }

    const results = await this.executePingSequence(targetIP, count);

    // Format output
    return this.formatPingOutput(targetIP, count, results);
  }

  private formatPingOutput(targetIP: IPAddress, count: number, results: PingResult[]): string {
    const lines: string[] = [];
    lines.push(`PING ${targetIP} (${targetIP}) 56(84) bytes of data.`);

    const received = results.filter(r => r.success);
    const failed = count - received.length;

    if (results.length === 0) {
      // No route / ARP failed — no replies at all
      lines.push(`connect: Network is unreachable`);
    } else {
      for (const r of results) {
        if (r.success) {
          lines.push(`64 bytes from ${r.fromIP}: icmp_seq=${r.seq} ttl=${r.ttl} time=${r.rttMs.toFixed(3)} ms`);
        }
      }
    }

    lines.push('');
    lines.push(`--- ${targetIP} ping statistics ---`);
    lines.push(`${count} packets transmitted, ${received.length} received, ${Math.round((failed / count) * 100)}% packet loss`);

    if (received.length > 0) {
      const rtts = received.map(r => r.rttMs);
      const min = Math.min(...rtts).toFixed(3);
      const max = Math.max(...rtts).toFixed(3);
      const avg = (rtts.reduce((a, b) => a + b, 0) / rtts.length).toFixed(3);
      const mdev = (Math.sqrt(rtts.reduce((s, r) => s + (r - +avg) ** 2, 0) / rtts.length)).toFixed(3);
      lines.push(`rtt min/avg/max/mdev = ${min}/${avg}/${max}/${mdev} ms`);
    }

    return lines.join('\n');
  }

  // ─── arp ───────────────────────────────────────────────────────

  private cmdArp(args: string[]): string {
    if (args.length === 0 || args[0] === '-a') {
      if (this.arpTable.size === 0) return '';
      const lines: string[] = [];
      for (const [ip, entry] of this.arpTable) {
        lines.push(`? (${ip}) at ${entry.mac} [ether] on ${entry.iface}`);
      }
      return lines.join('\n');
    }
    return 'Usage: arp [-a]';
  }

  // ─── traceroute ────────────────────────────────────────────────

  private async cmdTraceroute(args: string[]): Promise<string> {
    if (args.length === 0) return 'Usage: traceroute <destination>';

    let targetIP: IPAddress;
    try { targetIP = new IPAddress(args[0]); }
    catch { return `traceroute: unknown host ${args[0]}`; }

    const hops = await this.executeTraceroute(targetIP);

    if (hops.length === 0) {
      return `traceroute to ${targetIP}, 30 hops max, 60 byte packets\n * * * Network is unreachable`;
    }

    const lines = [`traceroute to ${targetIP}, 30 hops max, 60 byte packets`];
    for (const hop of hops) {
      if (hop.timeout) {
        lines.push(` ${hop.hop}  * * *`);
      } else {
        lines.push(` ${hop.hop}  ${hop.ip}  ${hop.rttMs!.toFixed(3)} ms`);
      }
    }
    return lines.join('\n');
  }

  // ─── OS Info ───────────────────────────────────────────────────

  getOSType(): string { return 'linux'; }
}
