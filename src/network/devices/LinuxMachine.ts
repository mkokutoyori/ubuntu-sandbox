/**
 * LinuxMachine - Abstract base class shared by all simulated Linux devices.
 *
 * Rationale (see `linux_gap.md` §6): a server is a Linux machine.
 * `LinuxPC` and `LinuxServer` differ only by a `LinuxProfile`, not by
 * behavior. `LinuxMachine` hosts all the common machinery:
 *
 *   - port creation from the profile
 *   - `LinuxCommandExecutor` instantiation
 *   - `IpNetworkContext` adapter used by the `ip` command
 *   - `LinuxNetKernel` façade used by future `LinuxCommand` implementations
 *   - `LinuxCommandRegistry` wiring + registration of `CORE_LINUX_COMMANDS`
 *   - `firewallFilter`, `evaluateNat`, `evaluatePreRouting` overrides
 *   - editor / session helpers shared with `Terminal.tsx`
 *   - co-located L7 daemons (`DnsService`) and `IpXfrmContext`
 *
 * ──────────────────────────────────────────────────────────────────────
 * PHASE 1 (current) — This class exists but is NOT yet instantiated
 * anywhere. `LinuxPC` and `LinuxServer` are untouched and keep working.
 * The class is intentionally self-sufficient so Phase 2 can migrate
 * commands into `commands/` one file at a time.
 * ──────────────────────────────────────────────────────────────────────
 */

import { EndHost, type PingResult, type ARPEntry, type HostRouteEntry } from './EndHost';
import { Port } from '../hardware/Port';
import {
  IPAddress,
  SubnetMask,
  type DeviceType,
  type IPv4Packet,
  type MACAddress,
} from '../core/types';

// Linux kernel / userspace
import { LinuxCommandExecutor } from './linux/LinuxCommandExecutor';
import type { LinuxProfile } from './linux/LinuxProfile';
import type {
  IpNetworkContext,
  IpInterfaceInfo,
  IpRouteEntry,
  IpNeighborEntry,
  IpXfrmContext,
} from './linux/LinuxIpCommand';
import { DnsService } from './linux/LinuxDnsService';
import type { PacketInfo } from './linux/LinuxIptablesManager';

// Façade + command registry
import type { LinuxNetKernel, TracerouteHop } from './linux/LinuxNetKernel';
import type { LinuxCommandContext } from './linux/commands/LinuxCommandContext';
import {
  LinuxCommandRegistry,
  CORE_LINUX_COMMANDS,
} from './linux/commands';
import {
  defaultLinuxFormatHelpers,
  type LinuxFormatHelpers,
} from './linux/LinuxFormatHelpers';
import type { DHCPClient } from '../dhcp/DHCPClient';

// ─── Class ─────────────────────────────────────────────────────────────

export abstract class LinuxMachine extends EndHost {
  protected readonly defaultTTL = 64;

  /** Active profile — describes the "flavor" of this Linux machine. */
  public readonly profile: LinuxProfile;

  /** Kernel services: VFS, users, iptables, services, processes. */
  protected readonly executor: LinuxCommandExecutor;

  /** Narrow façade over the L2/L3 stack, handed to every command. */
  protected readonly net: LinuxNetKernel;

  /** Format helpers (ping/traceroute/ifconfig). */
  protected readonly fmt: LinuxFormatHelpers = defaultLinuxFormatHelpers;

  /** Registry of network-aware commands handled before the bash interpreter. */
  protected readonly commands: LinuxCommandRegistry;

  /** XFRM (IPsec) SAD/SPD — consumed by `ip xfrm state/policy`. */
  protected xfrmCtx: IpXfrmContext = { states: [], policies: [] };

  /** DNS daemon (dnsmasq) — active when the machine runs as a DNS server. */
  public readonly dnsService: DnsService = new DnsService();

  /** Configured DNS resolver IP (from /etc/resolv.conf). */
  protected dnsResolverIP = '';

  constructor(
    type: DeviceType,
    name: string,
    x: number,
    y: number,
    profile: LinuxProfile,
  ) {
    super(type, name, x, y);
    this.profile = profile;

    // 1. Ports
    this.createPortsFromProfile();

    // 2. Kernel / userspace
    this.executor = new LinuxCommandExecutor(profile.isServer);
    this.executor.setIpNetworkContext(this.buildIpNetworkContext());

    // 3. Network façade (closes over protected EndHost members)
    this.net = this.buildNetKernel();

    // 4. Command registry
    this.commands = new LinuxCommandRegistry();
    this.registerCoreCommands();
    this.registerDeviceCommands();
  }

