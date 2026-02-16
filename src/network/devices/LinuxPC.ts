/**
 * LinuxPC - Linux workstation with terminal
 *
 * Extends EndHost (which provides the full L2/L3 network stack).
 * Uses LinuxCommandExecutor for filesystem, user management, and utility commands.
 * Networking commands (ifconfig, ip, ping, arp, dhclient, traceroute) are handled
 * directly since they need access to EndHost internals.
 */

import { EndHost, PingResult, HostRouteEntry } from './EndHost';
import { Port } from '../hardware/Port';
import { IPAddress, SubnetMask, DeviceType } from '../core/types';
import { LinuxCommandExecutor } from './linux/LinuxCommandExecutor';

export class LinuxPC extends EndHost {
  protected readonly defaultTTL = 64;
  private executor: LinuxCommandExecutor;

  constructor(type: DeviceType = 'linux-pc', name: string = 'LinuxPC', x: number = 0, y: number = 0) {
    super(type, name, x, y);
    this.createPorts();
    this.executor = new LinuxCommandExecutor(false); // non-root user
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

    // Check if any part of the command involves networking
    const hasNetworkCmd = this.containsNetworkCommand(trimmed);

    if (hasNetworkCmd) {
      // Handle compound commands with ; so each sub-command routes correctly
      if (trimmed.includes(';')) {
        const cmds = trimmed.split(';').map(c => c.trim()).filter(Boolean);
        const outputs: string[] = [];
        for (const c of cmds) {
          const out = await this.executeCommand(c);
          if (out) outputs.push(out);
        }
        return outputs.join('\n');
      }

      // Handle piped commands with single | (not ||)
      if (/\|(?!\|)/.test(trimmed)) {
        return this.executePipedCommand(trimmed);
      }

      // Try networking commands directly
      const networkResult = await this.tryNetworkCommand(trimmed);
      if (networkResult !== null) return networkResult;
    }

    // Delegate everything else to Linux command executor
    // (handles ||, &&, ;, pipes, redirections, scripts, etc.)
    return this.executor.execute(trimmed);
  }

  /**
   * Check if the command string contains any network-specific commands
   * that need EndHost internals to handle.
   */
  private containsNetworkCommand(input: string): boolean {
    const networkCmds = ['ifconfig', 'ip', 'ping', 'arp', 'traceroute', 'dhclient', 'ps'];
    // Also check for DHCP lease file paths (cat/rm of /var/lib/dhcp/)
    if (input.includes('/var/lib/dhcp/')) return true;
    const words = input.split(/[\s;|&]+/);
    return words.some(w => networkCmds.includes(w));
  }

  private async executePipedCommand(command: string): Promise<string> {
    // Split on single | (not ||)
    const segments = command.split(/\|(?!\|)/).map(s => s.trim());
    let output = await this.executeCommand(segments[0]);

    for (let i = 1; i < segments.length; i++) {
      const filter = segments[i].trim();
      const filterParts = filter.split(/\s+/);
      const filterCmd = filterParts[0];

      if (filterCmd === 'grep') {
        const invertMatch = filterParts.includes('-v');
        // Extract pattern: handle quoted strings
        const rawFilter = filter.slice(filter.indexOf('grep') + 4).trim();
        let pattern: string;
        const quoteMatch = rawFilter.match(/(?:-\w+\s+)*["']([^"']+)["']/);
        if (quoteMatch) {
          pattern = quoteMatch[1];
        } else {
          const nonFlags = filterParts.slice(1).filter(p => !p.startsWith('-'));
          pattern = nonFlags[nonFlags.length - 1] || '';
        }

        if (pattern) {
          const lines = output.split('\n');
          output = lines.filter(l => invertMatch ? !l.includes(pattern) : l.includes(pattern)).join('\n');
        }
      } else if (filterCmd === 'head' || filterCmd === 'tail') {
        // Handle head -n N and tail -n N / tail -N
        let n = 10;
        for (let j = 1; j < filterParts.length; j++) {
          if (filterParts[j] === '-n' && filterParts[j + 1]) {
            n = parseInt(filterParts[j + 1], 10); j++;
          } else if (filterParts[j].startsWith('-') && /^\d+$/.test(filterParts[j].slice(1))) {
            n = parseInt(filterParts[j].slice(1), 10);
          }
        }
        const lines = output.split('\n');
        output = (filterCmd === 'head' ? lines.slice(0, n) : lines.slice(-n)).join('\n');
      }
    }

    return output;
  }

