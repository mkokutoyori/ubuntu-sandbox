/**
 * WindowsPC - Windows workstation/server with terminal
 *
 * Extends EndHost (which provides the full L2/L3 network stack).
 * This class only implements Windows-specific terminal commands and
 * output formatting.
 *
 * Supported commands:
 *   ipconfig [/all] [/release] [/renew] [/flushdns]       — IP configuration
 *   netsh interface ip set address "name" static ...       — configure IP
 *   netsh int ip reset                                     — TCP/IP reset
 *   ping [-n count] <destination>                          — ICMP echo
 *   arp -a                                                 — show ARP table
 *   tracert <destination>                                  — trace route
 *   route print                                            — show routing table
 *   route add <dest> mask <mask> <gw> [metric <n>]         — add route
 *   route delete <dest>                                    — remove route
 *   wevtutil qe System /q:"*[System[Provider[@Name=...]]"  — Event Log
 */

import { EndHost, PingResult } from './EndHost';
import { Port } from '../hardware/Port';
import { IPAddress, SubnetMask, DeviceType } from '../core/types';

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

    // Handle piped commands
    if (trimmed.includes('|')) {
      return this.executePipedCommand(trimmed);
    }

    const parts = trimmed.split(/\s+/);
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
      case 'wevtutil': return this.cmdWevtutil(parts.slice(1));
      default: return `'${cmd}' is not recognized as an internal or external command.`;
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
      }
    }

    return output;
  }

  // ─── ipconfig ──────────────────────────────────────────────────

  private cmdIpconfig(args: string[]): string {
    const lower = args.map(a => a.toLowerCase());

    // ipconfig /release [<adapter>]
    if (lower.includes('/release')) {
      return this.ipconfigRelease(args);
    }

    // ipconfig /renew [<adapter>]
    if (lower.includes('/renew')) {
      return this.ipconfigRenew(args);
    }

    // ipconfig /flushdns
    if (lower.includes('/flushdns')) {
      return 'Windows IP Configuration\n\nSuccessfully flushed the DNS Resolver Cache.';
    }

    // ipconfig /all
    if (lower.includes('/all')) {
      return this.ipconfigAll();
    }

    // ipconfig (basic)
    return this.ipconfigBasic();
  }

  private ipconfigBasic(): string {
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

  private ipconfigAll(): string {
    const lines: string[] = [
      'Windows IP Configuration',
      '',
      `   Host Name . . . . . . . . . . . . : ${this.hostname}`,
      `   Primary Dns Suffix  . . . . . . . :`,
      `   Node Type . . . . . . . . . . . . : Hybrid`,
      `   IP Routing Enabled. . . . . . . . : No`,
      `   WINS Proxy Enabled. . . . . . . . : No`,
      '',
    ];

    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      const mac = port.getMAC().toString().replace(/:/g, '-').toUpperCase();
      const displayName = port.getName().replace(/^eth/, 'Ethernet ');
      const isDHCP = this.isDHCPConfigured(port.getName());

      lines.push(`Ethernet adapter ${displayName}:`);
      lines.push('');
      lines.push(`   Connection-specific DNS Suffix  . :`);
      lines.push(`   Description . . . . . . . . . . . : Intel(R) Ethernet Connection`);
      lines.push(`   Physical Address. . . . . . . . . : ${mac}`);
      lines.push(`   DHCP Enabled. . . . . . . . . . . : ${isDHCP ? 'Yes' : 'No'}`);

      if (ip) {
        lines.push(`   Autoconfiguration Enabled . . . . : Yes`);
        lines.push(`   IPv4 Address. . . . . . . . . . . : ${ip}(Preferred)`);
        lines.push(`   Subnet Mask . . . . . . . . . . . : ${mask || '255.255.255.0'}`);

        if (isDHCP) {
          const dhcpState = this.dhcpClient.getState(port.getName());
          if (dhcpState.lease) {
            const lease = dhcpState.lease;
            lines.push(`   Lease Obtained. . . . . . . . . . : ${new Date(lease.leaseStart).toLocaleString()}`);
            lines.push(`   Lease Expires . . . . . . . . . . : ${new Date(lease.expiration).toLocaleString()}`);
          }
        }

        lines.push(`   Default Gateway . . . . . . . . . : ${this.defaultGateway || ''}`);

        if (isDHCP) {
          const dhcpState = this.dhcpClient.getState(port.getName());
          if (dhcpState.lease) {
            lines.push(`   DHCP Server . . . . . . . . . . . : ${dhcpState.lease.serverIdentifier}`);
            if (dhcpState.lease.dnsServers.length > 0) {
              lines.push(`   DNS Servers . . . . . . . . . . . : ${dhcpState.lease.dnsServers.join(', ')}`);
            }
          }
        }
      } else {
        lines.push(`   Media State . . . . . . . . . . . : Media disconnected`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  private ipconfigRelease(args: string[]): string {
    const lines: string[] = ['Windows IP Configuration', ''];

    // Parse adapter name: ipconfig /release "Ethernet 0" or ipconfig /release Ethernet*
    const adapterFilter = this.parseAdapterArg(args, '/release');

    let released = false;
    for (const [name, port] of this.ports) {
      const displayName = port.getName().replace(/^eth/, 'Ethernet ');

      // If adapter specified, only release matching ones
      if (adapterFilter && !this.matchesAdapter(displayName, name, adapterFilter)) continue;

      const state = this.dhcpClient.getState(name);
      if (state.lease) {
        const oldIP = state.lease.ipAddress;
        this.dhcpClient.releaseLease(name);
        this.addDHCPEvent('RELEASE', `Released IP ${oldIP} on ${name}`);
        released = true;
      }
      state.state = 'INIT';
    }

    if (adapterFilter && !released) {
      lines.push(`No adapter matched "${adapterFilter}".`);
      return lines.join('\n');
    }

    lines.push(adapterFilter
      ? `Adapter "${adapterFilter}" has been successfully released.`
      : 'All adapters have been successfully released.');
    lines.push('');

    // Re-show ipconfig
    for (const [name, port] of this.ports) {
      const displayName = port.getName().replace(/^eth/, 'Ethernet ');
      if (adapterFilter && !this.matchesAdapter(displayName, name, adapterFilter)) continue;

      lines.push(`Ethernet adapter ${displayName}:`);
      lines.push(`   Connection-specific DNS Suffix  . :`);
      const ip = port.getIPAddress();
      if (ip) {
        lines.push(`   IPv4 Address. . . . . . . . . . . : ${ip}`);
        lines.push(`   Subnet Mask . . . . . . . . . . . : ${port.getSubnetMask() || '255.255.255.0'}`);
        lines.push(`   Default Gateway . . . . . . . . . : ${this.defaultGateway || ''}`);
      } else {
        lines.push(`   Media State . . . . . . . . . . . : Media disconnected`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Parse adapter name argument after a switch like /release or /renew.
   * Handles quoted names: ipconfig /release "Ethernet 0"
   * Handles wildcard: ipconfig /release Ethernet*
   */
  private parseAdapterArg(args: string[], switchName: string): string | null {
    const switchIdx = args.findIndex(a => a.toLowerCase() === switchName.toLowerCase());
    if (switchIdx === -1) return null;

    // Remaining args after the switch
    const remaining = args.slice(switchIdx + 1).filter(a => !a.startsWith('/'));
    if (remaining.length === 0) return null;

    // Join and strip quotes
    return remaining.join(' ').replace(/^["']|["']$/g, '');
  }

  /**
   * Check if adapter display name or port name matches a filter (supports * wildcard).
   */
  private matchesAdapter(displayName: string, portName: string, filter: string): boolean {
    const pattern = filter.replace(/\*/g, '.*');
    const regex = new RegExp(`^${pattern}$`, 'i');
    return regex.test(displayName) || regex.test(portName);
  }

  private ipconfigRenew(args: string[]): string {
    // Auto-discover DHCP servers through network topology
    this.autoDiscoverDHCPServers();

    const lines: string[] = ['Windows IP Configuration', ''];

    // Only renew the primary interface (eth0)
    const primaryIface = 'eth0';
    const displayName = primaryIface.replace(/^eth/, 'Ethernet ');
    lines.push(`Ethernet adapter ${displayName}:`);
    lines.push(`   DHCP Discover - Broadcast on ${primaryIface}`);

    this.dhcpClient.requestLease(primaryIface, { verbose: false });
    const state = this.dhcpClient.getState(primaryIface);

    if (state.lease) {
      this.addDHCPEvent('RENEW', `Renewed IP ${state.lease.ipAddress} on ${primaryIface}`);
      lines.push(`   DHCP Offer received from ${state.lease.serverIdentifier}`);
      lines.push(`   DHCP Request - Broadcast`);
      lines.push(`   DHCP ACK received`);
    }
    lines.push('');

    // Re-show ipconfig
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

  // ─── wevtutil (Windows Event Log) ──────────────────────────────

  private cmdWevtutil(args: string[]): string {
    // wevtutil qe System /q:"*[System[Provider[@Name='Microsoft-Windows-Dhcp-Client']]]" /f:text /c:10
    const joined = args.join(' ');

    if (joined.toLowerCase().includes('dhcp-client') || joined.toLowerCase().includes('dhcp')) {
      // Parse /c:N for count
      const countMatch = joined.match(/\/c:(\d+)/);
      const maxCount = countMatch ? parseInt(countMatch[1], 10) : 10;

      // Build real DHCP events from actual client state
      this.syncDHCPEvents();

      // If no real events, add service initialization event
      if (this.dhcpEventLog.length === 0) {
        this.addDHCPEvent('INIT', 'Dhcp-Client service initialized');
      }

      const events = this.dhcpEventLog.slice(-maxCount);
      const eventIDs: Record<string, number> = {
        'INIT': 1000, 'DISCOVER': 1001, 'OFFER': 1002,
        'REQUEST': 1003, 'ACK': 1004, 'RELEASE': 1005,
        'NAK': 1006, 'RENEW': 1007, 'RESET': 1008,
      };

      const lines: string[] = [];
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        // Extract type from "[timestamp] DHCP TYPE: message"
        const typeMatch = event.match(/DHCP (\w+):/);
        const type = typeMatch ? typeMatch[1] : 'INFO';
        const eventId = eventIDs[type] || 1000;
        const dateMatch = event.match(/^\[([^\]]+)\]/);
        const date = dateMatch ? dateMatch[1] : new Date().toISOString();

        lines.push(`Event[${i}]:`);
        lines.push(`  Log Name: System`);
        lines.push(`  Source: Microsoft-Windows-Dhcp-Client`);
        lines.push(`  Date: ${date}`);
        lines.push(`  Event ID: ${eventId}`);
        lines.push(`  Description: ${event.replace(/^\[[^\]]+\]\s*/, '')}`);
        lines.push('');
      }
      return lines.join('\n');
    }

    return 'Usage: wevtutil qe <log> [/q:<query>] [/f:text] [/c:<count>]';
  }

  /**
   * Sync DHCP event log from actual DHCPClient state and logs.
   * Reads real client state transitions instead of relying on static data.
   */
  private syncDHCPEvents(): void {
    for (const [name] of this.ports) {
      const logs = this.dhcpClient.getLogs(name);
      if (!logs) continue;
      const logLines = logs.split('\n').filter(Boolean);
      for (const line of logLines) {
        // Avoid duplicate entries
        const eventKey = `${name}:${line}`;
        if (!this.trackedEvents.has(eventKey)) {
          this.trackedEvents.add(eventKey);
          // Map DHCPClient log entries to Windows event types
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

  // ─── netsh ─────────────────────────────────────────────────────

  private cmdNetsh(args: string[]): string {
    const joined = args.join(' ');
    const joinedLower = joined.toLowerCase();

    // netsh winsock reset
    if (joinedLower.match(/winsock\s+reset/)) {
      this.addDHCPEvent('RESET', 'Winsock catalog has been reset');
      return [
        '',
        'Winsock Catalog successfully reset.',
        'You must restart the computer in order to complete the reset.',
      ].join('\n');
    }

    // netsh int ip reset / netsh interface ip reset
    if (joinedLower.match(/int(?:erface)?\s+ip\s+reset/i)) {
      // Reset TCP/IP stack
      for (const [name, port] of this.ports) {
        port.clearIP();
        this.dhcpClient.releaseLease(name);
      }
      this.defaultGateway = null;
      this.routingTable = [];
      this.arpTable.clear();
      this.addDHCPEvent('RESET', 'TCP/IP stack has been reset');
      return [
        'Resetting Interface, OK!',
        'Restart the computer to complete this action.',
      ].join('\n');
    }

    // netsh interface ip set address "name with spaces" static <ip> <mask> [gateway]
    // Parse with proper quoted string support
    const match = joined.match(
      /interface\s+ip\s+set\s+address\s+"([^"]+)"\s+static\s+([\d.]+)\s+([\d.]+)(?:\s+([\d.]+))?/i
    ) || joined.match(
      /interface\s+ip\s+set\s+address\s+(\S+)\s+static\s+([\d.]+)\s+([\d.]+)(?:\s+([\d.]+))?/i
    );
    if (!match) return 'Usage: netsh interface ip set address "name" static <ip> <mask> [gateway]';

    const ifName = match[1].trim();
    const portName = this.resolveAdapterName(ifName);
    const port = this.ports.get(portName);
    if (!port) return `The interface "${ifName}" was not found.`;

    try {
      this.configureInterface(portName, new IPAddress(match[2]), new SubnetMask(match[3]));
      if (match[4]) {
        this.setDefaultGateway(new IPAddress(match[4]));
      }
      return 'Ok.';
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }

  /**
   * Resolve adapter display name (with spaces) to internal port name.
   * "Ethernet 0" → "eth0", "Ethernet 1" → "eth1", "eth0" → "eth0"
   */
  private resolveAdapterName(name: string): string {
    // Direct match
    if (this.ports.has(name)) return name;
    // "Ethernet X" → "ethX"
    const ethMatch = name.match(/^Ethernet\s*(\d+)$/i);
    if (ethMatch) return `eth${ethMatch[1]}`;
    // Try replacing spaces
    return name.replace(/^Ethernet\s*/i, 'eth');
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

  // ─── route ─────────────────────────────────────────────────────

  private cmdRoute(args: string[]): string {
    if (args.length === 0 || args[0].toLowerCase() === 'print') {
      return this.showRoutePrint();
    }

    if (args[0].toLowerCase() === 'add' && args.length >= 2) {
      return this.routeAdd(args.slice(1));
    }

    if (args[0].toLowerCase() === 'delete' && args.length >= 2) {
      return this.routeDelete(args.slice(1));
    }

    return 'Usage: route { print | add <dest> mask <mask> <gateway> [metric <n>] | delete <dest> }';
  }

  private routeAdd(args: string[]): string {
    if (args[0] === 'default' && args[1]) {
      try {
        this.setDefaultGateway(new IPAddress(args[1]));
        return ' OK!';
      } catch (e: any) {
        return `The route addition failed: ${e.message}`;
      }
    }

    const maskIdx = args.findIndex(a => a.toLowerCase() === 'mask');
    if (maskIdx === -1 || maskIdx + 2 >= args.length) {
      return 'Usage: route add <dest> mask <mask> <gateway> [metric <n>]';
    }

    try {
      const destStr = args[maskIdx - 1] || args[0];
      const maskStr = args[maskIdx + 1];
      const gwStr = args[maskIdx + 2];

      const dest = new IPAddress(destStr);
      const mask = new SubnetMask(maskStr);
      const gw = new IPAddress(gwStr);

      let metric = 1;
      const metricIdx = args.findIndex(a => a.toLowerCase() === 'metric');
      if (metricIdx !== -1 && args[metricIdx + 1]) {
        metric = parseInt(args[metricIdx + 1], 10);
      }

      if (destStr === '0.0.0.0' && maskStr === '0.0.0.0') {
        this.setDefaultGateway(gw);
        return ' OK!';
      }

      if (!this.addStaticRoute(dest, mask, gw, metric)) {
        return 'The route addition failed: the gateway is not reachable.';
      }
      return ' OK!';
    } catch (e: any) {
      return `The route addition failed: ${e.message}`;
    }
  }

  private routeDelete(args: string[]): string {
    if (args[0] === 'default' || args[0] === '0.0.0.0') {
      this.clearDefaultGateway();
      return ' OK!';
    }

    try {
      const dest = new IPAddress(args[0]);
      let mask = new SubnetMask('255.255.255.0');
      const maskIdx = args.findIndex(a => a.toLowerCase() === 'mask');
      if (maskIdx !== -1 && args[maskIdx + 1]) {
        mask = new SubnetMask(args[maskIdx + 1]);
      }

      if (!this.removeRoute(dest, mask)) {
        return 'The route deletion failed: Element not found.';
      }
      return ' OK!';
    } catch (e: any) {
      return `The route deletion failed: ${e.message}`;
    }
  }

  private showRoutePrint(): string {
    const table = this.getRoutingTable();
    const lines = [
      '===========================================================================',
      'Active Routes:',
      'Network Destination        Netmask          Gateway         Interface  Metric',
    ];

    for (const route of table) {
      const dest = route.network.toString().padEnd(24);
      const mask = route.mask.toString().padEnd(16);
      const gw = route.nextHop ? route.nextHop.toString().padEnd(15) : 'On-link        ';
      const port = this.ports.get(route.iface);
      const iface = port?.getIPAddress()?.toString().padEnd(14) || route.iface.padEnd(14);
      lines.push(`  ${dest} ${mask} ${gw} ${iface} ${route.metric}`);
    }

    lines.push('===========================================================================');
    return lines.join('\n');
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