  // ─── Ports ───────────────────────────────────────────────────────────

  private createPortsFromProfile(): void {
    const { portCount, portPrefix } = this.profile;
    for (let i = 0; i < portCount; i++) {
      this.addPort(new Port(`${portPrefix}${i}`, 'ethernet'));
    }
  }

  // ─── Command registry hooks ──────────────────────────────────────────

  /** Register core commands (ping, traceroute, dhclient, …). */
  private registerCoreCommands(): void {
    this.commands.registerAll(CORE_LINUX_COMMANDS);
  }

  /**
   * Hook for subclasses to register additional commands. Default: no-op.
   * Subclasses override this when they have device-specific commands
   * (none at the moment — Phase 2 will likely keep this empty).
   */
  protected registerDeviceCommands(): void {
    /* no-op by default */
  }

  /** Build the context object passed to every `LinuxCommand.run()` call. */
  protected buildCommandContext(): LinuxCommandContext {
    return {
      executor: this.executor,
      net: this.net,
      dnsService: this.dnsService,
      xfrm: this.xfrmCtx,
      profile: this.profile,
      fmt: this.fmt,
    };
  }

  // ─── Terminal entry point ────────────────────────────────────────────

  /**
   * Execute a command string. The dispatch order is:
   *
   *   1. If the line contains no network-context command, hand the whole
   *      line to the bash interpreter inside `LinuxCommandExecutor`.
   *   2. Otherwise, split on `;`, handle pipes, strip `sudo`, and
   *      dispatch the head token through `LinuxCommandRegistry`.
   *
   * In Phase 1 the core registry is empty, so every input falls through
   * to the bash interpreter — matching exactly what `LinuxCommandExecutor`
   * already does for a typical command.
   */
  async executeCommand(command: string): Promise<string> {
    if (!this.isPoweredOn) return 'Device is powered off';

    const trimmed = command.trim();
    if (!trimmed) return '';

    // Fast path: no network command → straight to bash interpreter.
    if (!this.commands.hasNetworkCommandIn(trimmed)) {
      return this.executor.execute(trimmed);
    }

    // Compound commands: split on `;` and recurse.
    if (trimmed.includes(';')) {
      const parts = trimmed.split(';').map(s => s.trim()).filter(Boolean);
      const outputs: string[] = [];
      for (const p of parts) {
        const out = await this.executeCommand(p);
        if (out) outputs.push(out);
      }
      return outputs.join('\n');
    }

    // Piped command: route the head through the registry, then apply the
    // remaining text filters through the bash interpreter.
    if (/\|(?!\|)/.test(trimmed)) {
      return this.executePipedCommand(trimmed);
    }

    // Single command: strip sudo, look up in registry.
    const noSudo = trimmed.startsWith('sudo ') ? trimmed.slice(5).trim() : trimmed;
    const tokens = noSudo.split(/\s+/);
    const head = tokens[0];
    const cmd = this.commands.get(head);
    if (cmd && cmd.needsNetworkContext) {
      const result = await cmd.run(this.buildCommandContext(), tokens.slice(1));
      return result;
    }

    // Otherwise, fall through to the bash interpreter.
    return this.executor.execute(trimmed);
  }