  /**
   * Try to handle as a networking command. Returns null if not a network command.
   */
  private async tryNetworkCommand(input: string): Promise<string | null> {
    // Strip sudo for network commands
    const noSudo = input.startsWith('sudo ') ? input.slice(5).trim() : input;

    // Only check the base command (before pipes, ;, &&)
    const firstCmd = noSudo.split(/[\s|;&]/)[0];

    switch (firstCmd) {
      case 'ifconfig': {
        const parts = noSudo.split(/\s+/);
        return this.cmdIfconfig(parts.slice(1));
      }
      case 'ip': {
        const parts = noSudo.split(/\s+/);
        return this.cmdIp(parts.slice(1));
      }
      case 'ping': {
        const parts = noSudo.split(/\s+/);
        return this.cmdPing(parts.slice(1));
      }
      case 'arp': {
        const parts = noSudo.split(/\s+/);
        return this.cmdArp(parts.slice(1));
      }
      case 'traceroute': {
        const parts = noSudo.split(/\s+/);
        return this.cmdTraceroute(parts.slice(1));
      }
      case 'dhclient': {
        const parts = noSudo.split(/\s+/);
        return this.cmdDhclient(parts.slice(1));
      }
      case 'ps': {
        // Handle ps (return all DHCP-related processes)
        const parts = noSudo.split(/\s+/);
        return this.cmdPs(parts.slice(1));
      }
      case 'cat': {
        const parts = noSudo.split(/\s+/);
        const path = parts[1];
        if (!path) return null;
        // Intercept DHCP lease file reads
        const leaseMatch = path.match(/\/var\/lib\/dhcp\/dhclient\.(\w+)\.leases/);
        if (leaseMatch) {
          return this.dhcpClient.formatLeaseFile(leaseMatch[1]);
        }
        if (path === '/var/lib/dhcp/dhclient.leases') {
          const outputs: string[] = [];
          for (const [name] of this.ports) {
            const lease = this.dhcpClient.formatLeaseFile(name);
            if (lease) outputs.push(lease);
          }
          return outputs.join('\n\n');
        }
        return null; // let executor handle other cat commands
      }
      case 'rm': {
        // Silently accept removal of DHCP lease files
        if (noSudo.includes('/var/lib/dhcp/dhclient')) {
          return '';
        }
        return null;
      }
      default:
        return null;
    }
  }

  // ─── dhclient ───────────────────────────────────────────────────

