/**
 * WindowsPC - Windows workstation with cmd.exe terminal
 *
 * Extends EndHost (which provides the full L2/L3 network stack).
 * Delegates command execution to modular handlers under windows/.
 *
 * Architecture follows linux/LinuxPC.ts pattern:
 *   - WindowsFileSystem (VFS) in windows/WindowsFileSystem.ts
 *   - Network commands in Win*.ts modules (WinIpconfig, WinNetsh, etc.)
 *   - File commands in WinFileCommands.ts + WinDir.ts
 *   - WindowsPC orchestrates both via context objects
 */

import { EndHost, PingResult } from './EndHost';
import { Port } from '../hardware/Port';
import { IPAddress, SubnetMask, DeviceType } from '../core/types';
import type { WinCommandContext, RouteEntry, TracerouteHop } from './windows/WinCommandExecutor';
import type { WinFileCommandContext } from './windows/WinFileCommands';
import { WindowsFileSystem } from './windows/WindowsFileSystem';
import { cmdHelp } from './windows/WinHelp';
import { cmdIpconfig } from './windows/WinIpconfig';
import { cmdNetsh } from './windows/WinNetsh';
import { cmdPing } from './windows/WinPing';
import { cmdArp } from './windows/WinArp';
import { cmdTracert } from './windows/WinTracert';
import { cmdRoute } from './windows/WinRoute';
import { cmdWevtutil } from './windows/WinWevtutil';
import { cmdDir } from './windows/WinDir';
import {
  cmdCd, cmdMkdir, cmdRmdir, cmdType, cmdCopy, cmdMove,
  cmdRen, cmdDel, cmdTree, cmdSet, cmdTasklist, cmdNetstat,
} from './windows/WinFileCommands';

export class WindowsPC extends EndHost {
  protected readonly defaultTTL = 128;
  /** DHCP event log for Windows Event Viewer */
  private dhcpEventLog: string[] = [];
  /** Track synced DHCP events to avoid duplicates */
  private trackedEvents: Set<string> = new Set();
  /** Virtual file system */
  private fs: WindowsFileSystem;
  /** Current working directory */
  private cwd: string = 'C:\\Users\\User';
  /** Environment variables */
  private env: Map<string, string> = new Map();
  /** Per-interface DNS configuration: portName → { servers, mode } */
  private dnsConfig: Map<string, { servers: string[]; mode: 'static' | 'dhcp' }> = new Map();
  /** DHCP client trace flag */
  private dhcpTraceEnabled: boolean = false;
  /** Primary DNS suffix (set via netsh dnsclient set global) */
  private dnsSuffix: string = '';

  constructor(type: DeviceType = 'windows-pc', name: string = 'WindowsPC', x: number = 0, y: number = 0) {
    super(type, name, x, y);
    this.createPorts();
    this.fs = new WindowsFileSystem(name);
    this.initEnv();
  }

  private createPorts(): void {
    for (let i = 0; i < 4; i++) {
      this.addPort(new Port(`eth${i}`, 'ethernet'));
    }
  }

