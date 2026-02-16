/**
 * WindowsPC - Windows workstation with cmd.exe terminal
 *
 * Extends EndHost (which provides the full L2/L3 network stack).
 * Delegates command execution to modular handlers under windows/.
 *
 * Supported commands:
 *   help [command]                                     — list Windows commands
 *   ipconfig [/all] [/release] [/renew] [/flushdns] [/?]  — IP configuration
 *   netsh [/?] interface ip set address ...             — network shell
 *   ping [-n count] [-i ttl] <dest> [/?]                — ICMP echo
 *   arp [-a] [/?]                                       — ARP table
 *   tracert <dest> [/?]                                 — trace route
 *   route {print|add|delete} [/?]                       — routing table
 *   wevtutil qe System ... [/?]                         — Event Log
 */

import { EndHost, PingResult } from './EndHost';
import { Port } from '../hardware/Port';
import { IPAddress, SubnetMask, DeviceType } from '../core/types';
import type { WinCommandContext, RouteEntry, TracerouteHop } from './windows/WinCommandExecutor';
import { cmdHelp } from './windows/WinHelp';
import { cmdIpconfig } from './windows/WinIpconfig';
import { cmdNetsh } from './windows/WinNetsh';
import { cmdPing } from './windows/WinPing';
import { cmdArp } from './windows/WinArp';
import { cmdTracert } from './windows/WinTracert';
import { cmdRoute } from './windows/WinRoute';
import { cmdWevtutil } from './windows/WinWevtutil';

export class WindowsPC extends EndHost {
  protected readonly defaultTTL = 128;
  /** DHCP event log for Windows Event Viewer */
  private dhcpEventLog: string[] = [];
  /** Track synced DHCP events to avoid duplicates */
  private trackedEvents: Set<string> = new Set();

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

    const trimmed = command.trim();
    if (!trimmed) return '';

    // Handle piped commands
    if (trimmed.includes('|')) {
      return this.executePipedCommand(trimmed);
    }

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const ctx = this.buildContext();