  private cmdDhclient(args: string[]): string {
    let verbose = false;
    let daemon = false;
    let release = false;
    let exit = false;
    let wait = false;
    let hasTimeout = false;
    let timeout = 30;
    let specificServer: string | null = null;
    let iface = '';

    for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
        case '-v': verbose = true; break;
        case '-d': daemon = true; break;
        case '-r': release = true; break;
        case '-x': exit = true; break;
        case '-w': wait = true; break;
        case '-s':
          if (args[i + 1]) { specificServer = args[i + 1]; i++; }
          break;
        case '-t':
          hasTimeout = true;
          if (args[i + 1]) { timeout = parseInt(args[i + 1], 10); i++; }
          break;
        default:
          if (!args[i].startsWith('-')) iface = args[i];
          break;
      }
    }

    // dhclient -x: stop dhclient process and release lease
    if (exit) {
      if (iface) {
        this.dhcpClient.stopProcess(iface);
        this.dhcpClient.releaseLease(iface);
        return '';
      }
      // -x without interface: stop all
      for (const [name] of this.ports) {
        this.dhcpClient.stopProcess(name);
        this.dhcpClient.releaseLease(name);
      }
      return '';
    }

    // dhclient -r without interface: release all interfaces
    if (release && !iface) {
      const outputs: string[] = [];
      for (const [name] of this.ports) {
        const result = this.dhcpClient.releaseLease(name);
        if (result) outputs.push(result);
      }
      return outputs.join('\n');
    }

    if (!iface) return 'Usage: dhclient [-v] [-d] [-r] [-x] [-s server] [-w] [-t timeout] <interface>';
    if (!this.ports.has(iface)) return `RTNETLINK answers: No such device ${iface}`;

    if (release) {
      return this.dhcpClient.releaseLease(iface);
    }

    // Discover DHCP servers via broadcast (simulated through topology)
    this.discoverDHCPServersBroadcast(specificServer);

    const opts: { verbose?: boolean; timeout?: number; daemon?: boolean } = { verbose, daemon };
    if (hasTimeout) opts.timeout = timeout;
    if (wait) opts.timeout = opts.timeout || 60; // -w: wait indefinitely (use long timeout)
    return this.dhcpClient.requestLease(iface, opts);
  }

  /**
   * Discover DHCP servers via broadcast simulation.
   * Sends DHCPDISCOVER as broadcast (255.255.255.255 port 67) — simulated
   * by traversing connected topology (since we can't do real L2 broadcast).
   * If a specific server IP is given (-s flag), only register that server.
   */
  private discoverDHCPServersBroadcast(specificServer: string | null = null): void {
    this.autoDiscoverDHCPServers();
    // If -s flag specified, filter to only the specific server
    if (specificServer) {
      const servers = (this.dhcpClient as any).connectedServers as Array<{ server: any; serverIP: string }>;
      const filtered = servers.filter(s => s.serverIP === specificServer);
      (this.dhcpClient as any).connectedServers = filtered.length > 0 ? filtered : servers;
    }
  }

  // ─── ps ─────────────────────────────────────────────────────────

  private cmdPs(args: string[]): string {
    const lines: string[] = [];
    for (const [name] of this.ports) {
      if (this.dhcpClient.isProcessRunning(name)) {
        lines.push(`root     ${1000 + Math.floor(Math.random() * 9000)}  0.0  0.1  5432  2100 ?  Ss  00:00  0:00 dhclient ${name}`);
      }
    }
    return lines.join('\n');
  }

  // ─── ifconfig ──────────────────────────────────────────────────

  private cmdIfconfig(args: string[]): string {
    if (args.length === 0) return this.showAllInterfaces();

    const ifName = args[0];
    const port = this.ports.get(ifName);
    if (!port) return `ifconfig: interface ${ifName} not found`;

    if (args.length === 1) return this.formatInterface(port);

    const ipStr = args[1];
    let maskStr = '255.255.255.0';
    const nmIdx = args.indexOf('netmask');
    if (nmIdx !== -1 && args[nmIdx + 1]) maskStr = args[nmIdx + 1];

    try {
      this.configureInterface(ifName, new IPAddress(ipStr), new SubnetMask(maskStr));
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
    // RUNNING flag: only shown when port is UP, connected, AND has link carrier
    const isUp = port.getIsUp();
    const isConnected = port.isConnected();
    const hasCarrier = isUp && isConnected;
    const flags: string[] = [];
    if (isUp) flags.push('UP');
    flags.push('BROADCAST');
    if (hasCarrier) flags.push('RUNNING');
    flags.push('MULTICAST');
    const flagsStr = flags.join(',');
    const flagNum = hasCarrier ? 4163 : 4099;
    const counters = port.getCounters();
    return [
      `${port.getName()}: flags=${flagNum}<${flagsStr}>  mtu ${port.getMTU()}`,
      ip ? `        inet ${ip}  netmask ${mask || '255.255.255.0'}` : '        inet (not configured)',
      `        ether ${mac}`,
      `        RX packets ${counters.framesIn}  bytes ${counters.bytesIn} (${this.formatBytes(counters.bytesIn)})`,
      `        TX packets ${counters.framesOut}  bytes ${counters.bytesOut} (${this.formatBytes(counters.bytesOut)})`,
    ].join('\n');
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0.0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const val = bytes / Math.pow(1024, i);
    return `${val.toFixed(1)} ${units[i]}`;
  }

  // ─── ip (modern iproute2) ──────────────────────────────────────

  private cmdIp(args: string[]): string {
    if (args.length === 0) return 'Usage: ip { addr | route | neigh }';

    switch (args[0]) {
      case 'addr':
      case 'address':
      case 'a':
        return this.cmdIpAddr(args.slice(1));
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

  private cmdIpAddr(args: string[] = []): string {
    let filterIface: string | null = null;
    if (args.length >= 2 && args[0] === 'show') {
      filterIface = args[1];
    }

    const lines: string[] = [];
    let idx = 1;
    for (const [, port] of this.ports) {
      if (filterIface && port.getName() !== filterIface) { idx++; continue; }
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      const mac = port.getMAC();
      const state = port.isConnected() ? 'UP' : 'DOWN';
      lines.push(`${idx}: ${port.getName()}: <BROADCAST,MULTICAST,${state}> mtu 1500 state ${state}`);
      lines.push(`    link/ether ${mac} brd ff:ff:ff:ff:ff:ff`);
      if (ip && mask) {
        const dynFlag = this.isDHCPConfigured(port.getName()) ? ' dynamic' : '';
        lines.push(`    inet ${ip}/${mask.toCIDR()}${dynFlag} scope global ${port.getName()}`);
      }
      idx++;
    }
    return lines.join('\n');
  }

  private cmdIpRoute(args: string[]): string {
    if (args.length >= 4 && args[0] === 'add' && args[1] === 'default' && args[2] === 'via') {
      try {
        this.setDefaultGateway(new IPAddress(args[3]));
        return '';
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    if (args.length >= 4 && args[0] === 'add' && args[2] === 'via') {
      try {
        const netParts = args[1].split('/');
        if (netParts.length !== 2) return 'Error: Invalid prefix (expected <network>/<cidr>)';
        const network = new IPAddress(netParts[0]);
        const mask = SubnetMask.fromCIDR(parseInt(netParts[1], 10));
        const nextHop = new IPAddress(args[3]);
        let metric = 100;
        const metricIdx = args.indexOf('metric');
        if (metricIdx !== -1 && args[metricIdx + 1]) {
          metric = parseInt(args[metricIdx + 1], 10);
        }
        if (!this.addStaticRoute(network, mask, nextHop, metric)) {
          return 'RTNETLINK answers: Network is unreachable';
        }
        return '';
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    if (args.length >= 2 && args[0] === 'del' && args[1] === 'default') {
      this.clearDefaultGateway();
      return '';
    }

    if (args.length >= 2 && args[0] === 'del') {
      try {
        const netParts = args[1].split('/');
        if (netParts.length !== 2) return 'Error: Invalid prefix';
        const network = new IPAddress(netParts[0]);
        const mask = SubnetMask.fromCIDR(parseInt(netParts[1], 10));
        if (!this.removeRoute(network, mask)) {
          return 'RTNETLINK answers: No such process';
        }
        return '';
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    return this.showRoutingTable();
  }

  private showRoutingTable(): string {
    const table = this.getRoutingTable();
    if (table.length === 0) return 'No routes configured';

    const lines: string[] = [];
    const sorted = [...table].sort((a, b) => {
      const order = { connected: 0, static: 1, default: 2 };
      return order[a.type] - order[b.type];
    });

    for (const route of sorted) {
      if (route.type === 'default') {
        const proto = this.isDHCPConfigured(route.iface) ? 'dhcp' : 'static';
        const metricStr = route.metric > 0 ? ` metric ${route.metric}` : '';
        lines.push(`default via ${route.nextHop} dev ${route.iface} proto ${proto}${metricStr}`);
      } else if (route.type === 'connected') {
        const port = this.ports.get(route.iface);
        const srcIP = port?.getIPAddress();
        const srcStr = srcIP ? ` src ${srcIP}` : '';
        lines.push(`${route.network}/${route.mask.toCIDR()} dev ${route.iface} proto kernel scope link${srcStr} metric ${route.metric || 100}`);
      } else {
        // static
        lines.push(`${route.network}/${route.mask.toCIDR()} via ${route.nextHop} dev ${route.iface} proto static metric ${route.metric || 100}`);
      }
    }

    return lines.join('\n');
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
    let ttl: number | undefined;
    let targetStr = '';

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' && args[i + 1]) { count = parseInt(args[i + 1], 10); i++; }
      else if (args[i] === '-t' && args[i + 1]) { ttl = parseInt(args[i + 1], 10); i++; }
      else if (!args[i].startsWith('-')) { targetStr = args[i]; }
    }

    if (!targetStr) return 'Usage: ping [-c count] [-t ttl] <destination>';

    let targetIP: IPAddress;
    try { targetIP = new IPAddress(targetStr); }
    catch { return `ping: ${targetStr}: Name or service not known`; }

    const results = await this.executePingSequence(targetIP, count, 2000, ttl);
    return this.formatPingOutput(targetIP, count, results);
  }

  private formatPingOutput(targetIP: IPAddress, count: number, results: PingResult[]): string {
    const lines: string[] = [];
    lines.push(`PING ${targetIP} (${targetIP}) 56(84) bytes of data.`);

    const received = results.filter(r => r.success);
    const failed = count - received.length;

    if (results.length === 0) {
      lines.push(`connect: Network is unreachable`);
    } else {
      for (const r of results) {
        if (r.success) {
          lines.push(`64 bytes from ${r.fromIP}: icmp_seq=${r.seq} ttl=${r.ttl} time=${r.rttMs.toFixed(3)} ms`);
        } else if (r.error) {
          // ICMP error messages from routers
          if (r.error.includes('Time to live exceeded')) {
            const match = r.error.match(/from ([\d.]+)/);
            const fromIP = match ? match[1] : 'unknown';
            lines.push(`From ${fromIP} icmp_seq=${r.seq} Time to live exceeded`);
          } else if (r.error.includes('Destination unreachable')) {
            const match = r.error.match(/from ([\d.]+)/);
            const fromIP = match ? match[1] : 'unknown';
            lines.push(`From ${fromIP} icmp_seq=${r.seq} Destination Host Unreachable`);
          }
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
