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

import { EndHost, type PingResult, type ARPEntry, type HostRouteEntry, getNUDState } from './EndHost';
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
import { LinuxShellSession, TtyAllocator } from './linux/shell/LinuxShellSession';
import type { LinuxProfile } from './linux/LinuxProfile';
import type {
  IpNetworkContext,
  IpInterfaceInfo,
  IpRouteEntry,
  IpNeighborEntry,
  IpXfrmContext,
} from './linux/LinuxIpCommand';
import { DnsService, findDnsServerByIP } from './linux/LinuxDnsService';
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
import { renderHelp, renderManPage } from './linux/commands/LinuxCommandHelp';
import type { DHCPClient } from '../dhcp/DHCPClient';
import { LinuxSshServerContext } from '../protocols/ssh/server/LinuxSshServerContext';
import { SshServerHandler } from '../protocols/ssh/server/SshServerHandler';
import { parseSshdConfig } from '../protocols/ssh/server/SshSshdConfig';

/**
 * Minimal sshd-style glob matcher: `*` matches any sequence including
 * the empty string. Anchored on both sides like OpenSSH's `match_pattern`.
 */
function globMatch(pattern: string, candidate: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$').test(candidate);
}

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
    this.executor.attachEventBus(this.getBus(), this.id);
    this.executor.setIpNetworkContext(this.buildIpNetworkContext());
    this.syncHostnameFiles(profile.hostname);
    this.initDefaultSockets(profile.isServer);
    this.executor.setSocketTable(this.socketTable);

    // 3. Network façade (closes over protected EndHost members)
    this.net = this.buildNetKernel();

    // 4. Command registry
    this.commands = new LinuxCommandRegistry();
    this.registerCoreCommands();
    this.registerDeviceCommands();

    // 5. Initialise SSH server config files on first boot:
    //    /etc/ssh/sshd_config + /etc/ssh/ssh_host_ed25519_key(.pub).
    //    Also seed /etc/motd and /etc/issue.net so SSH greeters and the
    //    pre-auth Banner have realistic content.
    this.initSshFiles();

    // 6. TCP SSH server on port 22 — handles SSH auth + SFTP subsystem
    //    in one place.  Replaces the legacy SFTP-only handler.
    this.listenTcp(22, (conn) => {
      // Pass the real client IP so the syslogger / throttler / event-bus
      // subscribers see the actual source — not the hardcoded 0.0.0.0
      // bind address.
      this.getSshServerHandler().register(conn, conn.remoteIp);
    });
  }

  /** Persist SSH server configuration + host key + MOTD on the VFS. */
  private initSshFiles(): void {
    // Instantiating the context as a side effect creates the files.
    this.getSshServerContext();
    const vfs = this.executor.vfs;
    if (!vfs.exists('/etc/motd')) {
      vfs.writeFile(
        '/etc/motd',
        `Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)\n`,
        0,
        0,
        0o022,
      );
    }
    if (!vfs.exists('/etc/issue.net')) {
      vfs.writeFile('/etc/issue.net', 'Ubuntu 22.04.3 LTS\n', 0, 0, 0o022);
    }
  }

  // ─── Reactive surface for cross-device commands (ssh, scp, sftp) ─────

  /** Whether the named systemd unit is currently active on this machine. */
  isServiceActive(name: string): boolean {
    return this.executor.serviceMgr.isActive(name);
  }

  /**
   * Login policy check — honours the full sshd_config surface:
   *   - PermitRootLogin no / prohibit-password / yes / forced-commands-only
   *   - DenyUsers patterns (glob *)
   *   - AllowUsers patterns (glob *) — when present, user must match one
   *   - DenyUsers takes precedence over AllowUsers
   */
  sshdAcceptsLogin(user: string): { ok: boolean; reason?: string } {
    const raw = this.executor.vfs.readFile('/etc/ssh/sshd_config') ?? '';
    const cfg = parseSshdConfig(raw);

    // PermitRootLogin — anything other than `yes` blocks the root login
    // path in our password-only simulator.
    const rootDirective = /^\s*PermitRootLogin\s+(\S+)/im.exec(raw);
    const policy = rootDirective?.[1]?.toLowerCase() ?? (cfg.permitRootLogin ? 'yes' : 'no');
    if (user === 'root' && policy !== 'yes') {
      return { ok: false, reason: `PermitRootLogin ${policy}` };
    }

    const matchesAny = (patterns: readonly string[]) =>
      patterns.some(p => globMatch(p, user));

    if (cfg.denyUsers.length > 0 && matchesAny(cfg.denyUsers)) {
      return { ok: false, reason: 'DenyUsers match' };
    }
    if (cfg.allowUsers.length > 0 && !matchesAny(cfg.allowUsers)) {
      return { ok: false, reason: 'not in AllowUsers' };
    }
    return { ok: true };
  }

  /**
   * Append a syslog-style line to /var/log/auth.log on this machine.
   * Used by inbound SSH (this device) to log a login from a remote.
   */
  recordSshLogin(user: string, fromIp: string, fromHost: string, accepted: boolean): void {
    const vfs = this.executor.vfs;
    const ts = new Date().toUTCString().replace(/^... /, '').slice(0, 15);
    const verdict = accepted ? 'Accepted password' : 'Failed password';
    const line = `${ts} ${this.profile.hostname} sshd[985]: ${verdict} for ${user} from ${fromIp} (${fromHost}) port 50000 ssh2\n`;
    const existing = vfs.readFile('/var/log/auth.log') ?? '';
    vfs.writeFile('/var/log/auth.log', existing + line, 0, 0, 0o022);
  }

  // ─── Hostname sync ───────────────────────────────────────────────────

  /**
   * Set this machine's hostname after construction. Updates `/etc/hostname`
   * and `/etc/hosts` so subsequent `hostnamectl`, `uname -n`, ssh banner
   * lines, and auth.log entries all reflect the new value.
   */
  setHostname(hostname: string): void {
    (this.profile as { hostname: string }).hostname = hostname;
    this.syncHostnameFiles(hostname);
  }

  private syncHostnameFiles(hostname: string): void {
    const vfs = this.executor.vfs;
    vfs.writeFile('/etc/hostname', hostname + '\n', 0, 0, 0o022);
    vfs.writeFile('/etc/hosts',
      '127.0.0.1\tlocalhost\n' +
      `127.0.1.1\t${hostname}\n` +
      '\n' +
      '# The following lines are desirable for IPv6 capable hosts\n' +
      '::1\tlocalhost ip6-localhost ip6-loopback\n',
      0, 0, 0o022);
  }

  // ─── Default OS sockets ──────────────────────────────────────────────

  /**
   * Pre-populate the socket table with services that are always running
   * on a freshly booted Linux machine.  The PIDs match the static values
   * used by ps/netstat output so the two are coherent.
   */
  private initDefaultSockets(isServer: boolean): void {
    // sshd — listens on all interfaces (every Linux machine has SSH)
    this.socketTable.bind('tcp', '0.0.0.0', 22, 985, 'sshd');
    // systemd-resolved — DNS stub resolver bound to loopback only
    this.socketTable.bind('udp', '127.0.0.53', 53, 540, 'systemd-resolved');

    if (isServer) {
      // Oracle TNS listener — only on server profiles
      this.socketTable.bind('tcp', '0.0.0.0', 1521, 2001, 'tnslsnr');
    }
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

  /** Cached SSH server context — replaced on `systemctl restart sshd`. */
  private _sshContext: LinuxSshServerContext | null = null;
  /** Unsubscribe hook for the service-manager lifecycle listener. */
  private _sshLifecycleOff: (() => void) | null = null;

  /**
   * Return the cached `LinuxSshServerContext`, creating it on first use.
   * Subscribes to the service manager so that `systemctl restart sshd`
   * (or `reload`) reloads /etc/ssh/sshd_config and refreshes the context.
   *
   * BRD SSH-07-R6.
   */
  getSshServerContext(): LinuxSshServerContext {
    if (this._sshContext) return this._sshContext;
    this._sshContext = new LinuxSshServerContext(
      this.executor.vfs,
      this.executor.userMgr,
      this.profile.hostname,
      {},
      this.executor,
      // Route incoming SSH exec commands through the full pipeline so
      // `ip`, `arp`, `ping`, `systemctl`, etc. are available.
      (line: string) => this.executeCommand(line),
    );
    // Reactive: the SSH module subscribes to the events that concern
    // it on the shared bus (instead of the legacy onLifecycle callback).
    // sshd reloads /etc/ssh/sshd_config when its unit is restarted or
    // reloaded — BRD SSH-07-R6.
    this._sshLifecycleOff?.();
    const bus = this.getBus();
    const isSsh = (p: { name: string }): boolean => p.name === 'ssh' || p.name === 'sshd';
    const reload = (): void => {
      this._sshContext = this._sshContext?.reloadConfig() ?? null;
    };
    const offRestart = bus.subscribeWhere('linux.service.restarted', isSsh, reload);
    const offReload = bus.subscribeWhere('linux.service.reloaded', isSsh, reload);
    this._sshLifecycleOff = () => { offRestart(); offReload(); };
    return this._sshContext;
  }

  /**
   * Build a SshServerHandler ready to be hooked onto a TcpConnection.
   * The handler captures the current cached context, so config reloads
   * triggered by `systemctl restart sshd` apply to subsequent connections.
   */
  getSshServerHandler(): SshServerHandler {
    return new SshServerHandler(this.getSshServerContext());
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
      return renderManPage(manCmd);
    }

    // 1. Commands registered in the LinuxCommandRegistry
    const cmd = this.commands.get(firstCmd);
    if (cmd && cmd.needsNetworkContext) {
      const tokens = noSudo.split(/\s+/);
      const cmdArgs = tokens.slice(1);
      // --help flag: return auto-generated help instead of running.
      if (cmdArgs.includes('--help')) {
        return renderHelp(cmd);
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

  // ─── Hostname resolution (shared between buildNetKernel & commands) ─

  private static resolveHostnameImpl(
    name: string,
    executor: LinuxCommandExecutor,
  ): IPAddress | null {
    // 1. Already a valid IPv4 address → pass through
    try { return new IPAddress(name); } catch { /* not an IP */ }

    // 2. /etc/hosts lookup
    const hostsContent = executor.readFile('/etc/hosts');
    if (hostsContent) {
      for (const rawLine of hostsContent.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split(/\s+/);
        if (parts.length < 2) continue;
        const ip = parts[0];
        // Skip IPv6 entries
        if (ip.includes(':')) continue;
        for (let i = 1; i < parts.length; i++) {
          if (parts[i] === name) {
            try { return new IPAddress(ip); } catch { break; }
          }
        }
      }
    }

    // 3. DNS fallback via /etc/resolv.conf
    const resolvConf = executor.readFile('/etc/resolv.conf');
    if (resolvConf) {
      const match = resolvConf.match(/nameserver\s+(\S+)/);
      if (match) {
        const dnsServer = findDnsServerByIP(match[1]);
        if (dnsServer) {
          const records = dnsServer.query(name, 'A');
          if (records.length > 0) {
            try { return new IPAddress(records[0].value); } catch { /* skip */ }
          }
        }
      }
    }

    return null;
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
            state: getNUDState(entry),
          });
        }
        return entries;
      },
      addNeighbor(ip: string, mac: string, ifName: string): string {
        const port = self.ports.get(ifName);
        if (!port) return `RTNETLINK answers: No such device`;
        try {
          const macAddr = new MACAddress(mac);
          self.addStaticARP(ip, macAddr, ifName);
          return '';
        } catch {
          return 'RTNETLINK answers: Invalid argument';
        }
      },
      deleteNeighbor(ip: string, ifName: string): string {
        const port = self.ports.get(ifName);
        if (!port) return `RTNETLINK answers: No such device`;
        const removed = self.deleteARP(ip);
        if (!removed) return 'RTNETLINK answers: No such file or directory';
        return '';
      },
      flushNeighbors(ifName?: string): string {
        if (ifName) {
          for (const [ip, entry] of self.arpTable) {
            if (entry.iface === ifName) self.arpTable.delete(ip);
          }
        } else {
          self.clearARPTable();
        }
        return '';
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
      clearInterfaceIP(name: string): void {
        const port = self.ports.get(name);
        if (port) port.clearIP();
      },
      setInterfaceAdmin(name: string, enabled: boolean): void {
        const port = self.ports.get(name);
        if (port) port.setUp(enabled);
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
      clearARPTable(): void {
        self.clearARPTable();
      },
      pingSequence(
        target: IPAddress,
        count: number,
        timeoutMs = 2000,
        ttl?: number,
      ): Promise<PingResult[]> {
        return self.executePingSequence(target, count, timeoutMs, ttl);
      },
      async traceroute(target: IPAddress, maxHops?: number, probesPerHop?: number, firstTtl?: number): Promise<TracerouteHop[]> {
        const hops = await self.executeTraceroute(target, maxHops, 2000, probesPerHop, firstTtl);
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
      resolveHostname(name: string): IPAddress | null {
        return LinuxMachine.resolveHostnameImpl(name, self.executor);
      },
      readFile(path: string): string | null {
        return self.executor.readFile(path);
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

  /**
   * Synchronous bash-only execution path. Bypasses the network-command
   * dispatcher (so it's safe to call from synchronous contexts like
   * SQL*Plus `HOST`). Returns the command's stdout as a single string.
   */
  executeShellCommandSync(command: string): string {
    if (!this.isPoweredOn) return 'Device is powered off';
    const trimmed = command.trim();
    if (!trimmed) return '';
    return this.executor.execute(trimmed);
  }

  writeFileFromEditor(path: string, content: string): boolean {
    const absPath = this.executor.vfs.normalizePath(path, this.executor.getCwd());
    const uid = this.executor.getCurrentUid();
    const gid = uid === 0 ? 0 : 1000;
    return this.executor.vfs.writeFile(absPath, content, uid, gid, 0o022);
  }

  /**
   * Programmatic file deletion. Used by adapters that materialise
   * external state (e.g. Oracle FS sync removing dropped datafiles).
   */
  deleteFileFromEditor(path: string): boolean {
    const absPath = this.executor.vfs.normalizePath(path, this.executor.getCwd());
    return this.executor.vfs.deleteFile(absPath);
  }

  /**
   * Idempotently install a systemd unit file and bring the service to
   * the desired runtime state. The unit file lives under
   * /etc/systemd/system so it takes precedence over vendor units and
   * survives daemon-reload. Used by domain adapters (Oracle, ASM, …)
   * that want to expose themselves to the standard Linux service tooling.
   */
  installSystemdUnit(
    spec: {
      name: string;
      description: string;
      execStart: string;
      execStop?: string;
      user?: string;
      after?: string[];
    },
    desired: 'active' | 'inactive',
  ): void {
    const path = `/etc/systemd/system/${spec.name}.service`;
    const lines: string[] = [
      '[Unit]',
      `Description=${spec.description}`,
    ];
    if (spec.after && spec.after.length > 0) {
      lines.push(`After=${spec.after.map(a => a.endsWith('.target') || a.endsWith('.service') ? a : a + '.service').join(' ')}`);
    }
    lines.push(
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${spec.execStart}`,
    );
    if (spec.execStop) lines.push(`ExecStop=${spec.execStop}`);
    if (spec.user) lines.push(`User=${spec.user}`);
    lines.push(
      'Restart=on-failure',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    );
    this.executor.vfs.writeFile(path, lines.join('\n'), 0, 0, 0o022);
    const mgr = this.executor.serviceMgr;
    mgr.daemonReload();
    if (desired === 'active') {
      mgr.enable(spec.name);
      mgr.start(spec.name);
    } else {
      mgr.stop(spec.name);
    }
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

  // ── Shell sessions (per-terminal isolation, §2 of terminal_gap.md) ─

  /** Per-device pty allocator. Recycles released slots like Linux pty(7). */
  private readonly tty: TtyAllocator = new TtyAllocator();
  /** Live shell sessions keyed by their internal id. */
  private readonly shellSessions: Map<string, LinuxShellSession> = new Map();
  /**
   * Serialises concurrent executeCommandInSession calls so the swap-and-
   * restore around the executor's mutable state is atomic per device. Without
   * this, two terminals issuing commands at the same time would race on
   * `executor.cwd`.
   */
  private execQueue: Promise<unknown> = Promise.resolve();

  /**
   * Allocate a fresh shell session — one per terminal window. Spawns a
   * `-bash` process in the device's process table so `ps -ef` reports each
   * open terminal as a distinct interactive shell, exactly like Linux.
   *
   * The initial cwd is the requesting user's `$HOME` (mirrors OpenSSH and a
   * typical login). Caller may override via `init.cwd`.
   */
  openShellSession(init?: {
    user?: string;
    cwd?: string;
    env?: Map<string, string>;
  }): LinuxShellSession {
    const userName = init?.user ?? this.executor.getCurrentUser();
    const userEntry = this.executor.userMgr.getUser(userName);
    const home = userEntry?.home ?? (userName === 'root' ? '/root' : `/home/${userName}`);
    const cwd = init?.cwd ?? home;
    const uid = userEntry?.uid ?? (userName === 'root' ? 0 : 1000);
    const gid = userEntry?.gid ?? uid;

    // Inherit the executor's exported environment as a starting point.
    // Each session then owns an independent copy.
    const env = new Map<string, string>(init?.env ?? new Map());
    if (!init?.env) {
      // Seed from the device's PATH so completion / which / etc. work.
      const devPath = this.executor['env']?.get('PATH');
      if (devPath) env.set('PATH', devPath);
      env.set('HOME', home);
      env.set('USER', userName);
      env.set('LOGNAME', userName);
      env.set('SHELL', '/bin/bash');
    }

    const tty = this.tty.allocate();
    // Spawn a real "-bash" entry in the process table. Real Linux: each
    // interactive login is its own bash PID, child of sshd or login.
    const sshd = this.executor.processMgr.list({ comm: 'sshd' })[0];
    const ppid = sshd?.pid ?? 1;
    const proc = this.executor.processMgr.spawn({
      command: '-bash',
      comm: '-bash',
      user: userName,
      uid,
      gid,
      ppid,
      tty,
      cwd,
    });

    const session = new LinuxShellSession({
      user: userName,
      uid,
      gid,
      cwd,
      env,
      tty,
      shellPid: proc.pid,
      shellPpid: ppid,
    });
    this.shellSessions.set(session.id, session);
    return session;
  }

  /** Tear down a shell session — kills its `-bash` and frees its pty slot. */
  closeShellSession(sessionOrId: LinuxShellSession | string): void {
    const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id;
    const s = this.shellSessions.get(id);
    if (!s) return;
    try { this.executor.processMgr.kill(s.shellPid, 'SIGHUP'); } catch { /* ignore */ }
    this.tty.release(s.tty);
    s.dispose();
    this.shellSessions.delete(id);
  }

  /** Lookup helper for the terminal layer. */
  getShellSession(id: string): LinuxShellSession | undefined {
    return this.shellSessions.get(id);
  }

  /**
   * Like `executeCommand`, but uses the per-terminal session as the swap-in
   * state holder. Calls are serialised per device so the executor's
   * mutation window is never observed by another concurrent terminal.
   */
  executeCommandInSession(command: string, session: LinuxShellSession): Promise<string> {
    const exec = this.executor;
    const run = async () => {
      if (!this.isPoweredOn) return 'Device is powered off';
      if (session.disposed) return '';
      const baseline = exec.snapshotState();
      // Apply session state to executor for the full async chain.
      exec.swapInSession(session);
      try {
        const out = await this.executeCommand(command);
        exec.captureStateInto(session);
        return out;
      } finally {
        exec.restoreFromSnapshot(baseline);
      }
    };
    // Chain on the per-device queue: subsequent commands wait their turn.
    const promise = this.execQueue.then(run, run) as Promise<string>;
    this.execQueue = promise.catch(() => undefined);
    return promise;
  }

  /** Tab completion against a specific shell session's cwd/env. */
  getCompletionsForSession(partial: string, session: LinuxShellSession): string[] {
    if (session.disposed || !this.isPoweredOn) return [];
    const exec = this.executor;
    const baseline = exec.snapshotState();
    exec.swapInSession(session);
    try {
      return this.getCompletions(partial);
    } finally {
      exec.restoreFromSnapshot(baseline);
    }
  }
}
