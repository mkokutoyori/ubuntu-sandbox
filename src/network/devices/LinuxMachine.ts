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
 * PHASE 3 (current) — `LinuxPC` and `LinuxServer` are now thin shells
 * extending this class. All behavior lives here; the subclasses only
 * provide a `LinuxProfile` and (for `LinuxServer`) two Oracle API
 * pass-throughs. See `linux_gap.md` §9, Phase 3.
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
  readDhcpLeaseFile,
  dhclientPsLines,
  applyIptablesNatHook,
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
   * Check whether the input contains any command that needs direct access
   * to EndHost internals (and therefore cannot be delegated entirely to
   * the bash interpreter).
   */
  private containsNetworkCommand(input: string): boolean {
    if (this.commands.hasNetworkCommandIn(input)) return true;
    // Additional commands that require EndHost access but are not in
    // the registry because they need special dispatch logic.
    if (input.includes('/var/lib/dhcp/')) return true;
    const words = input.split(/[\s;|&]+/);
    return words.some(w =>
      w === 'iptables' || w === 'iptables-save' || w === 'iptables-restore' || w === 'ps' || w === 'man',
    );
  }

  /**
   * Execute a command string. The dispatch order mirrors the original
   * `LinuxPC.executeCommand()`:
   *
   *   1. If the line contains no network-context command, hand the whole
   *      line to the bash interpreter inside `LinuxCommandExecutor`.
   *   2. Otherwise, split on `;`, handle pipes, strip `sudo`, and
   *      dispatch the head token through the registry or the built-in
   *      network command handlers (iptables, ps, cat/rm of DHCP leases).
   */
  async executeCommand(command: string): Promise<string> {
    if (!this.isPoweredOn) return 'Device is powered off';

    const trimmed = command.trim();
    if (!trimmed) return '';

    // Fast path: no network command → straight to bash interpreter.
    if (!this.containsNetworkCommand(trimmed)) {
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

    // Piped command: route the head through the network dispatcher,
    // then apply the remaining text filters through the bash interpreter.
    if (/\|(?!\|)/.test(trimmed)) {
      return this.executePipedCommand(trimmed);
    }

    // Single command: strip sudo, try network dispatch.
    const networkResult = await this.tryNetworkCommand(trimmed);
    if (networkResult !== null) return networkResult;

    // Otherwise, fall through to the bash interpreter.
    return this.executor.execute(trimmed);
  }

  /**
   * Try to handle a command as a network-aware command. Returns null if
   * the command should be delegated to the bash interpreter.
   */
  private async tryNetworkCommand(input: string): Promise<string | null> {
    const noSudo = input.startsWith('sudo ') ? input.slice(5).trim() : input;
    const firstCmd = noSudo.split(/[\s|;&]/)[0];

    // 0. man command — render a manual page from registry metadata
    if (firstCmd === 'man') {
      const tokens = noSudo.split(/\s+/);
      if (tokens.length < 2) return 'What manual page do you want?';
      const target = tokens[1];
      const manCmd = this.commands.get(target);
      if (!manCmd || !manCmd.help) return `No manual entry for ${target}`;
      const section = manCmd.manSection ?? 8;
      const header = `${manCmd.name.toUpperCase()}(${section})`;
      const lines: string[] = [
        header,
        '',
        'NAME',
        `       ${manCmd.name}`,
        '',
        'SYNOPSIS',
        `       ${manCmd.usage ?? manCmd.name}`,
        '',
        'DESCRIPTION',
        ...manCmd.help.split('\n').map(l => `       ${l}`),
        '',
        header,
      ];
      return lines.join('\n');
    }

    // 1. Commands registered in the LinuxCommandRegistry
    const cmd = this.commands.get(firstCmd);
    if (cmd && cmd.needsNetworkContext) {
      const tokens = noSudo.split(/\s+/);
      const cmdArgs = tokens.slice(1);
      // --help flag: return usage instead of running the command
      if (cmdArgs.includes('--help') && cmd.usage) {
        return `Usage: ${cmd.usage}`;
      }
      return await cmd.run(this.buildCommandContext(), cmdArgs);
    }

    // 2. Commands that need special handling outside the registry
    switch (firstCmd) {
      case 'iptables': {
        const iptArgs = LinuxMachine.tokenizeArgs(noSudo).slice(1);
        applyIptablesNatHook(this.net, iptArgs);
        return this.executor.iptables.execute(iptArgs).output;
      }
      case 'iptables-save': {
        if (noSudo.includes('>')) return null; // redirect → let bash handle it
        return this.executor.iptables.executeSave();
      }
      case 'iptables-restore': {
        return null; // always let bash handle (needs < file redirection)
      }
      case 'ps': {
        // Run the executor's ps first (shows init, bash, oracle, etc.)
        // then append dhclient process lines from EndHost.
        const basePs = this.executor.execute(input);
        const extra = dhclientPsLines(this.net);
        if (extra.length === 0) return basePs;
        return basePs + '\n' + extra.join('\n');
      }
      case 'cat': {
        const parts = noSudo.split(/\s+/);
        const path = parts[1];
        if (!path) return null;
        const lease = readDhcpLeaseFile(this.net, path);
        if (lease !== null) return lease;
        return null;
      }
      case 'rm': {
        if (noSudo.includes('/var/lib/dhcp/dhclient')) return '';
        return null;
      }
      default: return null;
    }
  }

  /**
   * Run the first segment of a pipeline through the network dispatcher,
   * then hand the remaining segments to the bash interpreter via a
   * synthetic `printf <stdin> | <rest>` pipeline.
   */
  private async executePipedCommand(line: string): Promise<string> {
    const firstPipe = line.search(/\|(?!\|)/);
    const head = line.slice(0, firstPipe).trim();
    const tail = line.slice(firstPipe + 1).trim();

    const headResult = await this.tryNetworkCommand(head);
    if (headResult === null) {
      return this.executor.execute(line);
    }

    const escaped = headResult.replace(/'/g, "'\\''");
    return this.executor.execute(`printf '%s' '${escaped}' | ${tail}`);
  }

  /**
   * Quote-aware argument tokenizer. Handles double and single quotes
   * so that e.g. `--comment "Allow SSH"` stays as a single token.
   */
  private static tokenizeArgs(input: string): string[] {
    const tokens: string[] = [];
    let cur = '', inQ = false, qc = '';
    for (const ch of input) {
      if (inQ) { if (ch === qc) inQ = false; else cur += ch; }
      else if (ch === '"' || ch === "'") { inQ = true; qc = ch; }
      else if (ch === ' ' || ch === '\t') { if (cur) { tokens.push(cur); cur = ''; } }
      else cur += ch;
    }
    if (cur) tokens.push(cur);
    return tokens;
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

  /**
   * Tab completion. If the line is a registered network command with a
   * `complete()` callback, delegate to it (optionally stripping a leading
   * `sudo`). Otherwise fall back to the bash interpreter's default
   * completion (commands / paths / env vars).
   */
  getCompletions(partial: string): string[] {
    const trimmed = partial.trimStart();
    if (!trimmed) return this.executor.getCompletions(partial);

    // Split into tokens. `'arp -d '.split(/\s+/)` already yields
    // `['arp', '-d', '']`, so the trailing empty token correctly
    // signals "user just typed a space, completing a fresh argument".
    const tokens = trimmed.split(/\s+/);

    // Strip a leading `sudo` for dispatch purposes.
    let head = tokens[0];
    let rest = tokens.slice(1);
    if (head === 'sudo' && rest.length > 0) {
      head = rest[0];
      rest = rest.slice(1);
    }

    // `man <prefix>` completes to registered command names.
    if (head === 'man' && rest.length <= 1) {
      const prefix = rest[0] ?? '';
      return this.commands
        .list()
        .map(c => c.name)
        .filter(n => n.startsWith(prefix))
        .sort();
    }

    // Delegate to the command's `complete()` callback if we are completing
    // an argument to a registered command.
    if (rest.length >= 1) {
      const cmd = this.commands.get(head);
      if (cmd && cmd.complete) {
        const partialArg = rest[rest.length - 1];
        const candidates = cmd.complete(this.buildCommandContext(), rest);
        if (candidates.length > 0) {
          return candidates.filter(c => c.startsWith(partialArg)).sort();
        }
      }
    }

    return this.executor.getCompletions(partial);
  }
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