  private initEnv(): void {
    this.env.set('USERNAME', 'User');
    this.env.set('COMPUTERNAME', this.hostname);
    this.env.set('HOMEDRIVE', 'C:');
    this.env.set('HOMEPATH', '\\Users\\User');
    this.env.set('USERPROFILE', 'C:\\Users\\User');
    this.env.set('WINDIR', 'C:\\Windows');
    this.env.set('SYSTEMROOT', 'C:\\Windows');
    this.env.set('SYSTEMDRIVE', 'C:');
    this.env.set('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
    this.env.set('PATH', 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem');
    this.env.set('PATHEXT', '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSH;.MSC');
    this.env.set('TEMP', 'C:\\Users\\User\\AppData\\Local\\Temp');
    this.env.set('TMP', 'C:\\Users\\User\\AppData\\Local\\Temp');
    this.env.set('OS', 'Windows_NT');
    this.env.set('PROCESSOR_ARCHITECTURE', 'AMD64');
    this.env.set('NUMBER_OF_PROCESSORS', '4');
  }

  // ─── Terminal ──────────────────────────────────────────────────

  async executeCommand(command: string): Promise<string> {
    if (!this.isPoweredOn) return 'Device is powered off';

    const trimmed = command.trim();
    if (!trimmed) return '';

    // Handle piped commands (but not inside redirects)
    if (trimmed.includes('|') && !trimmed.match(/[>]/)) {
      return this.executePipedCommand(trimmed);
    }

    // Handle echo with redirect: echo text > file / echo text >> file
    const redirectMatch = trimmed.match(/^(.+?)\s*(>>|>)\s*(.+)$/);
    if (redirectMatch) {
      return this.handleRedirect(redirectMatch[1].trim(), redirectMatch[2], redirectMatch[3].trim());
    }

    // Expand environment variables
    const expanded = this.expandEnvVars(trimmed);
    const parts = this.parseCommandLine(expanded);
    if (parts.length === 0) return '';

    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    // File commands (use file context)
    const fileCtx = this.buildFileContext();
    switch (cmd) {
      case 'cd':
      case 'chdir':   return cmdCd(fileCtx, args);
      case 'dir':     return cmdDir(fileCtx, args);
      case 'mkdir':
      case 'md':      return cmdMkdir(fileCtx, args);
      case 'rmdir':
      case 'rd':      return cmdRmdir(fileCtx, args);
      case 'type':    return cmdType(fileCtx, args);
      case 'copy':    return cmdCopy(fileCtx, args);
      case 'move':    return cmdMove(fileCtx, args);
      case 'ren':
      case 'rename':  return cmdRen(fileCtx, args);
      case 'del':
      case 'erase':   return cmdDel(fileCtx, args);
      case 'tree':    return cmdTree(fileCtx, args);
      case 'set':     return cmdSet(fileCtx, args);
      case 'tasklist': return cmdTasklist(fileCtx);
      case 'netstat': return cmdNetstat(fileCtx);
      case 'echo':    return args.join(' ');
      case 'cls':     return '';
      case 'ver':     return '\nMicrosoft Windows [Version 10.0.22631.6649]';
      case 'hostname': return this.hostname;
      case 'systeminfo': return this.cmdSysteminfo();
    }

    // Network commands (use network context)
    const netCtx = this.buildNetContext();
    switch (cmd) {
      case 'help':     return cmdHelp(args);
      case 'ipconfig': return cmdIpconfig(netCtx, args);
      case 'netsh':    return cmdNetsh(netCtx, args);
      case 'ifconfig': return this.cmdIfconfig(args);
      case 'ping':     return cmdPing(netCtx, args);
      case 'arp':      return cmdArp(netCtx, args);
      case 'tracert':
      case 'traceroute': return cmdTracert(netCtx, args);
      case 'route':    return cmdRoute(netCtx, args);
      case 'wevtutil': return cmdWevtutil(netCtx, args);
      default:
        return `'${cmd}' is not recognized as an internal or external command,\noperable program or batch file.`;
    }
  }

  // ─── Command Parsing ──────────────────────────────────────────────

  private parseCommandLine(line: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === ' ' && !inQuote) {
        if (current) { parts.push(current); current = ''; }
      } else {
        current += ch;
      }
    }
    if (current) parts.push(current);
    return parts;
  }

  private expandEnvVars(text: string): string {
    return text.replace(/%([^%]+)%/g, (match, varName) => {
      const upper = varName.toUpperCase();
      if (upper === 'CD') return this.cwd;
      return this.env.get(upper) ?? match;
    });
  }

  // ─── Redirect Handling ────────────────────────────────────────────

