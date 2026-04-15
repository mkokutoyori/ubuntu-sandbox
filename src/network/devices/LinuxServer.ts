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
import { IPAddress, SubnetMask, DeviceType, IPv4Packet } from '../core/types';
import { LinuxCommandExecutor } from './linux/LinuxCommandExecutor';
import type { PacketInfo } from './linux/LinuxIptablesManager';
import type { IpNetworkContext, IpInterfaceInfo, IpRouteEntry, IpNeighborEntry } from './linux/LinuxIpCommand';
import {
  arpCommand,
  ifconfigCommand,
  pingCommand,
  tracerouteCommand,
  digCommand,
  nslookupCommand,
  hostCommand,
  dnsmasqCommand,
  dhclientCommand,
} from './linux/commands';
import type { LinuxCommandContext } from './linux/commands';
import type { LinuxNetKernel } from './linux/LinuxNetKernel';
import { defaultLinuxFormatHelpers } from './linux/LinuxFormatHelpers';
import { DnsService } from './linux/LinuxDnsService';

export class LinuxServer extends EndHost {
  protected readonly defaultTTL = 64;
  private executor: LinuxCommandExecutor;
  /**
   * DNS service (dnsmasq) — Phase 2 / PR 8: a `LinuxServer` can now
   * act as a DNS server, finally honouring its name. Public so that
   * other devices can resolve through `findDnsServerByIP(...)`.
   */
  public dnsService: DnsService = new DnsService();

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
    const networkResult = await this.tryNetworkCommand(trimmed);
    if (networkResult !== null) return networkResult;

