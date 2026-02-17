/**
 * LinuxServer - Linux server with full filesystem and user management.
 *
 * Extends EndHost (provides L2/L3 network stack).
 * Uses LinuxCommandExecutor for filesystem, user management, and utility commands.
 * The `ip` command is handled by LinuxIpCommand via LinuxCommandExecutor.
 * Falls through to networking commands (ifconfig, arp, etc.) when needed.
 */

import { EndHost, PingResult } from './EndHost';
import { Port } from '../hardware/Port';
import { IPAddress, SubnetMask, DeviceType } from '../core/types';
import { LinuxCommandExecutor } from './linux/LinuxCommandExecutor';
import type { IpNetworkContext, IpInterfaceInfo, IpRouteEntry, IpNeighborEntry } from './linux/LinuxIpCommand';

export class LinuxServer extends EndHost {
  protected readonly defaultTTL = 64;
  private executor: LinuxCommandExecutor;

  constructor(type: DeviceType = 'linux-server', name: string = 'Server', x: number = 0, y: number = 0) {
    super(type, name, x, y);
    this.createPorts();
    this.executor = new LinuxCommandExecutor(true); // isServer = true (root user)
    this.executor.setIpNetworkContext(this.buildIpNetworkContext());
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

    // Try networking commands first (they need access to EndHost internals)
    const networkResult = this.tryNetworkCommand(trimmed);
    if (networkResult !== null) return networkResult;

    // Delegate to Linux command executor (handles ip, filesystem, etc.)
    return this.executor.execute(trimmed);
  }

  /**
   * Try to handle as a networking command. Returns null if not a network command.
   */
  private tryNetworkCommand(input: string): string | null {
    // Strip sudo for network commands too
    const noSudo = input.startsWith('sudo ') ? input.slice(5).trim() : input;
    const parts = noSudo.split(/\s+/);
    const cmd = parts[0];

    switch (cmd) {
      case 'ifconfig': return this.cmdIfconfig(parts.slice(1));
      case 'ping': return null; // Let executor handle
      case 'arp': return this.cmdArp(parts.slice(1));
      default: return null;
    }
  }

  // ─── Networking commands ──────────────────────────────────────────

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
    const status = port.getIsUp() && port.isConnected() ? 'UP,BROADCAST,RUNNING,MULTICAST' : 'UP,BROADCAST,MULTICAST';
    return [
      `${port.getName()}: flags=4163<${status}>  mtu 1500`,
      ip ? `        inet ${ip}  netmask ${mask || '255.255.255.0'}` : '        inet (not configured)',
      `        ether ${mac}`,
    ].join('\n');
  }

  private cmdArp(args: string[]): string {
    if (this.arpTable.size === 0) return '';
    const lines: string[] = [];
    for (const [ip, entry] of this.arpTable) {
      lines.push(`? (${ip}) at ${entry.mac} [ether] on ${entry.iface}`);
    }
    return lines.join('\n');
  }

  // ─── IpNetworkContext adapter ──────────────────────────────────

  private buildIpNetworkContext(): IpNetworkContext {
    const self = this;
    return {
      getInterfaceNames(): string[] {
        const names: string[] = [];
        for (const [name] of self.ports) names.push(name);
        return names;
      },
      getInterfaceInfo(name: string): IpInterfaceInfo | null {
        const port = self.ports.get(name);
        if (!port) return null;
        const ip = port.getIPAddress();
        const mask = port.getSubnetMask();
        const counters = port.getCounters();
        return {
          name: port.getName(),
          mac: port.getMAC().toString(),
          ip: ip ? ip.toString() : null,
          mask: mask ? mask.toString() : null,
          cidr: mask ? mask.toCIDR() : null,
          mtu: port.getMTU(),
          isUp: port.getIsUp(),
          isConnected: port.isConnected(),
          isDHCP: self.isDHCPConfigured(name),
          counters: {
            framesIn: counters.framesIn,
            framesOut: counters.framesOut,
            bytesIn: counters.bytesIn,
            bytesOut: counters.bytesOut,
          },
        };
      },
      configureInterface(ifName: string, ip: string, cidr: number): string {
        const port = self.ports.get(ifName);
        if (!port) return `Cannot find device "${ifName}"`;
        try {
          const mask = SubnetMask.fromCIDR(cidr);
          self.configureInterface(ifName, new IPAddress(ip), mask);
          return '';
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },
      removeInterfaceIP(ifName: string): string {
        const port = self.ports.get(ifName);
        if (!port) return `Cannot find device "${ifName}"`;
        port.clearIP();
        return '';
      },
      getRoutingTable(): IpRouteEntry[] {
        const table = self.getRoutingTable();
        return table.map(r => ({
          network: r.network.toString(),
          cidr: r.mask.toCIDR(),
          nextHop: r.nextHop ? r.nextHop.toString() : null,
          iface: r.iface,
          type: r.type,
          metric: r.metric,
          isDHCP: self.isDHCPConfigured(r.iface),
          srcIp: r.type === 'connected' ? self.ports.get(r.iface)?.getIPAddress()?.toString() : undefined,
        }));
      },
      addDefaultRoute(gateway: string): string {
        try {
          self.setDefaultGateway(new IPAddress(gateway));
          return '';
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },
      addStaticRoute(network: string, cidr: number, gateway: string, metric?: number): string {
        try {
          const mask = SubnetMask.fromCIDR(cidr);
          if (!self.addStaticRoute(new IPAddress(network), mask, new IPAddress(gateway), metric ?? 100)) {
            return 'RTNETLINK answers: Network is unreachable';
          }
          return '';
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },
      deleteDefaultRoute(): string {
        if (!self.getDefaultGateway()) return 'RTNETLINK answers: No such process';
        self.clearDefaultGateway();
        return '';
      },
      deleteRoute(network: string, cidr: number): string {
        try {
          const mask = SubnetMask.fromCIDR(cidr);
          if (!self.removeRoute(new IPAddress(network), mask)) {
            return 'RTNETLINK answers: No such process';
          }
          return '';
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },
      getNeighborTable(): IpNeighborEntry[] {
        const entries: IpNeighborEntry[] = [];
        for (const [ip, entry] of self.arpTable) {
          entries.push({
            ip,
            mac: entry.mac.toString(),
            iface: entry.iface,
            state: 'REACHABLE',
          });
        }
        return entries;
      },
      setInterfaceUp(ifName: string): string {
        const port = self.ports.get(ifName);
        if (!port) return `Cannot find device "${ifName}"`;
        port.setUp(true);
        return '';
      },
      setInterfaceDown(ifName: string): string {
        const port = self.ports.get(ifName);
        if (!port) return `Cannot find device "${ifName}"`;
        port.setUp(false);
        return '';
      },
    };
  }

  getOSType(): string { return 'linux'; }
  getCwd(): string { return this.executor.getCwd(); }
  getCompletions(partial: string): string[] { return this.executor.getCompletions(partial); }
  getCurrentUser(): string { return this.executor.getCurrentUser(); }
  getCurrentUid(): number { return this.executor.getCurrentUid(); }
  handleExit(): { output: string; inSu: boolean } { return this.executor.handleExit(); }
  checkPassword(username: string, password: string): boolean { return this.executor.checkPassword(username, password); }
  setUserPassword(username: string, password: string): void { this.executor.setUserPassword(username, password); }
  userExists(username: string): boolean { return this.executor.userExists(username); }
}
