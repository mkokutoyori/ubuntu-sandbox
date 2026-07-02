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
import type { UserAccountHost, ShellIdentityHost, FileEditorHost } from '../equipment/HostCapabilities';
import type { PathActor } from './linux/VfsPath';
import type { NssHostEntry } from './linux/nss/types';
import { SshConnectionThrottler } from './linux/security/SshConnectionThrottler';
import { HostsFile } from './HostsFile';
import { Port } from '../hardware/Port';
import {
  IPAddress,
  SubnetMask,
  type DeviceType,
  type IPv4Packet,
  type IPv6Address,
  type MACAddress,
} from '../core/types';

// Linux kernel / userspace
import { LinuxCommandExecutor } from './linux/LinuxCommandExecutor';
import { sampleVmstat } from './linux/system/Vmstat';
import { sampleMpstat, mpstatBanner, type MpstatArgs } from './linux/system/Mpstat';
import { sampleIostatCpu, sampleIostatDevices, iostatBanner, type IostatArgs } from './linux/system/Iostat';
import { sampleDstat, type DstatRateState, type PortByteSnapshot } from './linux/system/Dstat';
import {
  sampleCpuRows as samplePidstatCpu,
  sampleMemoryRows as samplePidstatMemory,
  pidstatBanner,
  type PidstatArgs,
} from './linux/system/Pidstat';
import { CronEngine } from './linux/cron/CronEngine';
import { SystemCron } from './linux/cron/SystemCron';
import type { HardwareProfile } from './host/hardware';
import { LinuxShellSession, TtyAllocator } from './linux/shell/LinuxShellSession';
import { SessionWorkQueue } from './host/session/SessionWorkQueue';
import { SessionSwapWindow } from './host/session/SessionSwapWindow';
import type { LinuxProfile } from './linux/LinuxProfile';
import type {
  IpNetworkContext,
  IpInterfaceInfo,
  IpRouteEntry,
  IpNeighborEntry,
  IpXfrmContext,
  IpMonitorObject,
} from './linux/LinuxIpCommand';
import {
  formatIpMonitorLink,
  formatIpMonitorAddr,
  formatIpMonitorRoute,
  formatIpMonitorNeigh,
} from './linux/LinuxIpCommand';
import { DnsService } from './linux/LinuxDnsService';
import { Bind9Service } from './linux/bind9/Bind9Service';
import { ServiceScriptRunner } from './linux/service/ServiceScriptRunner';

import { bindDnsUdpServer, DNS_PORT } from '../dns/transport/DnsUdpTransport';
import { DnsRcode } from '../dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '../dns/wire/DnsMessage';
import { buildLegacyResponseMessage, rrTypeName } from '../dns/compat/DnsWireCompat';
import type { DnsQueryOptions } from '../dns/compat/DnsWireCompat';
import { bindDnsTcpServer, unbindDnsTcpServer } from '../dns/transport/DnsTcpTransport';
import { CrossVendorSshHost } from '../protocols/ssh/server/CrossVendorSshHost';
import { SshdServerConfig } from '../protocols/ssh/server/SshdServerConfig';
import { LinuxUserManagerAuthority } from './linux/network/LinuxUserManagerAuthority';
import type { PacketInfo, LinuxIptablesManager } from './linux/LinuxIptablesManager';

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
import { buildIpCtx } from './linux/commands/net/Ip';
import type { DHCPClient } from '../dhcp/DHCPClient';
import { LinuxSshServerContext } from '../protocols/ssh/server/LinuxSshServerContext';
import { SshServerHandler } from '../protocols/ssh/server/SshServerHandler';
import { probeSshHostKey } from '../protocols/ssh/SshHostKeyProbe';
import { parseSshdConfig, validateSshdConfig } from '../protocols/ssh/server/SshSshdConfig';
import { SshSessionTable } from './linux/network/SshSessionTable';
import { renderWho } from './linux/network/whoFormatter';
import { renderW } from './linux/network/wFormatter';
import { renderLast } from './linux/network/lastFormatter';
import { renderLoginctl } from './linux/network/loginctlFormatter';
import { UtmpSync } from './linux/network/UtmpSync';
import { TcpSocketStateProjection } from './linux/network/TcpSocketStateProjection';
import { TcpdumpCaptureProjection } from './linux/network/TcpdumpCaptureProjection';
import { LogindStateSync } from './linux/network/LogindStateSync';
import { runTcpdump, type TcpdumpDeps } from './linux/network/tcpdump/TcpdumpRunner';
import { decodeEthernetFrame, makeLoopbackIcmpFrame, makeTcpFrame, type CaptureFrame } from './linux/network/tcpdump/CaptureFrame';

/**
 * Minimal sshd-style glob matcher: `*` matches any sequence including
 * the empty string. Anchored on both sides like OpenSSH's `match_pattern`.
 */
function globMatch(pattern: string, candidate: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$').test(candidate);
}

// ─── Class ─────────────────────────────────────────────────────────────