  private handleRedirect(cmdPart: string, op: string, filePath: string): string {
    // Execute the command part to get its output
    const expanded = this.expandEnvVars(cmdPart);
    const parts = this.parseCommandLine(expanded);
    if (parts.length === 0) return '';

    const cmd = parts[0].toLowerCase();
    let content: string;
    if (cmd === 'echo') {
      content = parts.slice(1).join(' ');
    } else {
      // For other commands, we'd need async, but echo is the main use case
      content = parts.slice(1).join(' ');
    }

    const absPath = this.fs.normalizePath(filePath, this.cwd);
    if (op === '>>') {
      this.fs.appendFile(absPath, content + '\n');
    } else {
      this.fs.createFile(absPath, content + '\n');
    }
    return '';
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
        const quoteMatch = filter.match(/find\s+"([^"]+)"/i);
        if (quoteMatch) {
          const pattern = quoteMatch[1];
          const lines = output.split('\n');
          output = lines.filter(l => l.includes(pattern)).join('\n');
        }
      } else if (filterCmd === 'more') {
        // Passthrough in simulation
      }
    }

    return output;
  }

  // ─── Tab Completion ──────────────────────────────────────────────

  getCompletions(partial: string): string[] {
    const parts = partial.trimStart().split(/\s+/);

    if (parts.length <= 1) {
      // Command completion
      const prefix = (parts[0] || '').toLowerCase();
      const commands = [
        'help', 'ipconfig', 'netsh', 'ping', 'arp', 'tracert', 'route',
        'wevtutil', 'hostname', 'ver', 'cls', 'systeminfo', 'tasklist',
        'netstat', 'dir', 'cd', 'mkdir', 'md', 'rmdir', 'rd', 'type',
        'copy', 'move', 'ren', 'rename', 'del', 'erase', 'echo', 'set',
        'tree',
      ];
      return commands.filter(c => c.startsWith(prefix)).sort();
    }

    // File/directory completion for the last argument
    const lastArg = parts[parts.length - 1];
    // Split on last backslash to get directory and partial name
    const lastSep = lastArg.lastIndexOf('\\');
    let dir: string;
    let partialName: string;
    if (lastSep >= 0) {
      const dirPart = lastArg.substring(0, lastSep) || '\\';
      dir = this.fs.normalizePath(dirPart, this.cwd);
      partialName = lastArg.substring(lastSep + 1);
    } else {
      dir = this.cwd;
      partialName = lastArg;
    }

    return this.fs.getCompletions(dir, partialName);
  }

  // ─── Build Contexts ──────────────────────────────────────────────

  private buildFileContext(): WinFileCommandContext {
    return {
      fs: this.fs,
      cwd: this.cwd,
      hostname: this.hostname,
      env: this.env,
      setCwd: (path: string) => { this.cwd = path; },
    };
  }

  private buildNetContext(): WinCommandContext {
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
        this.dnsConfig.clear();
        this.dnsSuffix = '';
      },

      // DNS management
      getDnsServers: (ifName: string) => {
        const cfg = this.dnsConfig.get(ifName);
        return cfg ? [...cfg.servers] : [];
      },
      setDnsServers: (ifName: string, servers: string[]) => {
        this.dnsConfig.set(ifName, { servers: [...servers], mode: 'static' });
      },
      getDnsMode: (ifName: string) => {
        return this.dnsConfig.get(ifName)?.mode ?? 'dhcp';
      },
      setDnsMode: (ifName: string, mode: 'static' | 'dhcp') => {
        if (mode === 'dhcp') {
          this.dnsConfig.set(ifName, { servers: [], mode: 'dhcp' });
        } else {
          const cfg = this.dnsConfig.get(ifName);
          if (cfg) cfg.mode = 'static';
          else this.dnsConfig.set(ifName, { servers: [], mode: 'static' });
        }
      },

      // Interface admin state
      setInterfaceAdmin: (ifName: string, enabled: boolean) => {
        const port = this.ports.get(ifName);
        if (port) port.setUp(enabled);
      },
      getInterfaceAdmin: (ifName: string) => {
        const port = this.ports.get(ifName);
        return port ? port.getIsUp() : false;
      },

      // IP address removal
      clearInterfaceIP: (ifName: string) => {
        const port = this.ports.get(ifName);
        if (port) port.clearIP();
      },

      // Switch interface to DHCP address mode
      setAddressDhcp: (ifName: string) => {
        const port = this.ports.get(ifName);
        if (port) port.clearIP();
        this.dhcpInterfaces.add(ifName);
      },

      // DHCP tracing
      getDhcpTraceEnabled: () => this.dhcpTraceEnabled,
      setDhcpTraceEnabled: (enabled: boolean) => { this.dhcpTraceEnabled = enabled; },

      // DNS suffix
      getDnsSuffix: () => this.dnsSuffix,
      setDnsSuffix: (suffix: string) => { this.dnsSuffix = suffix; },
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