    switch (cmd) {
      case 'help':     return cmdHelp(parts.slice(1));
      case 'ipconfig': return cmdIpconfig(ctx, parts.slice(1));
      case 'netsh':    return cmdNetsh(ctx, parts.slice(1));
      case 'ifconfig': return this.cmdIfconfig(parts.slice(1));
      case 'ping':     return cmdPing(ctx, parts.slice(1));
      case 'arp':      return cmdArp(ctx, parts.slice(1));
      case 'tracert':
      case 'traceroute': return cmdTracert(ctx, parts.slice(1));
      case 'route':    return cmdRoute(ctx, parts.slice(1));
      case 'wevtutil': return cmdWevtutil(ctx, parts.slice(1));
      case 'hostname': return this.hostname;
      case 'ver':      return '\nMicrosoft Windows [Version 10.0.22631.6649]';
      case 'cls':      return '';
      case 'systeminfo': return this.cmdSysteminfo();
      default:
        return `'${cmd}' is not recognized as an internal or external command,\noperable program or batch file.`;
    }
  }

  // ─── Piped Commands ─────────────────────────────────────────────

  private async executePipedCommand(command: string): Promise<string> {
    const segments = command.split('|').map(s => s.trim());
    let output = await this.executeCommand(segments[0]);

    for (let i = 1; i < segments.length; i++) {
      const filter = segments[i].trim();
      const filterParts = filter.split(/\s+/);
      const filterCmd = filterParts[0].toLowerCase();

      if (filterCmd === 'findstr') {
        const pattern = filterParts.slice(1).join(' ').replace(/"/g, '');
        const lines = output.split('\n');
        output = lines.filter(l => l.toLowerCase().includes(pattern.toLowerCase())).join('\n');
      } else if (filterCmd === 'grep') {
        const pattern = filterParts[filterParts.length - 1];
        const lines = output.split('\n');
        output = lines.filter(l => l.includes(pattern)).join('\n');
      } else if (filterCmd === 'find') {
        // Windows FIND command: find "string"
        const quoteMatch = filter.match(/find\s+"([^"]+)"/i);
        if (quoteMatch) {
          const pattern = quoteMatch[1];
          const lines = output.split('\n');
          output = lines.filter(l => l.includes(pattern)).join('\n');
        }
      } else if (filterCmd === 'more') {
        // More just passes through in simulation
      }
    }

    return output;
  }

  // ─── Build context for modular commands ───────────────────────

  private buildContext(): WinCommandContext {
    return {
      hostname: this.hostname,
      ports: this.ports,
      defaultGateway: this.defaultGateway?.toString() || null,
      arpTable: this.arpTable,

      configureInterface: (ifName: string, ip: IPAddress, mask: SubnetMask) =>
        this.configureInterface(ifName, ip, mask),
      setDefaultGateway: (gw: IPAddress) => this.setDefaultGateway(gw),
      clearDefaultGateway: () => this.clearDefaultGateway(),
      addStaticRoute: (network: IPAddress, mask: SubnetMask, nextHop: IPAddress, metric: number) =>
        this.addStaticRoute(network, mask, nextHop, metric),
      removeRoute: (dest: IPAddress, mask: SubnetMask) => this.removeRoute(dest, mask),
      getRoutingTable: () => this.getRoutingTable() as RouteEntry[],

      isDHCPConfigured: (ifName: string) => this.isDHCPConfigured(ifName),
      getDHCPState: (ifName: string) => this.dhcpClient.getState(ifName),
      releaseLease: (ifName: string) => this.dhcpClient.releaseLease(ifName),
      requestLease: (ifName: string, opts: any) => this.dhcpClient.requestLease(ifName, opts),
      autoDiscoverDHCPServers: () => this.autoDiscoverDHCPServers(),

      addDHCPEvent: (type: string, message: string) => this.addDHCPEvent(type, message),
      syncDHCPEvents: () => this.syncDHCPEvents(),
      getDHCPEventLog: () => this.dhcpEventLog,

      executePingSequence: (target: IPAddress, count: number, timeout?: number, ttl?: number) =>
        this.executePingSequence(target, count, timeout, ttl),
      executeTraceroute: (target: IPAddress) =>
        this.executeTraceroute(target) as Promise<TracerouteHop[]>,

      resetStack: () => {
        for (const [name, port] of this.ports) {
          port.clearIP();
          this.dhcpClient.releaseLease(name);
        }
        this.defaultGateway = null;
        this.routingTable = [];
        this.arpTable.clear();
      },
    };
  }

  // ─── DHCP Event Log ─────────────────────────────────────────────

  private syncDHCPEvents(): void {
    for (const [name] of this.ports) {
      const logs = this.dhcpClient.getLogs(name);
      if (!logs) continue;
      const logLines = logs.split('\n').filter(Boolean);
      for (const line of logLines) {
        const eventKey = `${name}:${line}`;
        if (!this.trackedEvents.has(eventKey)) {
          this.trackedEvents.add(eventKey);
          let type = 'INFO';
          if (line.includes('DHCPDISCOVER')) type = 'DISCOVER';
          else if (line.includes('DHCPOFFER')) type = 'OFFER';
          else if (line.includes('DHCPREQUEST')) type = 'REQUEST';
          else if (line.includes('DHCPACK')) type = 'ACK';
          else if (line.includes('DHCPNAK')) type = 'NAK';
          else if (line.includes('released')) type = 'RELEASE';
          else if (line.includes('RENEWING')) type = 'RENEW';
          else if (line.includes('INIT')) type = 'INIT';
          else if (line.includes('bound')) type = 'ACK';
          this.addDHCPEvent(type, `${line} on ${name}`);
        }
      }
    }
  }

  private addDHCPEvent(type: string, message: string): void {
    const timestamp = new Date().toISOString();
    this.dhcpEventLog.push(`[${timestamp}] DHCP ${type}: ${message}`);
  }

  // ─── ifconfig (compatibility) ──────────────────────────────────

  private cmdIfconfig(args: string[]): string {
    if (args.length < 2) return 'Usage: ifconfig <interface> <ip> [netmask <mask>]';
    if (!this.ports.has(args[0])) return `ifconfig: interface ${args[0]} not found`;

    let maskStr = '255.255.255.0';
    const nmIdx = args.indexOf('netmask');
    if (nmIdx !== -1 && args[nmIdx + 1]) maskStr = args[nmIdx + 1];

    try {
      this.configureInterface(args[0], new IPAddress(args[1]), new SubnetMask(maskStr));
      return '';
    } catch (e: any) {
      return `ifconfig: ${e.message}`;
    }
  }

  // ─── systeminfo ────────────────────────────────────────────────

  private cmdSysteminfo(): string {
    const lines: string[] = [];
    lines.push(`Host Name:                 ${this.hostname}`);
    lines.push(`OS Name:                   Microsoft Windows 10 Pro`);
    lines.push(`OS Version:                10.0.22631 N/A Build 22631`);
    lines.push(`OS Manufacturer:           Microsoft Corporation`);
    lines.push(`OS Configuration:          Member Workstation`);
    lines.push(`OS Build Type:             Multiprocessor Free`);
    lines.push(`System Type:               x64-based PC`);
    lines.push(`Network Card(s):           ${this.ports.size} NIC(s) Installed.`);
    let idx = 1;
    for (const [name, port] of this.ports) {
      const displayName = name.replace(/^eth/, 'Ethernet ');
      lines.push(`                           [${String(idx).padStart(2, '0')}]: Intel(R) Ethernet Connection`);
      const ip = port.getIPAddress();
      if (ip) {
        lines.push(`                                 Connection Name: ${displayName}`);
        lines.push(`                                 DHCP Enabled:    ${this.isDHCPConfigured(name) ? 'Yes' : 'No'}`);
        lines.push(`                                 IP address(es)`);
        lines.push(`                                 [01]: ${ip}`);
      } else {
        lines.push(`                                 Connection Name: ${displayName}`);
        lines.push(`                                 Status:          Media disconnected`);
      }
      idx++;
    }
    return lines.join('\n');
  }

  // ─── OS Info ───────────────────────────────────────────────────

  getOSType(): string { return 'windows'; }
}