export abstract class LinuxMachine extends EndHost
  implements UserAccountHost, ShellIdentityHost, FileEditorHost {
  protected readonly defaultTTL = 64;

  /** Active profile — describes the "flavor" of this Linux machine. */
  public readonly profile: LinuxProfile;

  /** Kernel services: VFS, users, iptables, services, processes. */
  protected readonly executor: LinuxCommandExecutor;
  /** MaxStartups-style brute-force throttler for inbound SSH. */
  readonly sshThrottler = new SshConnectionThrottler();

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

  public readonly bind9: Bind9Service;

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
    // Defensive copy — LINUX_PC_PROFILE / LINUX_SERVER_PROFILE are
    // module-level singletons; mutating them via setHostname would
    // leak across every device created from the same profile.
    this.profile = { ...profile };

    // 1. Ports
    this.createPortsFromProfile();

    // 2. Kernel / userspace — the executor shares this host's hardware
    //    inventory, lifecycle and system identity so lscpu / free / /proc /
    //    uptime / uname / hostnamectl stay coherent with the device.
    this.executor = new LinuxCommandExecutor(
      profile.isServer, this.hardware, this.lifecycle, this.identity,
    );
    // Wire the socket table before the event bus: the reactive
    // ServicePortProjection created in attachEventBus needs the table.
    this.socketTable.setEphemeralRange(32768, 60999);
    this.tcpv2.setEphemeralRange(32768, 60999);
    this.initDefaultSockets(profile.isServer);
    this.executor.setSocketTable(this.socketTable);
    this.executor.vfs.mkdirp('/proc/sys/net/ipv4', 0o755, 0, 0);
    this.executor.vfs.writeFile('/proc/sys/net/ipv4/ip_local_port_range', '32768\t60999\n', 0, 0, 0o022);
    this.executor.setSessionTable(this.sessionTable);
    this.executor.setTcpProbe((ip, port) => {
      if (ip.includes(':')) return this.tcpProbeSyncIPv6(ip, port);
      return this.tcpProbeSync(new IPAddress(ip), port);
    });
    this.executor.setSshHostKeyProbe((ip, port) =>
      probeSshHostKey(this.tcpv2.connect(ip, port)));
    this.executor.setEphemeralRangeApplier((min, max) => this.tcpv2.setEphemeralRange(min, max));
    this.executor.setEphemeralPoolFreeChecker(() => this.tcpv2.hasFreeEphemeralPort());
    const utmpSync = new UtmpSync(this.executor.vfs);
    utmpSync.bootstrap();
    if (this.executor.lifecycle.bootedAt()) {
      utmpSync.appendRebootMark(this.executor.lifecycle.bootedAt()!);
    }
    this.sessionTable.attachUtmp(utmpSync);
    this.utmpSync = utmpSync;
    this.executor.setUtmpSync(utmpSync);
    const logindSync = new LogindStateSync(this.executor.vfs);
    logindSync.bootstrap();
    this.logindSync = logindSync;
    this.executor.attachEventBus(this.getBus(), this.id);
    // Mirror TcpStack state transitions into the kernel-visible socket
    // table so `ss -tan` / `netstat -tan` show ESTABLISHED → FIN-WAIT →
    // TIME-WAIT during a real handshake/close, and feed the per-device
    // packet log so `tcpdump` shows the SYN/SYN-ACK/ACK/FIN bytes the
    // simulated stack actually exchanges.
    new TcpSocketStateProjection(this.getBus(), this.socketTable, this.id);
    new TcpdumpCaptureProjection(this.getBus(), this.executor.captureLog, this.id);
    this.syncHostnameFiles(profile.hostname);

    // 3. Network façade (closes over protected EndHost members)
    this.net = this.buildNetKernel();
    this.executor.setIpNetworkContext(buildIpCtx(this.net, this.xfrmCtx));
    // NSS `dns` source resolves through real UDP/53 once resolv.conf
    // names a non-loopback server (loopback = systemd-resolved stub,
    // modelled by the legacy fallback).
    this.executor.dnsNss.setWireResolver({
      nameservers: () => {
        const content = this.executor.readFile('/etc/resolv.conf') ?? '';
        return [...content.matchAll(/^\s*nameserver\s+(\S+)/gm)]
          .map(m => m[1])
          .filter(ip => !ip.startsWith('127.'))
          .slice(0, 3);
      },
      query: (serverIp, name, qtype) => {
        try {
          return this.queryDnsServerSync(new IPAddress(serverIp), name, qtype);
        } catch {
          return null;
        }
      },
    });

    // 4. Command registry
    this.commands = new LinuxCommandRegistry();
    this.registerCoreCommands();
    this.registerDeviceCommands();

    // 5. Initialise SSH server config files on first boot:
    //    /etc/ssh/sshd_config + /etc/ssh/ssh_host_ed25519_key(.pub).
    //    Also seed /etc/motd and /etc/issue.net so SSH greeters and the
    //    pre-auth Banner have realistic content.
    this.initSshFiles();

    this.attachSshTcpListeners();
    this.attachProcessSocketReaper();

    // 7. Cron daemon ticker — fires due jobs every simulated minute.
    this.startCronTicker();

    // 8. DNS daemon transport: when dnsmasq starts, listen on UDP 53 so
    //    resolution travels through the simulated network (cables, routing,
    //    firewalls) instead of bypassing it via the Equipment registry.
    this.dnsService.onStart(() => this.bindDnsServerPort());
    this.dnsService.onStop(() => {
      this.udpClose(DNS_PORT);
      unbindDnsTcpServer(this, DNS_PORT);
    });

    this.bind9 = new Bind9Service(this, {
      read: (path) => this.executor.vfs.readFile(path),
      append: (path, content) => {
        const dir = path.slice(0, path.lastIndexOf('/')) || '/';
        if (!this.executor.vfs.exists(dir)) this.executor.vfs.mkdirp(dir, 0o755, 0, 0);
        this.executor.vfs.writeFile(path, content, 0, 0, 0o022, true);
      },
    });
    this.executor.serviceMgr.registerConfigCheck('named', () => this.bind9.checkConfig());
    this.executor.serviceMgr.onLifecycle((event, name) => {
      if (name !== 'named') return;
      if (event === 'start') this.applyBind9(this.bind9.start());
      else if (event === 'restart') this.applyBind9(this.bind9.restart());
      else if (event === 'reload') this.applyBind9(this.bind9.reload());
      else if (event === 'stop') this.bind9.stop();
    });

    this.executor.serviceMgr.onLifecycle((event, name) => {
      if (event === 'start' || event === 'restart') this.startScriptRunner(name);
      else if (event === 'stop') this.stopScriptRunner(name);
    });
  }

  private readonly scriptRunners = new Map<string, ServiceScriptRunner>();

  private startScriptRunner(name: string): void {
    this.stopScriptRunner(name);
    const unit = this.executor.serviceMgr.status(name);
    if (!unit) return;
    const scriptPath = unit.execStart.split(/\s+/)[0];
    if (!scriptPath.startsWith('/')) return;
    const content = this.executor.vfs.readFile(scriptPath);
    if (content === null || !content.startsWith('#!')) return;

    const pid = unit.mainPid;
    const runner = new ServiceScriptRunner({
      readFile: (path) => this.executor.vfs.readFile(path),
      runAsRoot: (command) => Promise.resolve(this.runServiceScript(command)),
      runCondition: async (command) => {
        this.runServiceScript(command);
        return this.executor.lastExitCode === 0;
      },
      emitOutput: (line) =>
        this.executor.logMgr.logService(`${name}.service`, name, line, pid ?? 0),
      stillCurrent: () => {
        const current = this.executor.serviceMgr.status(name);
        return current?.state === 'active' && current.mainPid === pid;
      },
    });
    this.scriptRunners.set(name, runner);
    void runner.start(scriptPath);
  }

  private stopScriptRunner(name: string): void {
    this.scriptRunners.get(name)?.stop();
    this.scriptRunners.delete(name);
  }

  private runServiceScript(command: string): string {
    const um = this.executor.userMgr;
    const prev = { user: um.currentUser, uid: um.currentUid, gid: um.currentGid };
    um.currentUser = 'root';
    um.currentUid = 0;
    um.currentGid = 0;
    try {
      return this.executor.executeWithEnv(command, {}) ?? '';
    } catch {
      return '';
    } finally {
      um.currentUser = prev.user;
      um.currentUid = prev.uid;
      um.currentGid = prev.gid;
    }
  }

  private applyBind9(result: { ok: boolean; error?: string }): void {
    if (!result.ok) {
      this.bind9.stop();
      this.executor.serviceMgr.markFailed('named', result.error ?? 'failed to start');
    }
  }

  // ─── DNS over the wire (server side) ─────────────────────────────────

  private bindDnsServerPort(): void {
    // bindDnsUdpServer supersedes the systemd-resolved stub listener on
    // 127.0.0.53, like real dnsmasq taking over port 53 on Ubuntu.
    try {
      bindDnsUdpServer(this, (query) => this.answerDnsQuery(query), DNS_PORT, 'dnsmasq');
      bindDnsTcpServer(this, (query) => this.answerDnsQuery(query), DNS_PORT);
    } catch { /* port already bound (e.g. service restarted) */ }
  }

  private answerDnsQuery(query: DnsMessage): DnsMessage {
    const question = query.questions[0];
    if (!question) return buildLegacyResponseMessage(query, DnsRcode.FORMERR, []);

    const qtype = rrTypeName(question.qtype as number);
    const answers = this.dnsService.query(question.qname, qtype);

    // NXDOMAIN only when the whole domain is unknown; a known domain with
    // no record of the requested type answers NOERROR with zero answers,
    // like a real authoritative server.
    const rcode = answers.length > 0 || this.dnsService.hasDomain(question.qname)
      ? 'NOERROR'
      : 'NXDOMAIN';
    return buildLegacyResponseMessage(query, rcode, answers);
  }

  private cronTimer: symbol | null = null;
  private _cronEngine: CronEngine | null = null;

  private getCronEngine(): CronEngine {
    if (!this._cronEngine) {
      this._cronEngine = new CronEngine({
        sources: [this.executor.cron, new SystemCron(this.executor.vfs)],
        runner: (command, ctx) => this.runCronJob(command, ctx),
        syslog: (tag, message) => this.executor.logMgr.logDaemon(tag, message),
        deliverMail: (recipient, body) => this.deliverCronMail(recipient, body),
        homeFor: (user) => this.executor.userMgr.getUser(user)?.home ?? (user === 'root' ? '/root' : `/home/${user}`),
        hostname: (this.executor.vfs.readFile('/etc/hostname') ?? this.name).trim(),
        now: () => new Date(),
      });
    }
    return this._cronEngine;
  }

  private startCronTicker(): void {
    if (this.cronTimer !== null) return;
    this.cronTimer = this.hostTimers.setInterval(() => this.cronTick(), 60_000);
    this.cronTick();
  }

  cronTick(at: Date = new Date()): void {
    const engine = this.getCronEngine();
    const active = this.isServiceActive('cron');
    if (active && !engine.isRunning) engine.start();
    else if (!active && engine.isRunning) engine.stop();
    engine.tick(at);
  }

  private runCronJob(command: string, ctx: { user: string; env: Record<string, string> }): { output: string; exitCode: number } {
    const um = this.executor.userMgr;
    const prev = { user: um.currentUser, uid: um.currentUid, gid: um.currentGid, cwd: this.executor.cwd };
    const entry = um.getUser(ctx.user);
    if (entry) {
      um.currentUser = ctx.user;
      um.currentUid = entry.uid;
      um.currentGid = entry.gid;
      this.executor.cwd = entry.home ?? `/home/${ctx.user}`;
    }
    try {
      const output = this.executor.executeWithEnv(command, ctx.env);
      return { output: output ?? '', exitCode: 0 };
    } catch {
      return { output: '', exitCode: 1 };
    } finally {
      um.currentUser = prev.user;
      um.currentUid = prev.uid;
      um.currentGid = prev.gid;
      this.executor.cwd = prev.cwd;
    }
  }

  private deliverCronMail(recipient: string, body: string): void {
    const entry = this.executor.userMgr.getUser(recipient);
    const host = (this.executor.vfs.readFile('/etc/hostname') ?? this.name).trim();
    const envelope = `From cron@${host}  ${new Date().toString()}\n`;
    this.executor.vfs.writeFile(`/var/mail/${recipient}`, envelope + body + '\n', entry?.uid ?? 0, entry?.gid ?? 0, 0o022, true);
  }

  /**
   * Re-spec this host's hardware. Overrides {@link EndHost.setHardware} to
   * also propagate the new profile into the command executor, so `lscpu`,
   * `free`, `nproc` and the procfs stay coherent with `getHardware()` — the
   * executor holds its own reference and would otherwise keep the old spec.
   */
  override setEventBus(bus: import('@/events/EventBus').IEventBus | null): void {
    super.setEventBus(bus);
    this.executor.attachEventBus(this.getBus(), this.id);
  }

  override setHardware(profile: HardwareProfile): void {
    super.setHardware(profile);
    this.executor.setHardware(profile);
  }

  /** Persist SSH server configuration + host key + MOTD on the VFS. */
  private initSshFiles(): void {
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

  private readonly _sshdActivePorts = new Set<number>();

  private sshdPortsFromConfig(): number[] {
    const raw = this.executor.vfs.readFile('/etc/ssh/sshd_config') ?? '';
    const ports = Array.from(raw.matchAll(/^\s*Port\s+(\d+)/gim))
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n) && n > 0 && n < 65536);
    return ports.length ? ports : [22];
  }

  private attachSshTcpListeners(): void {
    const stack = this.getTcpStack();
    const desired = new Set(this.sshdPortsFromConfig());
    for (const port of this._sshdActivePorts) {
      if (!desired.has(port)) {
        stack.closeListener(port, '0.0.0.0');
        this._sshdActivePorts.delete(port);
      }
    }
    const sshdPid = this.socketTable.getAll().find((s) => s.processName === 'sshd')?.pid ?? null;
    for (const port of desired) {
      if (this._sshdActivePorts.has(port)) continue;
      stack.listen(port, {
        onAccept: (socket) => {
          if (sshdPid !== null) stack.setSocketOwner(socket, sshdPid);
          this.getSshServerHandler().register(socket, socket.remoteIp);
        },
      });
      this._sshdActivePorts.add(port);
    }
  }

  private detachSshTcpListeners(): void {
    const stack = this.getTcpStack();
    for (const port of this._sshdActivePorts) {
      stack.closeListener(port, '0.0.0.0');
    }
    this._sshdActivePorts.clear();
  }

  private attachProcessSocketReaper(): void {
    const bus = this.getBus();
    bus.subscribe('linux.process.exited', (e) => {
      const payload = e.payload as { pid: number; comm: string };
      const { pid, comm } = payload;
      const stack = this.getTcpStack();
      const toUnbind: Array<{ protocol: 'tcp' | 'udp'; localAddress: string; localPort: number; state: string }> = [];
      for (const sock of this.socketTable.getAll()) {
        const matchesByPid = sock.pid === pid;
        const matchesByName = comm && sock.processName === comm;
        if (!matchesByPid && !matchesByName) continue;
        toUnbind.push({ protocol: sock.protocol, localAddress: sock.localAddress, localPort: sock.localPort, state: sock.state });
      }
      for (const s of toUnbind) {
        this.socketTable.unbind(s.protocol, s.localAddress, s.localPort);
        if (s.protocol === 'tcp' && s.state === 'LISTEN') {
          stack.closeListener(s.localPort, s.localAddress);
          this._sshdActivePorts.delete(s.localPort);
        }
      }
      stack.abortSocketsOwnedBy(pid);
    });
  }

  // ─── Reactive surface for cross-device commands (ssh, scp, sftp) ─────

  /**
   * Whether the named systemd unit is currently active. The unit must
   * both be in 'active' state AND have a live process backing it — a
   * `kill -9 <mainPid>` outside the supervisor leaves the unit's state
   * stale, so we double-check the process table here.
   */
  isServiceActive(name: string): boolean {
    if (!this.executor.serviceMgr.isActive(name)) return false;
    // For canonical daemons, require the named process to be alive too.
    const knownDaemons: Record<string, string> = {
      ssh: 'sshd', sshd: 'sshd',
      cron: 'cron', rsyslog: 'rsyslogd',
      'systemd-journald': 'systemd-journald',
    };
    const comm = knownDaemons[name];
    if (!comm) return true;
    return this.executor.processMgr.list({ comm }).length > 0;
  }

  /**
   * Login policy check — honours the full sshd_config surface:
   *   - PermitRootLogin no / prohibit-password / yes / forced-commands-only
   *   - DenyUsers patterns (glob *)
   *   - AllowUsers patterns (glob *) — when present, user must match one
   *   - DenyUsers takes precedence over AllowUsers
   */
  sshdAcceptsLogin(user: string, ctx?: { address?: string; host?: string }): { ok: boolean; reason?: string } {
    // Use the live sshd-context-cached snapshot, NOT a fresh re-parse.
    // Real sshd holds its config in memory until SIGHUP / `systemctl
    // reload ssh`; editing /etc/ssh/sshd_config without reloading does
    // not change the policy. The simulator follows the same rule via
    // getSshServerContext() (which is replaced on reload).
    const config = this.getSshServerContext().effectiveSshdServerConfig();

    const policy = config.permitRootLogin;
    if (user === 'root' && policy !== 'yes') {
      return { ok: false, reason: `PermitRootLogin ${policy}` };
    }
    const userGroups = (this.executor.userMgr.getUserGroups?.(user) ?? []).map((g: { name: string }) => g.name);
    if (!config.isUserAllowed(user, userGroups, ctx)) {
      const denied = config.denyUsers.some(p => globMatch(p, user));
      return { ok: false, reason: denied ? 'DenyUsers match' : 'not in AllowUsers' };
    }

    const userEntry = this.executor.userMgr.getUser(user) as
      | { locked?: boolean; expireDate?: number; password?: string }
      | undefined;
    if (!userEntry) return { ok: false, reason: 'no such user' };

    // Locked account: either the userMgr's in-memory flag is on, or
    // /etc/shadow stores "!<hash>" / "!".
    if (userEntry.locked) return { ok: false, reason: 'account locked' };
    if (userEntry.password === '!') return { ok: false, reason: 'no password set' };
    const shadow = this.executor.vfs.readFile('/etc/shadow') ?? '';
    const shadowLine = shadow.split('\n').find(l => l.startsWith(`${user}:`));
    if (shadowLine && /^!/.test(shadowLine.split(':')[1] ?? '')) {
      return { ok: false, reason: 'account locked' };
    }
    // Expired account: userMgr.expireDate in days-since-epoch, or
    // /etc/shadow column 8 in the past.
    const now = Date.now();
    if (userEntry.expireDate !== undefined && userEntry.expireDate > 0) {
      if (userEntry.expireDate * 86_400_000 < now) {
        return { ok: false, reason: 'account expired' };
      }
    }
    if (shadowLine) {
      const expireDays = Number.parseInt(shadowLine.split(':')[7] ?? '', 10);
      if (Number.isFinite(expireDays) && expireDays > 0) {
        if (expireDays * 86_400_000 < now) return { ok: false, reason: 'account expired' };
      }
    }
    return { ok: true };
  }

  /**
   * Append a syslog-style line to /var/log/auth.log on this machine.
   * Used by inbound SSH (this device) to log a login from a remote.
   */
  recordSshLogin(
    user: string,
    fromIp: string,
    fromHost: string,
    accepted: boolean,
    authMethod: 'password' | 'publickey' = 'password',
  ): void {
    const events = this.getSshServerContext().events;
    if (accepted) {
      events.emit({ kind: 'auth_success', user, method: authMethod, ip: fromIp, fromHost, port: 50000 });
    } else {
      events.emit({ kind: 'auth_failure', user, method: authMethod, ip: fromIp, fromHost, port: 50000, reason: 'authentication failure' });
      this.sessionTable.recordFailedLogin(user, fromIp);
    }
    if (accepted) {
      const userEntry = this.executor.userMgr.getUser(user);
      const uid = userEntry?.uid ?? 1000;
      const gid = userEntry?.gid ?? uid;
      this.rememberLastSshLogin(user, fromIp);
      const session = this.sessionTable.open({
        user, uid, sshdPid: 0,
        fromIp, fromHost,
      });
      const sshdMasterPid = this.executor.processMgr.list({ comm: 'sshd' })
        .find((p) => p.ppid === 1)?.pid ?? 1;
      const sshdChild = this.executor.processMgr.spawn({
        command: `sshd: ${user} [priv]`,
        comm: 'sshd',
        user: 'root', uid: 0, gid: 0,
        ppid: sshdMasterPid,
        tty: '?',
      });
      const shell = this.executor.processMgr.spawn({
        command: '-bash',
        comm: '-bash',
        user, uid, gid,
        ppid: sshdChild.pid,
        tty: session.tty,
        cwd: userEntry?.home ?? `/home/${user}`,
      });
      session.sshdPid = sshdChild.pid;
      session.shellPid = shell.pid;
      this.utmpSync?.updateSessionPids(session.tty, shell.pid, sshdChild.pid);
      this.persistLogindSession(session.tty, uid, user, shell.pid, fromIp);
      this.emitSessionOpenedLog(user, uid, sshdChild.pid, String(shell.pid));
      const myIp = this.getPorts()
        .map((p) => p.getIPAddress()?.toString())
        .find((ip): ip is string => !!ip) ?? '0.0.0.0';
      const peerPort = 49152 + (this.sessionTable.list().length * 7) % 16000;
      try {
        this.socketTable.connect(
          'tcp', myIp, 22, fromIp, peerPort,
          sshdChild.pid, 'sshd',
        );
      } catch { /* socket accounting is best-effort */ }
      this.executor.captureLog.captureTcpHandshake(
        { ip: fromIp, port: peerPort },
        { ip: myIp, port: 22 },
      );
    }
  }

  isSshActive(): boolean { return this.isServiceActive('ssh'); }

  private _sshHost: CrossVendorSshHost | null = null;
  private _sshAuthority: LinuxUserManagerAuthority | null = null;

  getSshHost(): CrossVendorSshHost {
    if (!this._sshAuthority) {
      this._sshAuthority = new LinuxUserManagerAuthority({
        executor: this.executor,
        deviceId: this.id,
        hostname: this.hostname,
        recordSshLogin: (u, fromIp, fromHost, accepted, method) =>
          this.recordSshLogin(u, fromIp, fromHost, accepted, method as 'password' | 'publickey'),
      });
    }
    const config = SshdServerConfig.parse(this.executor.vfs.readFile('/etc/ssh/sshd_config') ?? '');
    if (!this._sshHost) {
      this._sshHost = new CrossVendorSshHost({
        deviceId: this.id,
        hostname: this.hostname,
        vendor: 'linux',
        bus: this.getBus(),
        authority: this._sshAuthority,
        config,
        active: this.isSshActive(),
        motd: this.executor.vfs.readFile('/etc/motd') ?? '',
        banner: this.executor.vfs.readFile('/etc/issue.net') ?? '',
      });
    } else {
      this._sshHost.applyConfig(config);
      this._sshHost.setSshActive(this.isSshActive());
      this._sshHost.setHostname(this.hostname);
      this._sshHost.setMotd(this.executor.vfs.readFile('/etc/motd') ?? '');
      this._sshHost.setBanner(this.executor.vfs.readFile('/etc/issue.net') ?? '');
    }
    return this._sshHost;
  }

  sshBanner(): string {
    const issue = this.executor.vfs.readFile('/etc/issue.net') ?? '';
    return issue.replace(/\n*$/, '') || `Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)`;
  }

  async runSshCommand(
    user: string,
    command: string,
  ): Promise<{ output: string; exitCode: number }> {
    const result = this.runSshCommandSync(user, command);
    return result ?? { output: '', exitCode: 0 };
  }


  getSshHostname(): string { return this.hostname; }

  getSshBanner(): string {
    return this.executor.vfs.readFile('/etc/issue.net') ?? '';
  }

  getSshMotd(): string {
    return this.executor.vfs.readFile('/etc/motd') ?? '';
  }

  getSshPolicy(): {
    readonly active: boolean;
    readonly ports: readonly number[];
    readonly permitRootLogin: boolean;
    readonly passwordAuthentication: boolean;
    readonly pubkeyAuthentication: boolean;
    readonly maxAuthTries: number;
    readonly permitEmptyPasswords: boolean;
  } {
    const raw = this.executor.vfs.readFile('/etc/ssh/sshd_config') ?? '';
    const directive = (n: string): string | null => {
      const m = new RegExp(`^\\s*${n}\\s+(\\S+)`, 'im').exec(raw);
      return m ? m[1].toLowerCase() : null;
    };
    const ports = Array.from(raw.matchAll(/^\s*Port\s+(\d+)/gim))
      .map(m => Number(m[1]))
      .filter(n => Number.isFinite(n) && n > 0 && n < 65536);
    return Object.freeze({
      active: this.isSshActive(),
      ports: ports.length ? Object.freeze(ports) : Object.freeze([22]),
      permitRootLogin: directive('PermitRootLogin') !== 'no',
      passwordAuthentication: directive('PasswordAuthentication') !== 'no',
      pubkeyAuthentication: directive('PubkeyAuthentication') !== 'no',
      maxAuthTries: Number(directive('MaxAuthTries') ?? 6),
      permitEmptyPasswords: directive('PermitEmptyPasswords') === 'yes',
    });
  }

  getSshHostKey(): {
    readonly type: 'ssh-rsa' | 'ssh-ed25519' | 'ecdsa-sha2-nistp256';
    readonly fingerprintSha256: string;
    readonly publicKey: string;
  } {
    return Object.freeze({
      type: 'ssh-ed25519' as const,
      fingerprintSha256: `SHA256:linux-${this.id}`,
      publicKey: `ssh-ed25519 AAAA-linux-${this.id}`,
    });
  }

  runSshCommandSync(
    user: string,
    command: string,
  ): { output: string; exitCode: number } | null {
    const um = this.executor.userMgr;
    const previousUser = um.currentUser;
    const previousUid = um.currentUid;
    const previousGid = um.currentGid;
    const previousCwd = this.executor.cwd;
    const userEntry = um.getUser(user);
    if (userEntry) {
      um.currentUser = user;
      um.currentUid = userEntry.uid;
      um.currentGid = userEntry.gid;
      this.executor.cwd = userEntry.home ?? `/home/${user}`;
    }
    try {
      const output = this.executor.execute(command);
      const normalised = output && !output.endsWith('\n') ? `${output}\n` : output;
      return { output: normalised, exitCode: this.executor.lastExitCode ?? 0 };
    } finally {
      um.currentUser = previousUser;
      um.currentUid = previousUid;
      um.currentGid = previousGid;
      this.executor.cwd = previousCwd;
    }
  }

  /** Per-machine SSH session table — backs `w`, `who`, `last`. */
  private utmpSync: UtmpSync | null = null;
  private logindSync: LogindStateSync | null = null;

  getUtmpSync(): UtmpSync | null { return this.utmpSync; }
  getLogindSync(): LogindStateSync | null { return this.logindSync; }

  public readonly sessionTable = (() => {
    const t = new SshSessionTable();
    // Seed the local console session so `who`/`w`/`last` show the
    // currently logged-in user even before any SSH connect happens.
    return t;
  })();

  /**
   * Per-user record of the most recent SUCCESSFUL SSH login. Read by
   * the sshLauncher banner to produce the OpenSSH "Last login: <date>
   * from <ip>" line. The simulator's analogue of `/var/log/lastlog`.
   */
  private readonly lastSshLoginByUser = new Map<string, { at: Date; from: string }>();

  /** sshLauncher contract — returns the previous login for `user` (if any). */
  getLastSshLoginFor(user: string): { at: Date; from: string } | null {
    return this.lastSshLoginByUser.get(user) ?? null;
  }

  /** Push a new last-login entry; called from `recordSshLogin` on accept. */
  private rememberLastSshLogin(user: string, fromIp: string): void {
    this.lastSshLoginByUser.set(user, { at: new Date(), from: fromIp });
  }

  /** Ensure a tty=tty1 console session exists for the local user. */
  private ensureLocalConsoleSession(): void {
    const user = this.executor.userMgr.currentUser;
    const uid = this.executor.userMgr.getUser(user)?.uid ?? 0;
    this.sessionTable.ensureConsoleSession(user, uid);
  }

  /**
   * Match standalone `w` / `who` / `last` invocations and render them
   * from the live session table. Returns null when the command isn't
   * one of them (so the normal pipeline handles it — including compound
   * commands, which the executor renders from the same table).
   */
  private renderSessionView(command: string): string | null {
    const argv = command.split(/\s+/);
    const cmd = argv[0];
    if (cmd === 'w' || cmd === 'who' || cmd === 'last' || cmd === 'loginctl') {
      this.ensureLocalConsoleSession();
    }
    if (cmd === 'w') {
      return renderW({
        table: this.sessionTable,
        utmp: this.utmpSync,
        uptimeSeconds: this.executor.lifecycle.uptimeSeconds(),
        now: new Date(),
      }, argv.slice(1));
    }
    if (cmd === 'who') {
      return renderWho({
        table: this.sessionTable,
        utmp: this.utmpSync,
        currentUser: this.executor.userMgr.currentUser,
        currentTty: 'tty1',
        bootDate: this.executor.lifecycle.bootedAt(),
        now: new Date(),
      }, argv.slice(1));
    }
    if (cmd === 'last') {
      return renderLast({
        table: this.sessionTable,
        utmp: this.utmpSync,
        bootDate: this.executor.lifecycle.bootedAt(),
        now: new Date(),
      }, argv.slice(1));
    }
    if (cmd === 'loginctl') {
      return renderLoginctl({
        table: this.sessionTable,
        utmp: this.utmpSync,
        bootDate: this.executor.lifecycle.bootedAt(),
        now: new Date(),
        action: this.buildLoginctlAction(),
      }, argv.slice(1));
    }
    return null;
  }

  private buildLoginctlAction(): import('./linux/network/loginctlFormatter').LoginctlSessionAction {
    const findSession = (sessionId: string) => {
      const sessions = this.sessionTable.list();
      const idx = sessions.findIndex((s, i) => {
        const pid = s.shellPid ?? s.sshdPid ?? 0;
        const sid = pid > 0 ? String(pid) : String(i + 1);
        return sid === sessionId;
      });
      return idx >= 0 ? sessions[idx] : null;
    };
    const terminateSession = (sessionId: string, signal: 'SIGTERM' | 'SIGHUP' | 'SIGKILL' | 'SIGINT') => {
      const s = findSession(sessionId);
      if (!s) return { ok: false, error: `Failed to terminate session: No session '${sessionId}' known` };
      const sshdPid = s.sshdPid;
      if (s.shellPid) this.executor.processMgr.kill(s.shellPid, signal);
      if (s.sshdPid) this.executor.processMgr.kill(s.sshdPid, signal);
      this.sessionTable.close(s.tty, 'admin');
      this.dropLogindSession(sessionId, s.uid);
      this.emitSessionClosedLog(s.user, sshdPid, sessionId);
      return { ok: true };
    };
    return {
      terminate: (sid) => terminateSession(sid, 'SIGTERM'),
      kill: (sid, signal) => terminateSession(sid, signal),
    };
  }

  private persistLogindSession(
    tty: string, uid: number, user: string, leader: number, fromIp: string,
  ): void {
    if (!this.logindSync) return;
    const sid = String(leader);
    const sessions = this.sessionTable.list();
    const sidsForUser = sessions
      .filter((s) => s.uid === uid)
      .map((s) => String(s.shellPid ?? s.sshdPid ?? 0))
      .filter((s) => s !== '0');
    if (!sidsForUser.includes(sid)) sidsForUser.push(sid);
    this.logindSync.writeSession({
      sid, uid, user, tty,
      leader,
      service: 'sshd',
      remote: fromIp !== '' && fromIp !== ':0',
      remoteHost: fromIp,
      scope: `session-${sid}.scope`,
      classOf: 'user',
      type: 'tty',
      realtimeMicros: Date.now() * 1000,
      monotonicMicros: this.executor.lifecycle.uptimeSeconds() * 1_000_000,
    }, sidsForUser);
  }

  private dropLogindSession(sid: string, uid: number): void {
    if (!this.logindSync) return;
    const remaining = this.sessionTable.list()
      .filter((s) => s.uid === uid)
      .map((s) => String(s.shellPid ?? s.sshdPid ?? 0))
      .filter((s) => s !== '0' && s !== sid);
    this.logindSync.removeSession(sid, uid, remaining);
  }

  private logindPid(): number {
    return this.executor.processMgr.list({ comm: 'systemd-logind' })[0]?.pid ?? 9;
  }

  private emitSessionOpenedLog(user: string, uid: number, sshdPid: number, sid: string): void {
    this.executor.logMgr.logAuth(
      'sshd',
      `pam_unix(sshd:session): session opened for user ${user}(uid=${uid}) by (uid=0)`,
      sshdPid,
      'ssh',
    );
    this.executor.logMgr.logAuth(
      'systemd-logind',
      `New session ${sid} of user ${user}.`,
      this.logindPid(),
      'systemd-logind',
    );
    this.executor.logMgr.logDaemon(
      'systemd',
      `Started Session ${sid} of user ${user}.`,
      1,
      'init.scope',
    );
  }

  private emitSessionClosedLog(user: string, sshdPid: number, sid: string): void {
    this.executor.logMgr.logAuth(
      'sshd',
      `pam_unix(sshd:session): session closed for user ${user}`,
      sshdPid,
      'ssh',
    );
    this.executor.logMgr.logAuth(
      'systemd-logind',
      `Session ${sid} logged out. Waiting for processes to exit.`,
      this.logindPid(),
      'systemd-logind',
    );
    this.executor.logMgr.logAuth(
      'systemd-logind',
      `Removed session ${sid}.`,
      this.logindPid(),
      'systemd-logind',
    );
  }

  // ─── Hostname sync ───────────────────────────────────────────────────

  /**
   * Set this machine's hostname after construction. Updates `/etc/hostname`
   * and `/etc/hosts` so subsequent `hostnamectl`, `uname -n`, ssh banner
   * lines, and auth.log entries all reflect the new value.
   */
  setHostname(hostname: string): void {
    // Keep the Equipment-level field in sync too — getHostname() reads
    // it, and DNS / NSS resolution walks the registry by hostname.
    super.setHostname(hostname);
    (this.profile as { hostname: string }).hostname = hostname;
    this.syncHostnameFiles(hostname);
  }

  protected override onDhcpLeaseConfigured(iface: string): void {
    const lease = this.dhcpClient.getState(iface)?.lease;
    const dns = lease?.dnsServers ?? [];
    if (dns.length === 0) return;
    const lines: string[] = [];
    if (lease?.domainName) lines.push(`search ${lease.domainName}`);
    for (const ip of dns) lines.push(`nameserver ${ip}`);
    this.executor.vfs.writeFile('/etc/resolv.conf', lines.join('\n') + '\n', 0, 0, 0o022);
    if (dns[0]) this.dnsResolverIP = dns[0];
  }

  protected override onDhcpLeaseReleased(iface: string): void {
    void iface;
    this.executor.vfs.writeFile('/etc/resolv.conf', '', 0, 0, 0o022);
    this.dnsResolverIP = '';
  }

  private syncHostnameFiles(hostname: string): void {
    const vfs = this.executor.vfs;
    vfs.writeFile('/etc/hostname', hostname + '\n', 0, 0, 0o022);
    vfs.writeFile(
      '/etc/hosts',
      HostsFile.defaultLinux(hostname).serialize(),
      0, 0, 0o022,
    );
  }

  // ─── Default OS sockets ──────────────────────────────────────────────

  /**
   * Pre-populate the socket table with services that are always running
   * on a freshly booted Linux machine.  The PIDs match the static values
   * used by ps/netstat output so the two are coherent.
   */
  private initDefaultSockets(isServer: boolean): void {
    const sshdBanner = 'SSH-2.0-Sandbox-Server\r\n';
    this.socketTable.bind('tcp', '0.0.0.0', 22, 985, 'sshd', sshdBanner);
    this.socketTable.bind('tcp', '::', 22, 985, 'sshd', sshdBanner);
    this.socketTable.bind('udp', '127.0.0.53', 53, 540, 'systemd-resolved');

    if (isServer) {
      const tnsBanner = '(CONNECT_DATA=(SERVICE_NAME=ORCL))\r\n';
      this.socketTable.bind('tcp', '0.0.0.0', 1521, 2001, 'tnslsnr', tnsBanner);
      this.socketTable.bind('tcp', '::', 1521, 2001, 'tnslsnr', tnsBanner);
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
      bind9: this.bind9,
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
    // systemd's ExecReload tests the config (`sshd -t`) before applying it:
    // register that pre-check so a malformed sshd_config aborts the reload.
    this.executor.serviceMgr.registerConfigCheck('ssh', () => {
      const raw = this.executor.vfs.readFile('/etc/ssh/sshd_config') ?? '';
      const verdict = validateSshdConfig(raw);
      return verdict.ok
        ? { ok: true }
        : { ok: false, error: verdict.errors.join('\n') };
    });
    const isSsh = (p: { name: string }): boolean => p.name === 'ssh' || p.name === 'sshd';
    const reload = (): void => {
      this._sshContext = this._sshContext?.reloadConfig() ?? null;
    };
    const offRestart = bus.subscribeWhere('linux.service.restarted', isSsh, reload);
    const offReload = bus.subscribeWhere('linux.service.reloaded', isSsh, reload);
    const rebindPorts = (): void => {
      for (const sock of this.socketTable.getAll().filter(s => s.processName === 'sshd')) {
        this.socketTable.unbind('tcp', sock.localAddress, sock.localPort);
      }
      const sshdBanner = 'SSH-2.0-Sandbox-Server\r\n';
      for (const p of this.sshdPortsFromConfig()) {
        try { this.socketTable.bind('tcp', '0.0.0.0', p, 985, 'sshd', sshdBanner); } catch { /* already bound */ }
        try { this.socketTable.bind('tcp', '::', p, 985, 'sshd', sshdBanner); } catch { /* already bound */ }
      }
      this.attachSshTcpListeners();
    };
    const offStopped = bus.subscribeWhere('linux.service.stopped', isSsh, () => {
      for (const sock of this.socketTable.getAll().filter(s => s.processName === 'sshd')) {
        this.socketTable.unbind('tcp', sock.localAddress, sock.localPort);
      }
      this.detachSshTcpListeners();
    });
    const offStarted = bus.subscribeWhere('linux.service.started', isSsh, rebindPorts);
    const offReloadPorts = bus.subscribeWhere('linux.service.reloaded', isSsh, rebindPorts);
    const offRestartPorts = bus.subscribeWhere('linux.service.restarted', isSsh, rebindPorts);
    this._sshLifecycleOff = () => { offRestart(); offReload(); offStopped(); offStarted(); offReloadPorts(); offRestartPorts(); };
    (this.executor as unknown as { sshContextForFail2ban?: (() => { bannedIps(): string[]; totalAuthFailures(): number }) | null })
      .sshContextForFail2ban = () => this.getSshServerContext();
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
    if (input.includes('/var/lib/dhcp/')) return true;
    const words = input.split(/[\s;|&"'`()]+/);
    return words.some(w =>
      w === 'iptables' || w === 'iptables-save' || w === 'iptables-restore' ||
      w === 'ip6tables' || w === 'ip6tables-save' || w === 'ip6tables-restore' ||
      w === 'ps' || w === 'man',
    );
  }

  private async runShellScript(script: string): Promise<string> {
    const collected: Array<{ line: string; runAs?: string }> = [];
    const skipBuiltins = new Set(['wait', 'jobs', 'bg', 'disown']);
    let pendingUser: string | undefined;
    const collect = (argv: string[]): { output: string; exitCode: number } => {
      if (argv.length === 0) return { output: '', exitCode: 0 };
      if (skipBuiltins.has(argv[0])) return { output: '', exitCode: 0 };
      const innerScript = LinuxMachine.extractInlineScript(argv);
      if (innerScript !== null) {
        this.executor.runScriptWithCollector(innerScript, collect);
        return { output: '', exitCode: 0 };
      }
      const suInner = LinuxMachine.extractSuCommand(argv);
      if (suInner !== null) {
        const prev = pendingUser;
        pendingUser = suInner.user;
        this.executor.runScriptWithCollector(suInner.script, collect);
        pendingUser = prev;
        return { output: '', exitCode: 0 };
      }
      const innerArgv = LinuxMachine.unwrapTransparentPrefix(argv);
      if (innerArgv !== null && innerArgv.length > 0) {
        return collect(innerArgv);
      }
      collected.push({ line: LinuxMachine.quoteArgv(argv), runAs: pendingUser });
      return { output: '', exitCode: 0 };
    };
    this.executor.runScriptWithCollector(script, collect);

    const outputs: string[] = [];
    for (const item of collected) {
      const out = item.runAs
        ? await this.executor.runAsUser(item.runAs, () => this.executeCommand(item.line))
        : await this.executeCommand(item.line);
      if (out) outputs.push(out);
    }
    return outputs.join('\n');
  }

  private static extractInlineScript(argv: string[]): string | null {
    if (argv[0] !== 'bash' && argv[0] !== 'sh') return null;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith('-') || a === '-') break;
      if (a.includes('c')) return argv[i + 1] ?? null;
    }
    return null;
  }

  private static extractSuCommand(argv: string[]): { user: string; script: string } | null {
    if (argv[0] !== 'su') return null;
    let user = 'root';
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-' || a === '-l' || a === '--login') continue;
      if (a === '-c' || a === '--command') {
        const script = argv[i + 1];
        return script !== undefined ? { user, script } : null;
      }
      if (!a.startsWith('-')) user = a;
    }
    return null;
  }

  private static unwrapTransparentPrefix(argv: string[]): string[] | null {
    const head = argv[0];
    if (head === 'nohup' || head === 'setsid') {
      return argv.slice(1);
    }
    if (head === 'timeout') {
      let i = 1;
      while (i < argv.length && argv[i].startsWith('-')) {
        if (argv[i] === '-s' || argv[i] === '-k' || argv[i] === '--signal' || argv[i] === '--kill-after') i += 2;
        else i++;
      }
      if (i >= argv.length) return null;
      return argv.slice(i + 1);
    }
    if (head === 'nice') {
      let i = 1;
      if (argv[i] === '-n' || argv[i] === '--adjustment') i += 2;
      else if (argv[i]?.startsWith('-')) i++;
      return argv.slice(i);
    }
    if (head === 'env') {
      let i = 1;
      while (i < argv.length) {
        const a = argv[i];
        if (a === '-i' || a === '--ignore-environment' || a === '-') { i++; continue; }
        if (a === '-u' || a === '--unset') { i += 2; continue; }
        if (a.startsWith('-')) { i++; continue; }
        if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(a)) { i++; continue; }
        break;
      }
      return i < argv.length ? argv.slice(i) : null;
    }
    return null;
  }

  private static quoteArgv(argv: string[]): string {
    return argv.map((a) => /[\s'"\\$`]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a).join(' ');
  }

  private hasShellConstructs(input: string): boolean {
    if (/(^|\s|;|\||&)(for|while|until|if|case|select)\s/.test(input)) return true;
    if (/(^|\s|;|\|)(do|done|then|fi|esac)(\s|$|;)/.test(input)) return true;
    if (/\{[^{}]*\.\.[^{}]*\}/.test(input)) return true;
    if (/\$\{[A-Za-z_]/.test(input)) return true;
    if (/\$[A-Za-z_]\w*/.test(input)) return true;
    if (/\$\(/.test(input)) return true;
    if (/\n/.test(input.trim())) return true;
    if (/(^|\s)wait(\s|;|$)/.test(input)) return true;
    if (/(^|\s|;|\||&)(bash|sh)(\s+-[a-zA-Z]*c\b|\s+-[a-zA-Z]*c$)/.test(input)) return true;
    if (/^\s*(timeout|env|nohup|setsid|nice)\s/.test(input)) return true;
    if (/^\s*su\s+([^\s]+\s+)?-[a-zA-Z]*c\b/.test(input)) return true;
    return false;
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
  async executeCommand(command: string, stdin?: string): Promise<string> {
    if (!this.isPoweredOn) return 'Device is powered off';
    if (stdin !== undefined) {
      (this.executor as unknown as { _scenarioStdin?: string })._scenarioStdin = stdin;
    }

    const trimmed = command.trim();
    if (!trimmed) return '';

    // Session-table views (`w`, `who`, `last`) override the legacy
    // user-manager output because the session table is the live truth.
    const sessionView = this.renderSessionView(trimmed);
    if (sessionView !== null) return sessionView;

    if (this.isTcpdumpCommand(trimmed)) {
      return this.runTcpdumpCommand(trimmed);
    }

    if (!this.containsNetworkCommand(trimmed)) {
      return this.executor.execute(trimmed);
    }

    if (this.hasShellConstructs(trimmed)) {
      return this.runShellScript(trimmed);
    }

    // Compound commands: split on a top-level `;` and recurse. Quoted
    // separators (e.g. inside `sh -c "a; b"`) are left intact.
    const semiParts = LinuxMachine.splitTopLevel(trimmed, ';')
      .map(s => s.trim())
      .filter(Boolean);
    if (semiParts.length > 1) {
      const outputs: string[] = [];
      for (const p of semiParts) {
        const out = await this.executeCommand(p);
        if (out) outputs.push(out);
      }
      return outputs.join('\n');
    }

    const logical = LinuxMachine.splitLogical(trimmed);
    if (logical.length > 1) {
      const outputs: string[] = [];
      let lastOk = true;
      for (const seg of logical) {
        const shouldRun = seg.op === 'first' ||
          (seg.op === '&&' && lastOk) ||
          (seg.op === '||' && !lastOk);
        if (!shouldRun) continue;
        const cmdStr = seg.cmd.trim();
        if (!cmdStr) continue;
        const out = await this.executeCommand(cmdStr);
        if (out) outputs.push(out);
        lastOk = !this.isFailureOutput(out, cmdStr);
      }
      return outputs.join('\n');
    }

    // Piped command: route the head through the network dispatcher,
    // then apply the remaining text filters through the bash interpreter.
    // Only a top-level `|` (outside quotes) counts as a pipe.
    if (LinuxMachine.splitTopLevel(trimmed, '|').length > 1) {
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
  /**
   * Split a command line on a top-level separator, ignoring occurrences
   * inside single or double quotes so that `sh -c "a; b | c"` is treated
   * as one command rather than being torn apart by the shell router.
   */
  private static splitLogical(input: string): Array<{ cmd: string; op: 'first' | '&&' | '||' }> {
    const segments: Array<{ cmd: string; op: 'first' | '&&' | '||' }> = [];
    let buf = '';
    let quote: '"' | "'" | null = null;
    let currentOp: 'first' | '&&' | '||' = 'first';
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (quote) {
        if (ch === quote) quote = null;
        buf += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
      if (ch === '&' && input[i + 1] === '&') {
        segments.push({ cmd: buf, op: currentOp });
        currentOp = '&&'; buf = ''; i++; continue;
      }
      if (ch === '|' && input[i + 1] === '|') {
        segments.push({ cmd: buf, op: currentOp });
        currentOp = '||'; buf = ''; i++; continue;
      }
      buf += ch;
    }
    segments.push({ cmd: buf, op: currentOp });
    return segments;
  }

  private isFailureOutput(output: string, cmd: string): boolean {
    if (!output) return false;
    const head = cmd.split(/\s+/)[0];
    if (head === 'ping' || head === 'ping6') {
      if (/100% packet loss/.test(output)) return true;
      if (/Name or service not known|unknown host|Permission denied|invalid argument/i.test(output)) return true;
      return false;
    }
    if (head === 'traceroute') {
      if (/unknown host|invalid argument|Permission denied/i.test(output)) return true;
      return false;
    }
    return false;
  }

  private static splitTopLevel(input: string, sep: ';' | '|'): string[] {
    const parts: string[] = [];
    let buf = '';
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (quote) {
        if (ch === quote) quote = null;
        buf += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
      if (ch === sep) {
        // `||` is the logical OR operator, not a pipe separator.
        if (sep === '|' && (input[i + 1] === '|' || input[i - 1] === '|')) {
          buf += ch;
          continue;
        }
        parts.push(buf);
        buf = '';
        continue;
      }
      buf += ch;
    }
    parts.push(buf);
    return parts;
  }

  private async tryNetworkCommand(input: string): Promise<string | null> {
    const noSudo = input.startsWith('sudo ') ? input.slice(5).trim() : input;
    const firstCmd = noSudo.split(/[\s|;&]/)[0];
    if (firstCmd) this.executor.setCommandHead(firstCmd);

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
        if (noSudo.includes('>')) return null;
        return this.executor.iptables.executeSave();
      }
      case 'iptables-restore': {
        return null;
      }
      case 'ip6tables': {
        const iptArgs = LinuxMachine.tokenizeArgs(noSudo).slice(1);
        return this.executor.ip6tables.execute(iptArgs).output;
      }
      case 'ip6tables-save': {
        if (noSudo.includes('>')) return null;
        return this.executor.ip6tables.executeSave();
      }
      case 'ip6tables-restore': {
        return null;
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

  private async resolveHostnameOverWire(name: string): Promise<IPAddress | null> {
    try { return new IPAddress(name); } catch { void 0; }

    const r = this.executor.nss.lookup<NssHostEntry[]>(
      'hosts', s => s.gethostbyname?.(name, 2),
    );
    if (r.status === 'SUCCESS' && r.entry) {
      for (const h of r.entry) {
        if (h.addressFamily !== 2) continue;
        try { return new IPAddress(h.address); } catch { void 0; }
      }
    }
    return null;
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
        if (!port) return;
        const ip = port.getIPAddress();
        const cidr = port.getSubnetMask()?.toCIDR() ?? 0;
        port.clearIP();
        if (ip) self.getBus().publish({ topic: 'host.address.changed', payload: { ...self.hostRef(), iface: name, ip: ip.toString(), cidr, added: false } });
      },
      setInterfaceAdmin(name: string, enabled: boolean): void {
        const port = self.ports.get(name);
        if (!port) return;
        port.setUp(enabled);
        self.getBus().publish({ topic: 'host.link.state-changed', payload: { ...self.hostRef(), iface: name, up: enabled } });
      },
      isDHCPConfigured(name: string): boolean {
        return self.isDHCPConfigured(name);
      },
      getRoutingTable(): HostRouteEntry[] {
        return self.getRoutingTable();
      },
      getIPv6RoutingTable() {
        return self.getIPv6RoutingTable();
      },
      addStaticRoute(network: IPAddress, mask: SubnetMask, gw: IPAddress, metric?: number): boolean {
        return self.addStaticRoute(network, mask, gw, metric ?? 100);
      },
      addDeviceRoute(network: IPAddress, mask: SubnetMask, iface: string, metric?: number): boolean {
        return self.addDeviceRoute(network, mask, iface, metric ?? 0);
      },
      removeRoute(
        network: IPAddress,
        mask: SubnetMask,
        filter?: { nextHop?: IPAddress | null; metric?: number },
      ): boolean {
        return self.removeRoute(network, mask, filter);
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
      addStaticARP(ip: IPAddress, mac: MACAddress, iface: string): void {
        self.addStaticARP(ip, mac, iface);
      },
      deleteARP(ip: IPAddress): boolean {
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
      tcpProbe(target: string, port: number): boolean {
        if (target.includes(':')) return self.tcpProbeSyncIPv6(target, port);
        return self.tcpProbeSync(new IPAddress(target), port);
      },
      tcpConnectOutcome(target: string, port: number): 'open' | 'refused' | 'timeout' {
        return self.tcpConnectOutcome(new IPAddress(target), port);
      },
      ping6Sequence(
        target: IPv6Address,
        count: number,
        timeoutMs = 2000,
      ): Promise<PingResult[]> {
        return self.executePing6Sequence(target, count, timeoutMs);
      },
      async traceroute(target: IPAddress, maxHops?: number, probesPerHop?: number, firstTtl?: number, timeoutMs?: number): Promise<TracerouteHop[]> {
        const hops = await self.executeTraceroute(target, maxHops, timeoutMs ?? 2000, probesPerHop, firstTtl);
        return hops as TracerouteHop[];
      },
      sendUdpProbe(target: IPAddress, destinationPort: number, sourcePort: number): boolean {
        return self.sendUdpDatagram(target, destinationPort, sourcePort, null, 0);
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
      resolveHostname(name: string): Promise<IPAddress | null> {
        return self.resolveHostnameOverWire(name);
      },
      async queryDns(
        serverIP: string, name: string, qtype: string,
        timeoutMs?: number, options?: DnsQueryOptions,
      ) {
        let server: IPAddress;
        try { server = new IPAddress(serverIP); } catch { return null; }
        return self.queryDnsServer(server, name, qtype, timeoutMs, options);
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
    return this.runFilterTable(this.executor.iptables, {
      direction,
      protocol: ipPkt.protocol,
      srcIP: ipPkt.sourceIP.toString(),
      dstIP: ipPkt.destinationIP.toString(),
      srcPort: ports.srcPort,
      dstPort: ports.dstPort,
      iface: portName,
      outIface: outPortName,
    });
  }

  protected override firewallFilter6(
    portName: string,
    ipv6Pkt: import('../core/types').IPv6Packet,
    direction: 'in' | 'out' | 'forward',
    outPortName?: string,
  ): 'accept' | 'drop' | 'reject' {
    const transport = ipv6Pkt.payload as { sourcePort?: number; destinationPort?: number } | undefined;
    return this.runFilterTable(this.executor.ip6tables, {
      direction,
      protocol: ipv6Pkt.nextHeader,
      srcIP: ipv6Pkt.sourceIP.toString(),
      dstIP: ipv6Pkt.destinationIP.toString(),
      srcPort: transport?.sourcePort ?? 0,
      dstPort: transport?.destinationPort ?? 0,
      iface: portName,
      outIface: outPortName,
    });
  }

  private runFilterTable(
    manager: LinuxIptablesManager, pkt: PacketInfo,
  ): 'accept' | 'drop' | 'reject' {
    const verdict = manager.filterPacket(pkt);
    if (verdict !== 'accept') {
      this.logIptablesDrop(pkt, verdict, pkt.iface, pkt.outIface);
      this.getBus().publish({
        topic: 'linux.firewall.drop',
        payload: {
          deviceId: this.id, hostname: this.hostname,
          inIface: pkt.iface, outIface: pkt.outIface,
          sourceIp: pkt.srcIP, destinationIp: pkt.dstIP,
          sourcePort: pkt.srcPort, destinationPort: pkt.dstPort,
          protocol: pkt.protocol === 6 ? 'TCP'
                  : pkt.protocol === 17 ? 'UDP'
                  : pkt.protocol === 1 ? 'ICMP' : String(pkt.protocol),
          verdict, chain: pkt.direction === 'in' ? 'INPUT'
                       : pkt.direction === 'out' ? 'OUTPUT' : 'FORWARD',
        },
      });
    }
    return verdict;
  }

  /**
   * Would an inbound TCP connection to `dstPort` from `srcIP` survive the
   * INPUT firewall chain? Lets in-network service clients (e.g. the
   * Oracle Net listener path, which resolves to the target database by
   * reference rather than forging a SYN packet) still honour iptables —
   * exactly like a real host where `-A INPUT -p tcp --dport 1521 -j DROP`
   * makes the listener unreachable. A DROP looks like a dead port
   * (timeout); a REJECT actively refuses the connection.
   */
  firewallAcceptsInboundTcp(srcIP: string, dstIP: string, dstPort: number): 'accept' | 'drop' | 'reject' {
    // The ingress interface is the one that owns the targeted address, so
    // `-i <iface>` rules match the way they would for a real SYN.
    const ownPort = this.getPorts().find((p) => p.getIPAddress()?.toString() === dstIP);
    const iface = ownPort?.getName() ?? this.getPorts()[0]?.getName() ?? '';
    return this.executor.iptables.filterPacket({
      direction: 'in', protocol: 6, srcIP, dstIP, srcPort: 0, dstPort, iface,
    });
  }

  /**
   * Emit a syslog record at an arbitrary `facility.priority` spec — the
   * host-side hook used by the Oracle audit→syslog bridge when
   * AUDIT_SYSLOG_LEVEL is configured, so audit records land in
   * `/var/log/syslog` like a real database with that parameter set.
   * Returns false when the spec is malformed.
   */
  logSyslog(facilityPrioritySpec: string, tag: string, message: string): boolean {
    return this.executor.logMgr.logAt(facilityPrioritySpec, tag, message);
  }

  private logIptablesDrop(
    pkt: PacketInfo,
    verdict: 'drop' | 'reject',
    inIface: string,
    outIface?: string,
  ): void {
    const proto = pkt.protocol === 6 ? 'TCP'
                : pkt.protocol === 17 ? 'UDP'
                : pkt.protocol === 1 ? 'ICMP'
                : String(pkt.protocol);
    const portFields = (pkt.srcPort || pkt.dstPort)
      ? ` SPT=${pkt.srcPort ?? 0} DPT=${pkt.dstPort ?? 0}`
      : '';
    const tag = verdict === 'reject' ? '[netfilter REJECT]' : '[netfilter DROP]';
    this.executor.logMgr.logKernel(
      'netfilter',
      `${tag} IN=${inIface} OUT=${outIface ?? ''} SRC=${pkt.srcIP} DST=${pkt.dstIP} PROTO=${proto}${portFields}`,
    );
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

    // Commands living in the LinuxCommandRegistry (route/ifconfig/ss/nc/...)
    // never reach LinuxCommandExecutor's switch anymore. Synchronous ones
    // (run() returning a bare string, not a Promise) still work from this
    // bypass path; genuinely async commands (ping, traceroute, dhclient)
    // cannot — same limitation they already had once migrated.
    const head = trimmed.split(/\s+/)[0];
    const cmd = this.commands.get(head);
    if (cmd && cmd.needsNetworkContext) {
      const args = trimmed.split(/\s+/).slice(1);
      const result = cmd.run(this.buildCommandContext(), args);
      if (typeof result === 'string') return result;
    }

    return this.executor.execute(trimmed);
  }

  writeFileFromEditor(path: string, content: string): boolean {
    const absPath = this.executor.vfs.normalizePath(path, this.executor.getCwd());
    const uid = this.executor.getCurrentUid();
    const gid = uid === 0 ? 0 : 1000;
    return this.executor.vfs.writeFile(absPath, content, uid, gid, 0o022);
  }

  installSystemFile(path: string, content: string, uid = 0, gid = 0): boolean {
    const absPath = this.executor.vfs.normalizePath(path, this.executor.getCwd());
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

  // ─── Oracle server-side file I/O (OS user `oracle`, host DAC) ─────────
  //
  // The Oracle instance reads and writes host files through its server
  // process, which runs as the `oracle` OS user — UTL_FILE, external
  // tables, BFILE, Data Pump and CREATE PFILE/SPFILE all go through these
  // hooks. Unlike the editor pass-throughs above (which run with the
  // interactive shell's identity and skip permission checks), these honour
  // host DAC as the `oracle` user, so a file that user cannot access
  // (e.g. root-owned mode 0600) is denied exactly as on a real server.

  /** PathActor for the provisioned `oracle` OS user (falls back to the
   *  canonical 54321:54321 identity when the account is not yet created). */
  private oracleOsActor(): PathActor {
    const u = this.executor.userMgr.getUser('oracle');
    const groups = this.executor.userMgr.getUserGroups('oracle');
    return {
      uid: u?.uid ?? 54321,
      gid: u?.gid ?? 54321,
      gids: groups.map((g) => g.gid),
      user: 'oracle',
      groupNames: groups.map((g) => g.name),
    };
  }

  /** DAC-checked read as `oracle`; null on absence OR permission denied. */
  readFileAsOracle(path: string): string | null {
    const abs = this.executor.vfs.normalizePath(path, this.executor.getCwd());
    const p = this.executor.vfs.path(abs, '/', this.oracleOsActor());
    if (!p.isFile()) return null;
    // Opening a file needs search (x) on its directory and read (r) on it.
    if (!p.parent().canExecute() || !p.canRead()) return null;
    return this.executor.vfs.readFile(abs);
  }

  /** DAC-checked write as `oracle`; the created file is owned oracle:oinstall. */
  writeFileAsOracle(path: string, content: string): boolean {
    const abs = this.executor.vfs.normalizePath(path, this.executor.getCwd());
    const a = this.oracleOsActor();
    const p = this.executor.vfs.path(abs, '/', a);
    if (p.isFile()) {
      // Overwriting an existing file needs write on the file itself.
      if (!p.canWrite()) return false;
    } else if (p.exists()) {
      return false; // a directory / special file — not a UTL_FILE target
    } else {
      // Creating: need write+search on the containing directory. (vfs.writeFile
      // does not re-check the parent on create, so enforce it here.)
      const parent = p.parent();
      if (!parent.isDirectory() || !parent.canWrite() || !parent.canExecute()) return false;
    }
    return this.executor.vfs.writeFile(abs, content, a.uid, a.gid, 0o022);
  }

  /** DAC-checked unlink as `oracle`; needs write+search on the directory. */
  removeFileAsOracle(path: string): boolean {
    const abs = this.executor.vfs.normalizePath(path, this.executor.getCwd());
    const p = this.executor.vfs.path(abs, '/', this.oracleOsActor());
    if (!p.lexists()) return false;
    const parent = p.parent();
    if (!parent.canWrite() || !parent.canExecute()) return false;
    return this.executor.vfs.deleteFile(abs);
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
      listener?: {
        processName: string;
        daemonCommand?: string;
        sockets: { port: number; protocol: 'tcp' | 'udp'; address?: string }[];
      };
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
    // Declare the unit's sockets/daemon BEFORE the reload so the scan
    // stamps them and the port projection binds/unbinds them on
    // start/stop — netstat/ss/ps stay coherent with the service state.
    if (spec.listener) mgr.registerServiceListener(spec.name, spec.listener);
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
  private readonly sessionQueue = new SessionWorkQueue();

  /** Swap-window over the executor's per-process state (shared protocol). */
  private _sessionSwap:
    | SessionSwapWindow<LinuxShellSession, ReturnType<LinuxCommandExecutor['snapshotState']>>
    | null = null;

  private get sessionSwap(): SessionSwapWindow<LinuxShellSession, ReturnType<LinuxCommandExecutor['snapshotState']>> {
    if (!this._sessionSwap) {
      this._sessionSwap = new SessionSwapWindow({
        snapshot: () => this.executor.snapshotState(),
        swapIn: (s) => this.executor.swapInSession(s),
        captureInto: (s) => this.executor.captureStateInto(s),
        restore: (b) => this.executor.restoreFromSnapshot(b),
      });
    }
    return this._sessionSwap;
  }

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
    // Chain on the per-device queue: subsequent commands wait their turn.
    return this.sessionQueue.run(async () => {
      if (!this.isPoweredOn) return 'Device is powered off';
      if (session.disposed) return '';
      return this.sessionSwap.within(session, async () => {
        this.executor.displayColor = true;
        try {
          return await this.executeCommand(command);
        } finally {
          this.executor.displayColor = false;
        }
      });
    });
  }

  /**
   * Open a `tail -f` / `tail -F` follow stream against the given shell
   * session's cwd. The handle's VFS subscriptions persist after the
   * session-state restore — once paths are resolved at attach time, the
   * stream lives on the filesystem listener registry independent of any
   * executor swap-in. Returns `null` when `commandLine` is not a follow
   * tail; the caller should then fall back to the normal command path.
   */
  startTailFollowInSession(
    commandLine: string,
    session: LinuxShellSession,
    sink: import('./linux/coreutils').TailSink,
  ): import('./linux/coreutils').TailFollowHandle | null {
    if (!this.isPoweredOn) return null;
    if (session.disposed) return null;
    return this.sessionSwap.withinSync(
      session,
      () => this.executor.startTailFollow(commandLine, sink),
      { capture: false },
    );
  }

  runCommandFrameInSession(commandLine: string, session: LinuxShellSession): string {
    if (!this.isPoweredOn || session.disposed) return '';
    return this.executor.executeInSession(commandLine, session);
  }

  subscribeCapture(listener: (pkt: import('./linux/network/PacketCaptureLog').CapturedPacket) => void): () => void {
    return this.executor.captureLog.subscribe(listener);
  }

  private isTcpdumpCommand(command: string): boolean {
    const noSudo = command.startsWith('sudo ') ? command.slice(5).trim() : command;
    if (LinuxMachine.splitTopLevel(noSudo, '|').length > 1) return false;
    return noSudo.split(/\s+/)[0] === 'tcpdump';
  }

  private async runTcpdumpCommand(command: string): Promise<string> {
    const noSudo = command.startsWith('sudo ') ? command.slice(5).trim() : command;
    const tokens = LinuxMachine.tokenizeArgs(noSudo).slice(1);
    return runTcpdump(tokens, this.buildTcpdumpDeps());
  }

  private buildTcpdumpDeps(): TcpdumpDeps {
    const self = this;
    return {
      interfaceNames(): string[] {
        return ['lo', ...self.ports.keys()];
      },
      interfaceExists(name: string): boolean {
        return name === 'lo' || self.ports.has(name);
      },
      interfaceUp(name: string): boolean {
        if (name === 'lo') return true;
        return self.ports.get(name)?.getIsUp() ?? false;
      },
      openCapture(iface: string, sink: (frame: CaptureFrame) => void): () => void {
        return self.openTcpdumpCapture(iface, sink);
      },
      now(): Date {
        return new Date();
      },
      delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
      },
      readFile(path: string): string | null {
        const v = self.executor.vfs.readFile(self.executor.vfs.normalizePath(path, self.executor.cwd));
        if (v != null) return v;
        const cap = self.executor.captureLog.all();
        if (cap.length === 0) return null;
        const fakeFrames = cap.map(pkt => ({
          ...makeTcpFrame(pkt, 'eth0'),
          payload: pkt.payload ? Array.from(pkt.payload) : undefined,
        }));
        return `TCPDUMPSIM1\n${JSON.stringify(fakeFrames)}`;
      },
      writeFile(path: string, content: string): boolean {
        const abs = self.executor.vfs.normalizePath(path, self.executor.cwd);
        return self.executor.vfs.writeFile(abs, content, 0, 0, 0o022);
      },
      dirWritable(path: string): boolean {
        const abs = self.executor.vfs.normalizePath(path, self.executor.cwd);
        const dir = abs.slice(0, abs.lastIndexOf('/')) || '/';
        return self.executor.vfs.exists(dir) && !dir.startsWith('/sys') && !dir.startsWith('/proc');
      },
    };
  }

  openTcpdumpCapture(iface: string, sink: (frame: CaptureFrame) => void): () => void {
    const bus = this.getBus();
    const id = this.id;
    const unsubs: Array<() => void> = [];
    const wantPort = iface !== 'lo';
    const wantLoopback = iface === 'lo' || iface === 'any';

    if (wantPort) {
      const match = (p: { deviceId: string; portName: string }) =>
        p.deviceId === id && (iface === 'any' || p.portName === iface);
      unsubs.push(bus.subscribeWhere('port.frame.received', match,
        (e) => sink(decodeEthernetFrame(e.payload.frame, e.payload.portName, 'in', new Date()))));
      unsubs.push(bus.subscribeWhere('port.frame.tx-requested', match,
        (e) => sink(decodeEthernetFrame(e.payload.frame, e.payload.portName, 'out', new Date()))));
    }

    if (wantLoopback) {
      const accept = (toIp: string) => iface === 'lo' || toIp.startsWith('127.');
      unsubs.push(bus.subscribeWhere('host.icmp.echo-sent',
        (p) => p.deviceId === id && accept(p.toIp),
        (e) => sink(makeLoopbackIcmpFrame(e.payload.fromIp, e.payload.toIp, e.payload.id, e.payload.seq, e.payload.ttl, 56, 'echo-request', new Date()))));
      unsubs.push(bus.subscribeWhere('host.icmp.echo-reply',
        (p) => p.deviceId === id && accept(p.toIp),
        (e) => sink(makeLoopbackIcmpFrame(e.payload.fromIp, e.payload.toIp, e.payload.id, e.payload.seq, e.payload.ttl, 56, 'echo-reply', new Date()))));
    }

    const tcpIface = iface === 'any' ? 'eth0' : iface;
    for (const pkt of this.executor.captureLog.all()) sink(makeTcpFrame(pkt, tcpIface));
    unsubs.push(this.subscribeCapture((pkt) => sink(makeTcpFrame(pkt, tcpIface))));

    return () => { for (const u of unsubs) u(); };
  }

  crontabEditTemplate(user: string): string {
    const existing = this.executor.cron.list(user);
    if (existing && existing.trim().length > 0) {
      return existing.endsWith('\n') ? existing : existing + '\n';
    }
    return '# Edit this file to introduce tasks to be run by cron.\n#\n# m h  dom mon dow   command\n';
  }

  installCrontabContent(content: string, user: string): void {
    this.executor.installCrontab(content, user);
  }

  followJournal(opts: { unit?: string; priority?: number; pid?: number }, listener: (line: string) => void): () => void {
    return this.executor.logMgr.followJournal(opts, listener);
  }

  sampleVmstatSnapshot() {
    return sampleVmstat(this.executor.processMgr, this.getHardware().memory);
  }

  sampleDstatSnapshot(rate: DstatRateState) {
    const ports: PortByteSnapshot[] = [];
    for (const p of this.getPorts()) {
      const c = p.getCounters();
      ports.push({ bytesIn: c.bytesIn, bytesOut: c.bytesOut });
    }
    return sampleDstat({
      pm: this.executor.processMgr,
      memory: this.getHardware().memory,
      ports,
    }, rate);
  }

  sampleMpstatSnapshot(args: MpstatArgs) {
    return sampleMpstat(args, this.executor.processMgr, this.getHardware().cpu);
  }

  mpstatBannerLine(): string {
    const now = new Date();
    const hostname = (this.executor.vfs.readFile('/etc/hostname') ?? 'localhost').trim();
    return mpstatBanner(this.executor.identity.kernel, hostname, this.getHardware().cpu, now);
  }

  pidstatBannerLine(): string {
    const now = new Date();
    const hostname = (this.executor.vfs.readFile('/etc/hostname') ?? 'localhost').trim();
    return pidstatBanner(this.executor.identity.kernel, hostname, this.getHardware().cpu, now);
  }

  samplePidstatCpu(args: PidstatArgs) {
    return samplePidstatCpu(args, this.executor.processMgr, this.getHardware().cpu);
  }

  samplePidstatMemory(args: PidstatArgs) {
    return samplePidstatMemory(args, this.executor.processMgr, this.getHardware().memory);
  }

  iostatBannerLine(): string {
    const now = new Date();
    const hostname = (this.executor.vfs.readFile('/etc/hostname') ?? 'localhost').trim();
    return iostatBanner(this.executor.identity.kernel, hostname, this.getHardware().cpu, now);
  }

  sampleIostatCpuSnapshot() {
    return sampleIostatCpu(this.executor.processMgr, this.getHardware().cpu);
  }

  sampleIostatDevicesSnapshot(args: IostatArgs) {
    return sampleIostatDevices(args, this.getHardware().storage);
  }

  followDmesg(
    opts: { raw?: boolean; humanTime?: boolean; levelFilter?: readonly string[] },
    listener: (line: string) => void,
  ): () => void {
    return this.executor.logMgr.followDmesg(opts, listener);
  }

  monitorNetlink(
    opts: { objects: ReadonlySet<IpMonitorObject>; labelled: boolean },
    listener: (block: string) => void,
  ): () => void {
    const ctx = buildIpCtx(this.net, this.xfrmCtx);
    const bus = this.getBus();
    const id = this.id;
    const labelled = opts.labelled;
    const subs: Array<() => void> = [];

    if (opts.objects.has('link')) {
      subs.push(bus.subscribe('host.link.state-changed', (e) => {
        if (e.payload.deviceId !== id) return;
        const block = formatIpMonitorLink(ctx, { iface: e.payload.iface }, labelled);
        if (block !== null) listener(block);
      }));
    }
    if (opts.objects.has('addr')) {
      subs.push(bus.subscribe('host.address.changed', (e) => {
        if (e.payload.deviceId !== id) return;
        listener(formatIpMonitorAddr(ctx, {
          iface: e.payload.iface, ip: e.payload.ip, cidr: e.payload.cidr, deleted: !e.payload.added,
        }, labelled));
      }));
    }
    if (opts.objects.has('route')) {
      subs.push(bus.subscribe('host.routing.route-added', (e) => {
        if (e.payload.deviceId !== id) return;
        listener(formatIpMonitorRoute({
          destination: e.payload.destination, mask: e.payload.mask, gateway: e.payload.gateway,
          iface: e.payload.iface, metric: e.payload.metric, deleted: false,
        }, labelled));
      }));
      subs.push(bus.subscribe('host.routing.route-removed', (e) => {
        if (e.payload.deviceId !== id) return;
        listener(formatIpMonitorRoute({
          destination: e.payload.destination, mask: e.payload.mask, gateway: null,
          iface: e.payload.iface, metric: 0, deleted: true,
        }, labelled));
      }));
    }
    if (opts.objects.has('neigh')) {
      subs.push(bus.subscribe('host.arp.entry-learned', (e) => {
        if (e.payload.deviceId !== id) return;
        listener(formatIpMonitorNeigh({
          ip: e.payload.ip, mac: e.payload.mac, iface: e.payload.iface, state: 'REACHABLE', deleted: false,
        }, labelled));
      }));
      subs.push(bus.subscribe('host.arp.entry-expired', (e) => {
        if (e.payload.deviceId !== id) return;
        listener(formatIpMonitorNeigh({
          ip: e.payload.ip, mac: e.payload.mac, iface: '', state: 'STALE', deleted: true,
        }, labelled));
      }));
    }

    return () => { for (const unsub of subs) unsub(); };
  }

  protected async resolveHostForCommand(targetStr: string): Promise<IPAddress | null> {
    return this.resolveHostnameOverWire(targetStr);
  }

  /** Tab completion against a specific shell session's cwd/env. */
  getCompletionsForSession(partial: string, session: LinuxShellSession): string[] {
    if (session.disposed || !this.isPoweredOn) return [];
    return this.sessionSwap.withinSync(
      session,
      () => this.getCompletions(partial),
      { capture: false },
    );
  }

  /**
   * Pop one frame off the session's su stack (the per-terminal one, not
   * the device-wide shared executor stack). Mirrors `handleExit` but
   * scoped to a session so `exit` from a `sudo su` only affects the
   * terminal that ran it. Fix for terminal_gap.md §10.1.
   */
  handleExitInSession(session: LinuxShellSession): { output: string; inSu: boolean } {
    if (session.disposed || !this.isPoweredOn) return { output: '', inSu: false };
    return this.sessionSwap.withinSync(session, () => this.executor.handleExit());
  }

  /**
   * Resolve an absolute path using the per-terminal session's cwd, so
   * editor opens (`nano file`) and file IO use the *active* shell's
   * working directory, not the device-wide shared one.
   */
  resolveAbsolutePathInSession(path: string, session: LinuxShellSession): string {
    if (session.disposed) return this.resolveAbsolutePath(path);
    return this.executor.vfs.normalizePath(path, session.cwd);
  }

  /** Per-session variant of readFileForEditor. */
  readFileForEditorInSession(path: string, session: LinuxShellSession): string | null {
    if (session.disposed) return this.readFileForEditor(path);
    const absPath = this.executor.vfs.normalizePath(path, session.cwd);
    return this.executor.vfs.readFile(absPath);
  }

  /** Per-session variant of writeFileFromEditor. */
  writeFileFromEditorInSession(path: string, content: string, session: LinuxShellSession): boolean {
    if (session.disposed) return this.writeFileFromEditor(path, content);
    const absPath = this.executor.vfs.normalizePath(path, session.cwd);
    return this.executor.vfs.writeFile(absPath, content, session.uid, session.gid, session.umask);
  }
}