    // Delegate to Linux command executor (handles ip, filesystem, etc.)
    return this.executor.execute(trimmed);
  }

  /**
   * Try to handle as a networking command. Returns null if not a network command.
   */
  private async tryNetworkCommand(input: string): Promise<string | null> {
    // Strip sudo for network commands too
    const noSudo = input.startsWith('sudo ') ? input.slice(5).trim() : input;
    const parts = noSudo.split(/\s+/);
    const cmd = parts[0];

    switch (cmd) {
      case 'ifconfig': return this.cmdIfconfig(parts.slice(1));
      case 'ping': return await this.cmdPing(parts.slice(1));
      case 'traceroute': return await this.cmdTraceroute(parts.slice(1));
      case 'arp': return this.cmdArp(parts.slice(1));
      case 'dig': return digCommand.run(this.dnsBridge(), parts.slice(1)) as string;
      case 'nslookup': return nslookupCommand.run(this.dnsBridge(), parts.slice(1)) as string;
      case 'host': return hostCommand.run(this.dnsBridge(), parts.slice(1)) as string;
      case 'dnsmasq': return dnsmasqCommand.run(this.dnsBridge(), parts.slice(1)) as string;
      case 'dhclient': return dhclientCommand.run(this.dhcpBridge(), parts.slice(1)) as string;
      default: return null;
    }
  }

  /**
   * Minimal `LinuxNetKernel` shim used by the DHCP command. Only the
   * three methods `dhclientCommand` actually touches are defined.
   */
  private dhcpBridge(): LinuxCommandContext {
    const net = {
      getPorts: () => this.ports,
      getDhcpClient: () => this.dhcpClient,
      autoDiscoverDHCPServers: () => this.autoDiscoverDHCPServers(),
    } as unknown as LinuxNetKernel;
    return { net } as unknown as LinuxCommandContext;
  }

  /**
   * Minimal `LinuxCommandContext` shim used by all four DNS commands.
   */
  private dnsBridge(): LinuxCommandContext {
    return {
      executor: this.executor,
      dnsService: this.dnsService,
    } as unknown as LinuxCommandContext;
  }

  /**
   * Delegates to the extracted `tracerouteCommand`. Phase 2 / PR 7:
   * `LinuxServer` gains a real traceroute (was routed to the
   * executor stub before).
   */
  private async cmdTraceroute(args: string[]): Promise<string> {
    const bridge = {
      net: {
        traceroute: (target: IPAddress) => this.executeTraceroute(target),
      },
      fmt: defaultLinuxFormatHelpers,
    } as unknown as LinuxCommandContext;
    return await tracerouteCommand.run(bridge, args);
  }

  /**
   * Delegates to the extracted `pingCommand`. Phase 2 / PR 6:
   * `LinuxServer` now uses the **real** `EndHost` ICMP path instead
   * of falling back to the canned stub of `LinuxCommandExecutor`.
   * Closes the silent regression documented in `linux_gap.md` §4.
   */
  private async cmdPing(args: string[]): Promise<string> {
    const bridge = {
      net: {
        pingSequence: (target: IPAddress, count: number, timeoutMs?: number, ttl?: number) =>
          this.executePingSequence(target, count, timeoutMs ?? 2000, ttl),
      },
      fmt: defaultLinuxFormatHelpers,
    } as unknown as LinuxCommandContext;
    return await pingCommand.run(bridge, args);
  }

  // ─── Networking commands ──────────────────────────────────────────

  /**
   * Delegates to the extracted `ifconfigCommand`. Phase 2 bridge.
   *
   * Side effect: `LinuxServer` now emits the **same** rich output as
   * `LinuxPC` (with RX/TX counter lines, proper flag=4099 when the
   * interface has no carrier, real port MTU instead of a hard-coded
   * `1500`). This fixes the latent divergence documented in
   * `linux_gap.md` §3.3.
   */
  private cmdIfconfig(args: string[]): string {
    const bridge = {
      net: {
        getPorts: () => this.ports,
        configureInterface: (name: string, ip: IPAddress, mask: SubnetMask) =>
          this.configureInterface(name, ip, mask),
      },
      fmt: defaultLinuxFormatHelpers,
    } as unknown as LinuxCommandContext;
    return ifconfigCommand.run(bridge, args) as string;
  }

  /**
   * Delegates to the extracted `arpCommand`. Phase 2 bridge — Phase 3
   * will replace this by the registry lookup once `LinuxServer` becomes
   * a `LinuxMachine` subclass.
   */
  private cmdArp(args: string[]): string {
    const bridge = {
      net: {
        getPorts: () => this.ports,
        getArpTable: () => this.arpTable,
        addStaticARP: (ip: string, mac: import('../core/types').MACAddress, iface: string) =>
          this.addStaticARP(ip, mac, iface),
        deleteARP: (ip: string) => this.deleteARP(ip),
      },
    } as unknown as LinuxCommandContext;
    return arpCommand.run(bridge, args) as string;
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

  // ─── Firewall filtering ────────────────────────────────────────

  protected override firewallFilter(
    portName: string, ipPkt: IPv4Packet, direction: 'in' | 'out' | 'forward',
    outPortName?: string,
  ): 'accept' | 'drop' | 'reject' {
    const ports = this.extractPorts(ipPkt);
    const pkt: PacketInfo = {
      direction,
      protocol: ipPkt.protocol,
      srcIP: ipPkt.sourceIP.toString(),
      dstIP: ipPkt.destinationIP.toString(),
      srcPort: ports.srcPort,
      dstPort: ports.dstPort,
      iface: portName,
      outIface: outPortName,
    };
    // Packet filtering is ALWAYS done by iptables (the single source of truth).
    return this.executor.iptables.filterPacket(pkt);
  }

  protected override evaluateNat(
    ipPkt: IPv4Packet, inPort: string, outPort: string,
  ): { action: string; address?: string } | null {
    const ports = this.extractPorts(ipPkt);
    const pkt: PacketInfo = {
      direction: 'forward',
      protocol: ipPkt.protocol,
      srcIP: ipPkt.sourceIP.toString(),
      dstIP: ipPkt.destinationIP.toString(),
      srcPort: ports.srcPort,
      dstPort: ports.dstPort,
      iface: inPort,
      outIface: outPort,
    };
    return this.executor.iptables.evaluateNat(pkt, 'POSTROUTING');
  }

  getOSType(): string { return 'linux'; }

  readFileForEditor(path: string): string | null {
    const absPath = this.executor.vfs.normalizePath(path, this.executor.getCwd());
    return this.executor.vfs.readFile(absPath);
  }

  writeFileFromEditor(path: string, content: string): boolean {
    const absPath = this.executor.vfs.normalizePath(path, this.executor.getCwd());
    const uid = this.executor.getCurrentUid();
    const gid = uid === 0 ? 0 : 1000;
    return this.executor.vfs.writeFile(absPath, content, uid, gid, 0o022);
  }

  resolveAbsolutePath(path: string): string {
    return this.executor.vfs.normalizePath(path, this.executor.getCwd());
  }

  getCwd(): string { return this.executor.getCwd(); }
  getCompletions(partial: string): string[] { return this.executor.getCompletions(partial); }
  getCurrentUser(): string { return this.executor.getCurrentUser(); }
  getCurrentUid(): number { return this.executor.getCurrentUid(); }
  handleExit(): { output: string; inSu: boolean } { return this.executor.handleExit(); }
  resetSession(): void { this.executor.resetSession(); }
  checkPassword(username: string, password: string): boolean { return this.executor.checkPassword(username, password); }
  setUserPassword(username: string, password: string): void { this.executor.setUserPassword(username, password); }
  userExists(username: string): boolean { return this.executor.userExists(username); }
  setUserGecos(username: string, fullName: string, room: string, workPhone: string, homePhone: string, other: string): void { this.executor.setUserGecos(username, fullName, room, workPhone, homePhone, other); }
  canSudo(): boolean { return this.executor.canSudo(); }
  registerProcess(pid: number, user: string, command: string): void { this.executor.registerProcess(pid, user, command); }
  clearSystemProcesses(): void { this.executor.clearSystemProcesses(); }
}