  /**
   * Run the first segment of a pipeline through the network dispatcher,
   * then hand the remaining segments to the bash interpreter via a
   * synthetic `echo <stdin> | <rest>` pipeline. Keeps the output semantics
   * of `ifconfig | grep inet` without duplicating the filter logic.
   */
  private async executePipedCommand(line: string): Promise<string> {
    const firstPipe = line.search(/\|(?!\|)/);
    const head = line.slice(0, firstPipe).trim();
    const tail = line.slice(firstPipe + 1).trim();

    // Dispatch the head through the registry.
    const noSudo = head.startsWith('sudo ') ? head.slice(5).trim() : head;
    const tokens = noSudo.split(/\s+/);
    const cmd = this.commands.get(tokens[0]);
    if (!cmd || !cmd.needsNetworkContext) {
      // Not actually a network command in the head — delegate everything.
      return this.executor.execute(line);
    }

    const headOutput = await cmd.run(this.buildCommandContext(), tokens.slice(1));

    // Feed headOutput into the tail via the bash interpreter.
    // Uses printf because `echo -n` behavior differs across shells.
    const escaped = headOutput.replace(/'/g, "'\\''");
    return this.executor.execute(`printf '%s' '${escaped}' | ${tail}`);
  }

  // ─── IpNetworkContext adapter (for the `ip` command) ────────────────

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
      xfrm: self.xfrmCtx,
    };
  }

  // ─── LinuxNetKernel façade (closes over EndHost protected members) ──

  private buildNetKernel(): LinuxNetKernel {
    const self = this;
    return {
      getPorts(): ReadonlyMap<string, Port> {
        return self.ports;
      },
      configureInterface(name: string, ip: IPAddress, mask: SubnetMask): boolean {
        return self.configureInterface(name, ip, mask);
      },
      isDHCPConfigured(name: string): boolean {
        return self.isDHCPConfigured(name);
      },
      getRoutingTable(): HostRouteEntry[] {
        return self.getRoutingTable();
      },
      addStaticRoute(network: IPAddress, mask: SubnetMask, gw: IPAddress, metric?: number): boolean {
        return self.addStaticRoute(network, mask, gw, metric ?? 100);
      },
      removeRoute(network: IPAddress, mask: SubnetMask): boolean {
        return self.removeRoute(network, mask);
      },
      setDefaultGateway(gw: IPAddress): void {
        self.setDefaultGateway(gw);
      },
      getDefaultGateway(): IPAddress | null {
        return self.getDefaultGateway();
      },
      clearDefaultGateway(): void {
        self.clearDefaultGateway();
      },
      getArpTable(): ReadonlyMap<string, ARPEntry> {
        return self.arpTable;
      },
      addStaticARP(ip: string, mac: MACAddress, iface: string): void {
        self.addStaticARP(ip, mac, iface);
      },
      deleteARP(ip: string): boolean {
        return self.deleteARP(ip);
      },
      pingSequence(
        target: IPAddress,
        count: number,
        timeoutMs = 2000,
        ttl?: number,
      ): Promise<PingResult[]> {
        return self.executePingSequence(target, count, timeoutMs, ttl);
      },
      async traceroute(target: IPAddress): Promise<TracerouteHop[]> {
        const hops = await self.executeTraceroute(target);
        return hops as TracerouteHop[];
      },
      getDhcpClient(): DHCPClient {
        return self.dhcpClient;
      },
      autoDiscoverDHCPServers(): void {
        self.autoDiscoverDHCPServers();
      },
      setIpForward(enabled: boolean): void {
        self.ipForwardEnabled = enabled;
      },
      isIpForwardEnabled(): boolean {
        return self.ipForwardEnabled;
      },
      addMasqueradeInterface(iface: string): void {
        self.masqueradeOnInterfaces.add(iface);
      },
      removeMasqueradeInterface(iface: string): void {
        self.masqueradeOnInterfaces.delete(iface);
      },
      extractPorts(pkt: IPv4Packet): { srcPort?: number; dstPort?: number } {
        return self.extractPorts(pkt);
      },
    };
  }

  // ─── Firewall / NAT overrides (single source of truth via iptables) ─

  protected override firewallFilter(
    portName: string,
    ipPkt: IPv4Packet,
    direction: 'in' | 'out' | 'forward',
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
    return this.executor.iptables.filterPacket(pkt);
  }

  protected override evaluateNat(
    ipPkt: IPv4Packet,
    inPort: string,
    outPort: string,
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

  protected override evaluatePreRouting(
    inPort: string,
    ipPkt: IPv4Packet,
  ): { action: string; address?: string } | null {
    const ports = this.extractPorts(ipPkt);
    const pkt: PacketInfo = {
      direction: 'in',
      protocol: ipPkt.protocol,
      srcIP: ipPkt.sourceIP.toString(),
      dstIP: ipPkt.destinationIP.toString(),
      srcPort: ports.srcPort,
      dstPort: ports.dstPort,
      iface: inPort,
    };
    return this.executor.iptables.evaluateNat(pkt, 'PREROUTING');
  }

  // ─── OS Info ─────────────────────────────────────────────────────────

  getOSType(): string { return 'linux'; }

  // ─── Editor / session pass-throughs ─────────────────────────────────

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
  checkPassword(username: string, password: string): boolean {
    return this.executor.checkPassword(username, password);
  }
  setUserPassword(username: string, password: string): void {
    this.executor.setUserPassword(username, password);
  }
  userExists(username: string): boolean { return this.executor.userExists(username); }
  setUserGecos(
    username: string,
    fullName: string,
    room: string,
    workPhone: string,
    homePhone: string,
    other: string,
  ): void {
    this.executor.setUserGecos(username, fullName, room, workPhone, homePhone, other);
  }
  canSudo(): boolean { return this.executor.canSudo(); }
}
