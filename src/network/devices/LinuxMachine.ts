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

import { EndHost, type PingResult, type ARPEntry, type HostRouteEntry, type HostPolicyRule, getNUDState } from './EndHost';
import type { UserAccountHost, ShellIdentityHost, FileEditorHost } from '../equipment/HostCapabilities';
import type { PathActor } from './linux/VfsPath';
import { findHostByAddress } from './linux/network/HostLookup';
import { LinuxNginxService } from './linux/http/nginx/LinuxNginxService';
import { LinuxRsyslogService } from './linux/syslog/LinuxRsyslogService';
import { RSYSLOG_SEEDED_FILES } from './linux/syslog/RsyslogFiles';
import { checkRsyslogCriticalFiles } from './linux/service/CriticalFiles';
import { NtpAgent, type NtpHost } from '../ntp/NtpAgent';
import { sendDynamicUpdate } from '../dns/update/DynamicUpdateClient';
import { LinuxChronyService, CHRONY_CONF_PATH } from './linux/time/LinuxChronyService';
import { CHRONY_KEYS_PATH, CHRONY_KEYS_DEBIAN } from './linux/time/ChronyKeys';
import { LinuxApacheService } from './linux/http/apache/LinuxApacheService';
import type { LinuxCommand } from './linux/commands/LinuxCommand';
import {
  APACHE_CONF, APACHE_CONF_PATH, APACHE_PORTS_CONF, APACHE_PORTS_PATH,
  APACHE_SITES_AVAILABLE, APACHE_SITES_ENABLED, APACHE_DEFAULT_SITE,
  APACHE_DEFAULT_PAGE, APACHE_DOCROOT, APACHE_DEFAULT_MODULES, apacheModuleLoadFile,
  APACHE_ENVVARS, APACHE_ENVVARS_PATH, APACHE_MODS_ENABLED, APACHE_DEFAULT_SSL_SITE,
  APACHE_MODS_AVAILABLE, APACHE_AVAILABLE_MODULES,
} from './linux/http/apache/ApacheFiles';
import { checkNginxCriticalFiles } from './linux/service/CriticalFiles';
import {
  NGINX_CONF, NGINX_CONF_PATH, NGINX_DEFAULT_SITE, NGINX_WELCOME_PAGE,
  NGINX_SITES_AVAILABLE, NGINX_SITES_ENABLED, NGINX_DEFAULT_ROOT, NGINX_DEFAULT_INDEX,
} from './linux/http/nginx/NginxFiles';
import type { NssHostEntry } from './linux/nss/types';
import type { TcpStack } from '../tcp/TcpStack';
import type { TcpStream } from '../tcp/types';
import { SshConnectionThrottler } from './linux/security/SshConnectionThrottler';
import { HostsFile } from './HostsFile';
import { Port } from '../hardware/Port';
import { Cable } from '../hardware/Cable';
import type { TaggedEthernetFrame } from './Switch';
import {
  IPAddress,
  IPv6Address,
  SubnetMask,
  MACAddress,
  type DeviceType,
  type IPv4Packet,
  type EthernetFrame,
} from '../core/types';

// Linux kernel / userspace
import { LinuxCommandExecutor, type SudoAuthorization } from './linux/LinuxCommandExecutor';
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
import { formatCtime } from './linux/time/ctime';
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
import { LinuxDhcpdService } from './linux/dhcp/LinuxDhcpdService';
import { seedDhcpdFiles } from './linux/dhcp/DhcpdFiles';
import { ServiceScriptRunner } from './linux/service/ServiceScriptRunner';

import { bindDnsUdpServer, DNS_PORT } from '../dns/transport/DnsUdpTransport';

/** Le listener TNS d'Oracle — §P2c de docs/PRD-Sockets-Une-Seule-Verite.md. */
const TNS_PORT = 1521;
const TNS_BOOT_BANNER = '(CONNECT_DATA=(SERVICE_NAME=ORCL))\r\n';
import { DnsRcode } from '../dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '../dns/wire/DnsMessage';
import { buildLegacyResponseMessage, rrTypeName } from '../dns/compat/DnsWireCompat';
import type { DnsQueryOptions } from '../dns/compat/DnsWireCompat';
import { bindDnsTcpServer, unbindDnsTcpServer } from '../dns/transport/DnsTcpTransport';
import { bindDnsTlsServer, unbindDnsTlsServer, DOT_PORT } from '../dns/transport/DnsTlsTransport';
import { LlmnrAgent } from '../llmnr/LlmnrAgent';
import { MdnsAgent } from '../mdns/MdnsAgent';
import { discoverDnssdFiles } from './linux/net/DnssdFiles';
import type { ServiceRegistration } from '../dnssd/types';
import { CrossVendorSshHost } from '../protocols/ssh/server/CrossVendorSshHost';
import { SshdServerConfig } from '../protocols/ssh/server/SshdServerConfig';
import { LinuxUserManagerAuthority } from './linux/network/LinuxUserManagerAuthority';
import { parseResolvConf } from './linux/nss/ResolvConf';
import {
  ResolvedService,
  parseResolvedConf,
  RESOLVED_CONF_PATH,
  RUN_STUB_RESOLV,
  RUN_UPSTREAM_RESOLV,
  STUB_ADDRESS,
  type ResolvedQtype,
  type ResolvedQueryOutcome,
  type UpstreamAnswer,
} from './linux/net/ResolvedService';
import { RRType } from '../dns/wire/RRType';
import { DnsValidator, type DnssecStatus } from '../dns/dnssec/DnsValidator';
import type { DsRecordData, ResourceRecord, ResourceRecordData } from '../dns/wire/ResourceRecord';
import { decodeDnsMessage, encodeDnsMessage } from '../dns/wire/DnsMessageCodec';
import type { ARecordData } from '../dns/wire/ResourceRecord';
import type { X509Certificate } from '../pki/X509Certificate';
import type { PacketInfo, LinuxIptablesManager } from './linux/LinuxIptablesManager';

// Façade + command registry
import type { LinuxNetKernel, TracerouteHop } from './linux/LinuxNetKernel';
import type { LinuxCommandContext } from './linux/commands/LinuxCommandContext';
import {
  LinuxCommandRegistry,
  CORE_LINUX_COMMANDS,
  readDhcpLeaseFile,
} from './linux/commands';
import {
  defaultLinuxFormatHelpers,
  type LinuxFormatHelpers,
} from './linux/LinuxFormatHelpers';
import { renderHelp, renderManPage } from './linux/commands/LinuxCommandHelp';
import { splitRegistryStdin } from './linux/commands/registryStdin';
import { evaluatePrivilegeRequirement, type PrivilegeRequirement } from './linux/iam/policy/CommandPrivilegePolicy';
import { buildIpCtx } from './linux/commands/net/Ip';
import { GreAgent, type GreHost } from '../gre/GreAgent';
import type { DHCPClient } from '../dhcp/DHCPClient';
import { LinuxSshServerContext } from '../protocols/ssh/server/LinuxSshServerContext';
import { SshServerHandler } from '../protocols/ssh/server/SshServerHandler';
import { probeSshHostKey } from '../protocols/ssh/SshHostKeyProbe';
import { parseSshdConfig, validateSshdConfig } from '../protocols/ssh/server/SshSshdConfig';
import {
  checkSshdCriticalFiles, checkCommandDependencies, canonicalBinPath,
  commandNotFoundMessage,
} from './linux/service/CriticalFiles';
import { SshSessionTable } from './linux/network/SshSessionTable';
import { renderWho } from './linux/network/whoFormatter';
import { renderW } from './linux/network/wFormatter';
import { renderLast } from './linux/network/lastFormatter';
import { renderLoginctl } from './linux/network/loginctlFormatter';
import { UtmpSync } from './linux/network/UtmpSync';
import { TcpSocketStateProjection } from './linux/network/TcpSocketStateProjection';
import { TcpdumpCaptureProjection } from './linux/network/TcpdumpCaptureProjection';
import { LogindStateSync } from './linux/network/LogindStateSync';
import type { TcpdumpDeps } from './linux/network/tcpdump/TcpdumpRunner';
import { serializeCaptureFile } from './linux/network/tcpdump/CaptureFileFormat';
import { decodeEthernetFrame, makeLoopbackIcmpFrame, makeTcpFrame, type CaptureFrame } from './linux/network/tcpdump/CaptureFrame';
import { buildLinuxInteractionPlan } from './linux/interaction/LinuxInteractionPlanner';
import type { CommandInteractionPlan, InteractionPlanContext } from '@/shell/interaction/CommandInteraction';

/**
 * Minimal sshd-style glob matcher: `*` matches any sequence including
 * the empty string. Anchored on both sides like OpenSSH's `match_pattern`.
 */
function globMatch(pattern: string, candidate: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$').test(candidate);
}

/** Parses a DNS server literal as IPv4 or IPv6 (RFC 3596) — `nslookup`/`dig` accept either family as `@server`. */
function parseDnsServerLiteral(literal: string): IPAddress | IPv6Address | null {
  try { return new IPAddress(literal); } catch { /* not IPv4 */ }
  try { return new IPv6Address(literal); } catch { /* not IPv6 */ }
  return null;
}

/**
 * Ce que le stub retient d'une réponse amont : les adresses du type
 * demandé, les enregistrements bruts pour la validation, et si le nom
 * lui-même est inconnu. Sans cette dernière distinction, « pas d'AAAA
 * pour ce nom » et « ce nom n'existe pas » seraient confondus.
 */
function readUpstreamAnswer(
  reply: DnsMessage | null, qtype: ResolvedQtype,
): UpstreamAnswer | null {
  if (!reply) return null;
  const wanted = qtype === 'AAAA' ? RRType.AAAA : RRType.A;
  return {
    addresses: reply.answers
      .filter((rr) => rr.data.type === wanted)
      .map((rr) => (rr.data as ARecordData).address.toString()),
    records: reply.answers,
    nxdomain: reply.flags.rcode === DnsRcode.NXDOMAIN,
  };
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

  private readonly trustedCAs: X509Certificate[] = [];

  addTrustedCertificateAuthority(cert: X509Certificate): void {
    this.trustedCAs.push(cert);
  }

  /** Registry of network-aware commands handled before the bash interpreter. */
  protected readonly commands: LinuxCommandRegistry;

  /** XFRM (IPsec) SAD/SPD — consumed by `ip xfrm state/policy`. */
  protected xfrmCtx: IpXfrmContext = { states: [], policies: [] };

  /** Stable ifindex assignment; seeded lazily, never recomputed from list position. */
  private ifIndexMap: Map<string, number> | null = null;
  private nextIfIndex = 2;

  /** GRE tunnel engine backing `ip tunnel`; inbound decap wired via EndHost.greAgent. */
  private readonly greAgentInstance: GreAgent;

  /** Interfaces created via `ip link add` — deletable, unlike profile-provisioned NICs. */
  private readonly virtualInterfaces: Set<string> = new Set();

  /** 802.1Q sub-interfaces created via `ip link add ... type vlan`: name → {parent, vid}. */
  private readonly vlanSubInterfaces: Map<string, { parent: string; vid: number }> = new Map();

  /** Network namespaces created via `ip netns add` — each holds its own routing/ARP state. */
  private readonly netNamespaces: Map<string, {
    routingTable: HostRouteEntry[];
    arpTable: Map<string, ARPEntry>;
    defaultGateway: IPAddress | null;
  }> = new Map();

  /** DNS daemon (dnsmasq) — active when the machine runs as a DNS server. */
  public readonly dnsService: DnsService = new DnsService();

  public readonly bind9: Bind9Service;
  public readonly dhcpd: LinuxDhcpdService;

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
    this.executor.setLocalDevice(this);
    this.executor.setSocketTable(this.socketTable);
    // §F9.3 — le plafond de descripteurs s'applique aux sockets, et il est
    // compté sur la même table que celle que `/proc/<pid>/fd` affiche.
    this.socketTable.setDescriptorGuard((pid) =>
      this.executor.processMgr.canOpenDescriptor(pid, this.executor.descriptorSourcesFor(pid)));
    this.executor.vfs.mkdirp('/proc/sys/net/ipv4', 0o755, 0, 0);
    this.executor.vfs.writeFile('/proc/sys/net/ipv4/ip_local_port_range', '32768\t60999\n', 0, 0, 0o022);
    this.executor.vfs.registerGeneratedFile('/proc/sys/net/ipv4/ip_forward',
      () => `${this.ipForwardEnabled ? 1 : 0}\n`, 0o644);
    this.executor.vfs.registerGeneratedFile('/proc/sys/net/ipv4/tcp_tw_reuse',
      () => `${this.socketTable.getTcpTwReuse() ? 1 : 0}\n`, 0o644);
    this.executor.setSessionTable(this.sessionTable);
    this.executor.setTcpProbe((ip, port) => {
      if (ip.includes(':')) return this.tcpProbeSyncIPv6(ip, port);
      return this.tcpProbeSync(new IPAddress(ip), port);
    });
    this.executor.setSshHostKeyProbe((ip, port) =>
      probeSshHostKey(this.tcpv2.connect(ip, port)));
    // Un montage réseau tient tant que son serveur est là. Aucun protocole
    // NFS n'est implémenté ; ce qui décide, c'est le fait physique que le
    // simulateur connaît vraiment — la machine est-elle encore atteignable
    // à travers les câbles depuis celle-ci (docs/PRD-Pannes.md §F5.7).
    this.executor.mountServerReachable = (host: string) =>
      findHostByAddress(host, this.executor.vfs, this) !== null;
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
    // Real Linux establishes the tty1 console login at boot (agetty/login),
    // not lazily on the first `who`/`w`/`last` invocation — materialising
    // it here keeps /var/log/wtmp's entry count stable across the boot
    // sequence instead of growing as a side effect of a monitoring command.
    this.ensureLocalConsoleSession();
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
    const greHost: GreHost = {
      id: this.id, name: this.name,
      getHostname: () => this.getHostname(),
      getPort: (n: string) => this.getPort(n),
      getPorts: () => this.getPorts(),
      sendFrame: (p: string, f: EthernetFrame) => { this.sendFrame(p, f); },
    };
    this.greAgentInstance = new GreAgent(greHost, () => this.getBus());
    this.greAgentInstance.start();
    this.greAgent = this.greAgentInstance;
    this.executor.setIpNetworkContext(buildIpCtx(this.net, this.xfrmCtx, this.greAgentInstance));
    // NSS `dns` source resolves through real UDP/53 once resolv.conf
    // names a non-loopback server (loopback = systemd-resolved stub,
    // modelled by the legacy fallback).
    this.executor.dnsNss.setWireResolver({
      nameservers: () => {
        const content = this.executor.readFile('/etc/resolv.conf') ?? '';
        return [...content.matchAll(/^\s*nameserver\s+(\S+)/gm)]
          .map(m => m[1])
          // Le stub répond pour de vrai désormais : son adresse passe.
          // Les autres bouclages restent filtrés, faute de service.
          .filter(ip => ip === STUB_ADDRESS || !ip.startsWith('127.'))
          .slice(0, 3);
      },
      searchDomains: () => {
        const content = this.executor.readFile('/etc/resolv.conf') ?? '';
        return parseResolvConf(content).search;
      },
      ndots: () => {
        const content = this.executor.readFile('/etc/resolv.conf') ?? '';
        return parseResolvConf(content).ndots;
      },
      query: (serverIp, name, qtype) => {
        const server = parseDnsServerLiteral(serverIp);
        if (!server) return null;
        return this.queryDnsServerSync(server, name, qtype);
      },
      queryAsync: async (serverIp, name, qtype) => {
        const server = parseDnsServerLiteral(serverIp);
        if (!server) return null;
        return this.queryDnsServer(server, name, qtype);
      },
    });
    // Cabled hosts resolve names over the wire (no registry scan); and
    // background-job liveness rides a real TCP probe, not bus events.
    this.executor.dnsNss.setCabledProbe(
      () => this.getPorts().some((p) => p.getCable() !== null),
    );
    this.executor.setWireProbe((ip, port) => {
      try { return this.tcpConnectOutcome(new IPAddress(ip), port); }
      catch { return 'timeout'; }
    });
    this.executor.setTcpConnector((host, port) => this.tcpConnect(host, port));

    // 4. Command registry
    this.commands = new LinuxCommandRegistry();
    this.registerCoreCommands();
    this.registerDeviceCommands();

    // Bridge registry commands (named-checkconf, named-checkzone, ...) into
    // bash-script execution — the executor's own switch-based dispatch has
    // no visibility into this registry, so without this a script running
    // `named-checkconf` sees "command not found" even though the same
    // command works fine typed directly at the prompt.
    this.executor._registryCommandHook = (cmd, args, stdin) => {
      const registered = this.commands.get(cmd);
      if (!registered || !registered.needsNetworkContext) return null;
      const unavailable = this.registryDependencyFailure(registered, cmd);
      if (unavailable) return unavailable;
      const { argv, input } = splitRegistryStdin(registered, args, stdin);
      if (registered.runWithStatusSync) {
        return registered.runWithStatusSync(this.buildCommandContext(), argv, input);
      }
      const result = registered.run(this.buildCommandContext(), argv, input);
      if (result instanceof Promise) return null;
      return { output: result, exitCode: this.inferRegistryExitCode(cmd, result) };
    };
    this.executor._registryPrivilegeHook = (cmd) => this.commands.get(cmd)?.privilege;

    // 5. Initialise SSH server config files on first boot:
    //    /etc/ssh/sshd_config + /etc/ssh/ssh_host_ed25519_key(.pub).
    //    Also seed /etc/motd and /etc/issue.net so SSH greeters and the
    //    pre-auth Banner have realistic content.
    this.initSshFiles();
    this.initNginx();
    this.initChrony();
    this.initApache();
    this.executor.netConfig.seedDefaults(this.getPortNames().filter(n => n !== 'lo'));
    this.wireNetworkConfigLifecycle();
    this.executor.iptables.setLogCallback((prefix, pkt) => this.logIptablesLog(prefix, pkt));
    this.executor.ip6tables.setLogCallback((prefix, pkt) => this.logIptablesLog(prefix, pkt));

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
      unbindDnsTlsServer(this);
      this.socketTable.unbind('tcp', '0.0.0.0', DNS_PORT);
      this.socketTable.unbind('tcp', '0.0.0.0', DOT_PORT);
    });
    this.bindResolvedStub();
    // LLMNR est actif par défaut sur Ubuntu, mDNS non — c'est ce que dit
    // `resolved.conf` et ce que `syncLinkLocalResponders` applique.
    this.syncLinkLocalResponders();

    this.bind9 = new Bind9Service(this, {
      read: (path) => this.executor.vfs.readFile(path),
      append: (path, content) => {
        const dir = path.slice(0, path.lastIndexOf('/')) || '/';
        if (!this.executor.vfs.exists(dir)) this.executor.vfs.mkdirp(dir, 0o755, 0, 0);
        this.executor.vfs.writeFile(path, content, 0, 0, 0o022, true);
      },
    });
    this.executor.serviceMgr.registerConfigCheck('named', () => this.bind9.checkConfig());

    seedDhcpdFiles({
      exists: (path) => this.executor.vfs.exists(path),
      mkdirp: (path) => {
        if (!this.executor.vfs.exists(path)) this.executor.vfs.mkdirp(path, 0o755, 0, 0);
      },
      write: (path, content) => { this.executor.vfs.writeFile(path, content, 0, 0, 0o022); },
    });
    this.dhcpd = new LinuxDhcpdService(this, {
      read: (path) => this.executor.vfs.readFile(path),
      write: (path, content) => { this.executor.vfs.writeFile(path, content, 0, 0, 0o022); },
      log: (message) => this.executor.logMgr.logDaemon(
        'dhcpd', message, this.executor.serviceMgr.getPortBinding('isc-dhcp-server')?.mainPid,
        'isc-dhcp-server'),
    });
    this.dhcpd.getEngine().setEventBus(this.getBus());
    this.executor.serviceMgr.registerConfigCheck('isc-dhcp-server', () => {
      const verdict = this.dhcpd.preflight();
      return verdict.ok ? { ok: true } : { ok: false, error: verdict.output, verbatim: true };
    });
    this.executor.serviceMgr.onLifecycle((event, name) => {
      if (name !== 'isc-dhcp-server') return;
      if (event === 'start') this.applyDhcpd(this.dhcpd.start());
      else if (event === 'restart') this.applyDhcpd(this.dhcpd.restart());
      else if (event === 'reload') this.applyDhcpd(this.dhcpd.restart());
      else if (event === 'stop') this.dhcpd.stop();
    });
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

    // `@reboot` ne partait jamais : `fireReboot()` n'est appelé que par
    // `CronEngine.start()`, et `cronTick` ne rallume le moteur que s'il
    // le trouve éteint — or un `systemctl restart cron` ne le fait pas
    // passer par `stop()`. Le cycle de vie du service le dit ici.
    this.executor.serviceMgr.onLifecycle((event, name) => {
      if (name !== 'cron') return;
      const engine = this.getCronEngine();
      if (event === 'stop') { engine.stop(); return; }
      // `start` seul, pas `restart` : `restart()` démarre puis annonce le
      // redémarrage, si bien qu'écouter les deux faisait partir les
      // lignes `@reboot` en double.
      if (event === 'start') {
        engine.stop();
        engine.start();
      }
    });

    // PRD-Iptables-UFW.md Phase 5 (objectifs A.1/A.2): systemctl start ufw
    // (and the boot-time activation of enabled units) reconciles the live
    // firewall with /etc/ufw/ufw.conf instead of always turning it on.
    this.executor.serviceMgr.onLifecycle((event, name) => {
      if (name !== 'ufw') return;
      if (event === 'start' || event === 'restart') this.executor.firewall.reconcileFromBoot();
    });

    // PRD-Iptables-UFW.md Phase 7 (objectif B.6): netfilter-persistent
    // reloads raw iptables/ip6tables rules (configured outside of ufw)
    // from /etc/iptables/rules.v4/rules.v6 into the live engines at boot,
    // exactly like the real iptables-persistent package's init script.
    this.executor.serviceMgr.onLifecycle((event, name) => {
      if (name !== 'netfilter-persistent') return;
      if (event !== 'start' && event !== 'restart') return;
      const v4 = this.executor.vfs.readFile('/etc/iptables/rules.v4');
      const v6 = this.executor.vfs.readFile('/etc/iptables/rules.v6');
      if (v4 !== null) this.executor.iptables.executeRestore(v4);
      if (v6 !== null) this.executor.ip6tables.executeRestore(v6);
    });

    this.executor.setNetworkCommandRunner((argv, env, viaSudo = false, stdin, outputPiped = false) => {
      const cmd = this.commands.get(argv[0]);
      if (!cmd || !cmd.needsNetworkContext) return null;
      const unavailable = this.registryDependencyFailure(cmd, argv[0]);
      if (unavailable) return Promise.resolve(unavailable);
      const split = splitRegistryStdin(cmd, argv.slice(1), stdin);
      const args = split.argv;
      const input = split.input;
      // A `cd` earlier in the same composite line (`cd /mnt && umount /mnt`)
      // only updates the interpreter's own PWD; `LinuxCommandExecutor.cwd`
      // is otherwise not synced until the whole line finishes. Commands
      // whose behavior depends on the *current* directory (`umount`'s
      // busy-mountpoint check) need it synced before they run.
      if (env?.PWD) this.executor.syncCwdFromScript(env.PWD);
      // This runner is what the bash interpreter actually calls for every
      // simple command it evaluates (composite lines, pipelines, scripts,
      // functions) — the declarative privilege gate must apply here too,
      // not just on the single-command fast path in `tryNetworkCommand`.
      // `dispatchMaybeNetwork` retire le `sudo` avant d'arriver ici : sans
      // ce drapeau, une commande réseau privilégiée était refusée dans une
      // ligne composée (`sudo iptables -L; echo $?`) alors qu'elle passait
      // seule, et l'autorisation sudoers n'était jamais consultée.
      if (viaSudo) {
        const auth = this.executor.authorizeSudo(argv[0], args, 'root');
        if (auth.reason === 'not-in-sudoers' || auth.reason === 'unknown-target-user') {
          this.executor.writeSudoAuditLine('not-in-sudoers', auth, argv.join(' '));
          return Promise.resolve({
            output: `${auth.invokingUser} is not in the sudoers file. This incident will be reported.`,
            exitCode: 1,
          });
        }
        if (auth.reason === 'command-not-allowed') {
          this.executor.writeSudoAuditLine('command-not-allowed', auth, argv.join(' '));
          return Promise.resolve({
            output: `Sorry, user ${auth.invokingUser} is not allowed to execute '${argv.join(' ')}' as ${auth.runasUser} on ${auth.hostname}.`,
            exitCode: 1,
          });
        }
        this.executor.writeSudoAuditLine('success', auth, argv.join(' '));
      }
      const userMgr = this.executor.userMgr;
      const saved = viaSudo
        ? { user: userMgr.currentUser, uid: userMgr.currentUid, gid: userMgr.currentGid }
        : null;
      if (saved) {
        userMgr.currentUser = 'root';
        userMgr.currentUid = 0;
        userMgr.currentGid = 0;
      }
      const restore = (): void => {
        if (!saved) return;
        userMgr.currentUser = saved.user;
        userMgr.currentUid = saved.uid;
        userMgr.currentGid = saved.gid;
      };

      if (cmd.privilege) {
        const actor = {
          uid: userMgr.currentUid,
          user: userMgr.currentUser,
          groups: userMgr.getUserGroups(userMgr.currentUser).map((g) => g.name),
        };
        const denial = evaluatePrivilegeRequirement(cmd.privilege, argv[0], args, actor);
        if (denial) { restore(); return Promise.resolve(denial); }
      }
      const ctx = this.buildCommandContext(outputPiped);
      if (cmd.runWithStatusSync) {
        try { return Promise.resolve(cmd.runWithStatusSync(ctx, args, input)); } finally { restore(); }
      }
      if (cmd.runWithStatus) return cmd.runWithStatus(ctx, args, input).finally(restore);
      // Match `_registryCommandHook`'s exit-code inference (used when this
      // same registry command is reached via the synchronous script
      // dispatch default case) so `$?`/`||` chaining behaves identically
      // regardless of which of the two bridges happened to run it.
      return Promise.resolve(cmd.run(ctx, args, input)).then((output) => ({
        output,
        exitCode: this.inferRegistryExitCode(argv[0], output),
      })).finally(restore);
    });
    this.executor.setNetworkCommandNamePredicate((name) => {
      const cmd = this.commands.get(name);
      return !!cmd && !!cmd.needsNetworkContext;
    });

    this.executor.serviceMgr.onLifecycle((event, name) => {
      if (!name.endsWith('.socket')) return;
      if (event === 'start' || event === 'restart') this.openActivationSocket(name);
      else if (event === 'stop') this.closeActivationSocket(name);
    });
  }

  private readonly activationSockets = new Map<string, number>();

  private openActivationSocket(name: string): void {
    if (this.activationSockets.has(name)) return;
    const entry = this.executor.serviceMgr.socketEntries().find((s) => s.unit === name);
    if (!entry) return;
    try {
      this.getTcpStack().listen(entry.port, {
        onAccept: () => { this.executor.serviceMgr.triggerSocket(name); },
      });
    } catch {
      return;
    }
    this.activationSockets.set(name, entry.port);
  }

  private closeActivationSocket(name: string): void {
    const port = this.activationSockets.get(name);
    if (port === undefined) return;
    this.getTcpStack().closeListener(port);
    this.activationSockets.delete(name);
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
      runAsRoot: (command) => this.runServiceScript(command, pid),
      emitOutput: (line) =>
        this.executor.logMgr.logService(`${name}.service`, name, line, pid ?? 0),
      stillCurrent: () => {
        const current = this.executor.serviceMgr.status(name);
        return current?.state === 'active' && current.mainPid === pid;
      },
    });
    this.scriptRunners.set(name, runner);
    const timer = setTimeout(() => {
      if (this.scriptRunners.get(name) === runner) void runner.start(scriptPath);
    }, 0);
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
  }

  private stopScriptRunner(name: string): void {
    this.scriptRunners.get(name)?.stop();
    this.scriptRunners.delete(name);
  }

  private async runServiceScript(command: string, pid?: number): Promise<string> {
    const um = this.executor.userMgr;
    const prev = { user: um.currentUser, uid: um.currentUid, gid: um.currentGid };
    um.currentUser = 'root';
    um.currentUid = 0;
    um.currentGid = 0;
    try {
      const run = () => this.executor.executeAsync(command);
      return await (pid !== undefined ? this.executor.withProcessIdentity(pid, run) : run());
    } catch {
      return '';
    } finally {
      um.currentUser = prev.user;
      um.currentUid = prev.uid;
      um.currentGid = prev.gid;
    }
  }

  private applyDhcpd(result: { ok: boolean; output: string }): void {
    if (result.ok) return;
    this.dhcpd.stop();
    this.executor.serviceMgr.markFailed('isc-dhcp-server', result.output);
  }

  private applyBind9(result: { ok: boolean; error?: string }): void {
    if (!result.ok) {
      this.bind9.stop();
      this.dhcpd.stop();
      this.executor.serviceMgr.markFailed('named', result.error ?? 'failed to start');
    }
  }

  // ─── DNS over the wire (server side) ─────────────────────────────────

  private bindDnsServerPort(): void {
    // Le stub de systemd-resolved tient 127.0.0.53:53 ; un serveur DNS
    // local prend 0.0.0.0:53 à côté, sans conflit — c'est la cohabitation
    // réelle sur Ubuntu.
    try {
      bindDnsUdpServer(this, (query) => this.answerDnsQuery(query), DNS_PORT, 'dnsmasq');
      bindDnsTcpServer(this, (query) => this.answerDnsQuery(query), DNS_PORT);
    } catch { /* port already bound (e.g. service restarted) */ }
    // RFC 7858 : le même contenu servi sur le 853 chiffré. Sans cette
    // écoute, `DNSOverTLS=` n'aurait personne à qui parler et le réglage
    // ne serait qu'un texte de plus dans `resolvectl status`.
    try {
      bindDnsTlsServer(this, (query) => this.answerDnsQuery(query));
    } catch { /* port already bound (e.g. service restarted) */ }
    // Il y avait ici deux `socketTable.bind()` manuels, dont le
    // commentaire disait qu'ils n'existaient que parce que
    // `TcpStack.listen()` n'inscrivait rien. Il inscrit désormais, avec le
    // nom du démon — le premier des cinq contournements du §3 à
    // disparaître (docs/PRD-Sockets-Une-Seule-Verite.md §P2).
  }

  // ─── systemd-resolved ────────────────────────────────────────────────

  private _llmnrAgent: LlmnrAgent | null = null;
  private _mdnsAgent: MdnsAgent | null = null;

  /**
   * Les deux résolveurs de lien de systemd-resolved. Ils ne sont pas de
   * simples réglages : chacun tient un vrai port UDP sur son groupe
   * multicast et répond pour le nom de cet hôte.
   */
  getLlmnrAgent(): LlmnrAgent {
    if (!this._llmnrAgent) this._llmnrAgent = new LlmnrAgent(this);
    return this._llmnrAgent;
  }

  getMdnsAgent(): MdnsAgent {
    if (!this._mdnsAgent) {
      this._mdnsAgent = new MdnsAgent(this);
      this.loadDnssdServices();
    }
    return this._mdnsAgent;
  }

  /**
   * Relit `/etc/systemd/dnssd/*.dnssd`. C'est ainsi que systemd publie un
   * service — pas par une commande, mais par un fichier d'unité
   * (`systemd.dnssd(5)`), au même format que les `.network` de networkd.
   */
  loadDnssdServices(): void {
    const agent = this._mdnsAgent;
    if (!agent) return;
    const registry = agent.services();

    // Le rechargement est différentiel, pas un `clear()` suivi d'une
    // republication : sans comparer, un service retiré du disque
    // disparaîtrait en silence, et les pairs qui l'ont entendu
    // continueraient de le croire là (RFC 6762 §10.1).
    const before = new Map(registry.list().map((s) => [`${s.instance}|${s.type}`, s]));
    const changed: ServiceRegistration[] = [];
    const seen = new Set<string>();

    for (const file of discoverDnssdFiles(this.executor.vfs)) {
      const key = `${file.service.instance}|${file.service.type}`;
      seen.add(key);
      if (registry.publish(file.service)) changed.push(file.service);
    }
    for (const [key, gone] of before) {
      if (seen.has(key)) continue;
      registry.unpublish(gone.instance, gone.type);
      if (agent.nameState() === 'claimed') agent.announceService(gone, true);
    }
    // On n'annonce qu'une fois le nom acquis : annoncer un service porté
    // par un nom encore en sondage serait affirmer les deux à la fois.
    if (agent.nameState() !== 'claimed') return;
    for (const reg of changed) agent.announceService(reg);
  }

  /**
   * Aligne les deux répondeurs sur la configuration : `no` les arrête,
   * toute autre valeur les fait écouter. Rappelé à chaque changement de
   * réglage, sans quoi `resolvectl llmnr eth0 no` n'aurait, une fois de
   * plus, aucun effet.
   */
  syncLinkLocalResponders(): void {
    const svc = this.getResolvedService();
    // `resolve` autorise à interroger sans répondre : seul `yes` fait
    // tenir le port. Le répondeur est unique pour l'hôte alors que le
    // réglage est par lien : la granularité par lien du *répondeur*
    // n'est donc pas modélisée, celle de la *résolution* l'est.
    const llmnr = this.getLlmnrAgent();
    const mdns = this.getMdnsAgent();
    if (svc.linkLocalEnabled('llmnr', ['yes'])) llmnr.start(); else llmnr.stop();
    if (svc.linkLocalEnabled('mdns', ['yes'])) mdns.start(); else mdns.stop();
  }

  private _resolvedService: ResolvedService | null = null;

  /**
   * Le service de résolution de l'hôte. `queryUpstream` part réellement
   * sur le câble : le stub ne fabrique aucune réponse, il relaie et met
   * en cache (`docs/PRD-resolvectl.md` §2.2).
   */
  getResolvedService(): ResolvedService {
    if (!this._resolvedService) {
      this._resolvedService = new ResolvedService({
        // Le bit DO n'est posé que si l'on compte valider : sans lui le
        // serveur n'a aucune raison de renvoyer les RRSIG. `tls` bascule
        // le transport sur le 853 chiffré (RFC 7858) ; le service décide,
        // celui-ci exécute.
        queryUpstream: async (server, name, qtype, dnssecOk, encrypted) => {
          let serverIP: IPAddress;
          try { serverIP = new IPAddress(server); } catch { return null; }
          const reply = await this.queryDnsServer(
            serverIP, name, qtype, 2000, { dnssecOk, tls: encrypted });
          return readUpstreamAnswer(reply, qtype);
        },
        queryUpstreamSync: (server, name, qtype) => {
          let serverIP: IPAddress;
          try { serverIP = new IPAddress(server); } catch { return null; }
          return readUpstreamAnswer(this.queryDnsServerSync(serverIP, name, qtype), qtype);
        },
        validate: (records) => this.validateDnssec(records),
        hasTrustAnchors: () => this.dnssecAnchors.length > 0,
        resolveLlmnr: (name) => this.getLlmnrAgent().resolve(name),
        resolveMdns: (name) => this.getMdnsAgent().resolve(name),
      });
      this.loadResolvedConfig();
    }
    return this._resolvedService;
  }

  private _dnsValidator: DnsValidator | null = null;

  /**
   * Valide une réponse en remontant la chaîne de confiance jusqu'à une
   * ancre. Le `ChainLookup` repart sur le fil pour chaque DNSKEY et DS
   * demandés : c'est une vraie remontée, pas une table de vérité.
   *
   * Sans ancre configurée (`/etc/systemd/resolved.conf` `DNSSECAnchors=`
   * n'existe pas ici), la chaîne ne peut aboutir : on rend `insecure`
   * plutôt que de prétendre valider.
   */
  private async validateDnssec(
    records: readonly ResourceRecord<ResourceRecordData>[],
  ): Promise<DnssecStatus> {
    if (this.dnssecAnchors.length === 0) return 'insecure';
    if (!this._dnsValidator) {
      this._dnsValidator = new DnsValidator(
        async (qname, qtype) => {
          const svc = this.getResolvedService();
          const { server, link } = svc.selectServer(qname);
          if (!server) return { status: 'SERVFAIL', records: [] };
          let serverIP: IPAddress;
          try { serverIP = new IPAddress(server); } catch { return { status: 'SERVFAIL', records: [] }; }
          // La remontée de chaîne emprunte le même transport que la
          // requête qu'elle valide : sur un lien en DoT strict, le 53 en
          // clair n'a aucune raison de répondre.
          const tls = svc.dnsOverTlsModeFor(link) !== 'no';
          let reply = await this.queryDnsServer(
            serverIP, qname, rrTypeName(qtype), 2000, { dnssecOk: true, tls });
          if (!reply && tls && svc.dnsOverTlsModeFor(link) === 'opportunistic') {
            reply = await this.queryDnsServer(
              serverIP, qname, rrTypeName(qtype), 2000, { dnssecOk: true });
          }
          if (!reply) return { status: 'SERVFAIL', records: [] };
          return { status: 'NOERROR', records: [...reply.answers, ...reply.authorities] };
        },
        this.dnssecAnchors,
      );
    }
    return this._dnsValidator.validateAnswer(records);
  }

  private dnssecAnchors: ResourceRecord<DsRecordData>[] = [];

  /**
   * Ancres de confiance de l'hôte. Le vrai systemd-resolved embarque
   * celle de la racine ; ici il n'y a pas de racine publique, donc c'est
   * à la maquette de dire à quoi elle fait confiance.
   */
  setDnssecTrustAnchors(anchors: readonly ResourceRecord<DsRecordData>[]): void {
    this.dnssecAnchors = [...anchors];
    this._dnsValidator = null;
  }

  /** Relit `resolved.conf` et réécrit les fichiers de `/run`. */
  loadResolvedConfig(): void {
    const svc = this._resolvedService;
    if (!svc) return;
    svc.setGlobal(parseResolvedConf(this.executor.vfs.readFile(RESOLVED_CONF_PATH)));
    this.publishResolvedState();
  }

  /** Projette l'état courant dans `/run/systemd/resolve/`. */
  publishResolvedState(): void {
    const svc = this._resolvedService;
    if (!svc) return;
    const vfs = this.executor.vfs;
    if (!vfs.exists('/run/systemd/resolve')) vfs.mkdirp('/run/systemd/resolve', 0o755, 0, 0);
    vfs.writeFile(RUN_STUB_RESOLV, svc.stubResolvConf(), 0, 0, 0o022);
    vfs.writeFile(RUN_UPSTREAM_RESOLV, svc.upstreamResolvConf(), 0, 0, 0o022);
  }

  /**
   * Le vrai écouteur du stub : de vraies requêtes DNS décodées du fil,
   * une vraie réponse encodée. Remplace le `bind()` décoratif qui faisait
   * croire à `ss` qu'un service écoutait (écart #1 du PRD).
   */
  /** Le stub du resolver écoute-t-il pour de bon ? */
  private resolvedStubBound = false;

  private bindResolvedStub(): void {
    try {
      // L'unité systemd-resolved pose une entrée sans gestionnaire dans la
      // table des sockets (SERVICE_LISTENERS) : c'est elle que `ss`
      // montrait. On la reprend pour mettre un vrai service derrière.
      this.socketTable.unbind('udp', STUB_ADDRESS, DNS_PORT);
      this.udpBindAddress(STUB_ADDRESS, DNS_PORT, ({ sourceIP, udp }) => {
        if (!(udp.payload instanceof Uint8Array)) return;
        let query: DnsMessage;
        try { query = decodeDnsMessage(udp.payload); } catch { return; }
        const send = (reply: DnsMessage): void => {
          const bytes = encodeDnsMessage(reply);
          this.sendUdpDatagramTo(sourceIP, udp.sourcePort, DNS_PORT, bytes, bytes.length);
        };
        // Sans validation à faire, la réponse part dans la même pile
        // d'appel : c'est ce qui garde le résolveur NSS synchrone du
        // système capable d'interroger le stub.
        const immediate = this.answerResolvedQuerySync(query);
        if (immediate) { send(immediate); return; }
        void this.answerResolvedQuery(query).then(send);
      }, 'systemd-resolved');
      // Le stub répond aussi en TCP sur une vraie machine — c'est par là
      // que passe une réponse trop grande pour un datagramme (RFC 7766).
      // L'entrée `tcp 127.0.0.53:53` figurait déjà dans `ss` ; jusqu'ici
      // rien n'écoutait derrière
      // (docs/PRD-Sockets-Une-Seule-Verite.md §P2).
      bindDnsTcpServer(this, (query) => {
        const immediate = this.answerResolvedQuerySync(query);
        return immediate ?? this.answerResolvedQuery(query);
      }, DNS_PORT, { address: STUB_ADDRESS, processName: 'systemd-resolved' });
      this.resolvedStubBound = true;
    } catch { /* déjà lié */ }
    // systemd-resolved est le contre-exemple de docs/PRD-Nginx.md §P0 : son
    // écoute est RÉELLE (`udpBindAddress` ci-dessus), elle est seulement
    // posée hors de la projection. Il déclare donc son serveur — APRÈS
    // l'avoir ouverte — sinon `ss` cacherait un port joignable, l'erreur
    // symétrique de celle que §P0 corrige et tout aussi trompeuse.
    // Le listener TNS est dans le même cas depuis docs/PRD-Manquements.md
    // §M1 : son écoute est réelle et ouverte à l'amorçage, hors de la
    // projection. La dette qui était écrite ici — « sans écoute réelle »
    // — n'existe plus, et `close` ferme donc vraiment : `systemctl stop
    // oracle-ohasd` retire le port, comme `lsnrctl stop`. Un `close` qui
    // ne fermait rien laissait l'unité arrêtée et le port ouvert.
    this.executor.registerServiceSocketServer('oracle-ohasd', {
      open: () => { this.bindTnsListener(); return true; },
      close: () => {
        for (const addr of ['0.0.0.0', '::']) {
          try { this.getTcpStack().closeListener(TNS_PORT, addr); } catch { /* déjà fermé */ }
        }
      },
    });
    this.executor.registerServiceSocketServer('systemd-resolved', {
      open: () => this.resolvedStubBound,
      close: () => { /* le stub appartient au resolver, pas à la projection */ },
    });
  }

  /**
   * Le type demandé, quand le stub sait le résoudre. Tout le reste (MX,
   * TXT, SRV, PTR…) ne passe pas par le résolveur du stub — il n'a ni
   * cache ni sélection de serveur pour ces types.
   */
  private stubQtype(question: DnsMessage['questions'][number]): ResolvedQtype | null {
    if (question.qtype === RRType.A) return 'A';
    if (question.qtype === RRType.AAAA) return 'AAAA';
    return null;
  }

  private answerResolvedQuerySync(query: DnsMessage): DnsMessage | null {
    const question = query.questions[0];
    if (!question) return buildLegacyResponseMessage(query, DnsRcode.FORMERR, []);
    const qtype = this.stubQtype(question);
    if (!qtype) return buildLegacyResponseMessage(query, 'NOERROR', []);
    const outcome = this.getResolvedService().resolveSync(question.qname, qtype);
    if (!outcome) return null;
    return this.renderResolvedAnswer(query, question.qname, qtype, outcome);
  }

  /**
   * Une réponse vide ne vaut pas SERVFAIL : un nom qui existe en A mais
   * pas en AAAA doit rendre NOERROR sans réponse (NODATA), sans quoi
   * toute recherche double famille — `getent hosts`, `ahosts` — croit à
   * un échec et jette la moitié qui avait pourtant abouti.
   */
  private renderResolvedAnswer(
    query: DnsMessage, qname: string, qtype: ResolvedQtype,
    outcome: ResolvedQueryOutcome,
  ): DnsMessage {
    if (outcome.addresses.length === 0) {
      if (outcome.verdict === 'nxdomain') return buildLegacyResponseMessage(query, 'NXDOMAIN', []);
      if (outcome.verdict === 'nodata') return buildLegacyResponseMessage(query, 'NOERROR', []);
      return buildLegacyResponseMessage(query, 'SERVFAIL', []);
    }
    return buildLegacyResponseMessage(query, 'NOERROR', outcome.addresses.map((ip) => ({
      name: qname, type: qtype, value: ip, ttl: 60,
    })));
  }

  private async answerResolvedQuery(query: DnsMessage): Promise<DnsMessage> {
    const question = query.questions[0];
    if (!question) return buildLegacyResponseMessage(query, DnsRcode.FORMERR, []);
    const qtype = this.stubQtype(question);
    if (!qtype) return buildLegacyResponseMessage(query, 'NOERROR', []);
    const outcome = await this.getResolvedService().resolve(question.qname, qtype);
    return this.renderResolvedAnswer(query, question.qname, qtype, outcome);
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
        // Une seule source pour les crontabs utilisateur : le fichier.
        // `LinuxCronManager` en tenait un double en mémoire tout en
        // écrivant /var/spool/cron/crontabs, et les deux étaient énumérés
        // — une tâche installée par `crontab -` s'exécutait donc deux fois
        // par minute. Le fichier fait foi, comme sur un vrai système : il
        // est ce que `SystemCron` lit, et ce qu'un `vim` sur le spool
        // modifierait.
        sources: [new SystemCron(this.executor.vfs)],
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
    this.executor.serviceMgr.timerTick(at);
    // `atd` a son propre tour, mais il tombe à la même minute que cron.
    // Il ne vivait jusqu'ici que dans `advanceTime()`, si bien qu'une
    // tâche `at` ne partait que si quelqu'un avançait l'horloge à la
    // main — jamais sur le tour autonome de la machine.
    this.executor.fireDueAtJobs(at);
  }

  private runCronJob(command: string, ctx: { user: string; env: Record<string, string> }): { output: string; exitCode: number } {
    const um = this.executor.userMgr;
    const prev = { user: um.currentUser, uid: um.currentUid, gid: um.currentGid, cwd: this.executor.getCwd() };
    const entry = um.getUser(ctx.user);
    if (entry) {
      um.currentUser = ctx.user;
      um.currentUid = entry.uid;
      um.currentGid = entry.gid;
      this.executor.setCwd(entry.home ?? `/home/${ctx.user}`);
    }
    try {
      // cron n'a pas de terminal : sa commande ne va pas dans l'historique
      // de l'opérateur, elle va dans syslog.
      const output = this.executor.runNonInteractive(
        () => this.executor.executeWithEnv(command, ctx.env),
      );
      return { output: output ?? '', exitCode: 0 };
    } catch {
      return { output: '', exitCode: 1 };
    } finally {
      um.currentUser = prev.user;
      um.currentUid = prev.uid;
      um.currentGid = prev.gid;
      this.executor.setCwd(prev.cwd);
    }
  }

  private deliverCronMail(recipient: string, body: string): void {
    const entry = this.executor.userMgr.getUser(recipient);
    const host = (this.executor.vfs.readFile('/etc/hostname') ?? this.name).trim();
    const envelope = `From cron@${host}  ${formatCtime(new Date())}\n`;
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
    this.dhcpd?.getEngine().setEventBus(this.getBus());
  }

  override setHardware(profile: HardwareProfile): void {
    super.setHardware(profile);
    this.executor.setHardware(profile);
  }

  /** Persist SSH server configuration + host key + MOTD on the VFS. */
  /**
   * nginx (docs/PRD-Nginx.md §P1/§P2) — les fichiers que Debian livre, le
   * service qui les lit, et le contrôle de configuration que
   * `systemctl start/restart/reload` consulte.
   *
   * C'est aussi ce qui supprime la contradiction du §P0 : le service ne
   * s'inscrit dans la `SocketTable` — donc dans `ss` — que parce qu'il
   * fournit ici un vrai serveur qui ouvre une vraie écoute.
   */
  private initNginx(): void {
    const vfs = this.executor.vfs;
    for (const dir of ['/etc/nginx', NGINX_SITES_AVAILABLE, NGINX_SITES_ENABLED,
                       '/etc/nginx/conf.d', '/etc/nginx/modules-enabled',
                       NGINX_DEFAULT_ROOT, '/var/log/nginx']) {
      if (!vfs.exists(dir)) vfs.mkdirp(dir, 0o755, 0, 0);
    }
    if (!vfs.exists(NGINX_CONF_PATH)) vfs.writeFile(NGINX_CONF_PATH, NGINX_CONF, 0, 0, 0o022, true);
    const site = `${NGINX_SITES_AVAILABLE}/default`;
    if (!vfs.exists(site)) vfs.writeFile(site, NGINX_DEFAULT_SITE, 0, 0, 0o022, true);
    if (!vfs.exists(`${NGINX_SITES_ENABLED}/default`)) {
      vfs.createSymlink(`${NGINX_SITES_ENABLED}/default`, '../sites-available/default', 0, 0);
    }
    const welcome = `${NGINX_DEFAULT_ROOT}/${NGINX_DEFAULT_INDEX}`;
    if (!vfs.exists(welcome)) vfs.writeFile(welcome, NGINX_WELCOME_PAGE, 0, 0, 0o022, true);

    this.nginxService = new LinuxNginxService({
      fs: {
        read: (path) => vfs.readFile(path),
        list: (dir) => vfs.listDirectory(dir)?.map((e) => e.name) ?? null,
        exists: (path) => vfs.exists(path),
        isDirectory: (path) => vfs.listDirectory(path) !== null,
        readableBy: (path, uid, gid) => {
          const inode = vfs.resolveInode(path);
          return inode ? vfs.checkAccess(inode, 'r', uid, gid) : false;
        },
      },
      tcpStack: () => this.getTcpStack(),
      portTaken: (port) => this.getTcpStack().listListeners().some((l) => l.localPort === port),
      appendLog: (path, line) => this.executor.logMgr.appendLine(path, line),
      now: () => new Date(),
      // §P6 — le mandataire résout par la MACHINE qui l'exécute :
      // `/etc/hosts` et `/etc/resolv.conf` du serveur décident, comme
      // pour le vrai nginx. La variante synchrone est la bonne ici,
      // la réponse devant partir dans le même tour que la requête.
      resolve: (name) => this.resolveHostnameSyncForServices(name),
    });

    this.executor.registerServiceSocketServer('nginx', this.nginxService);
    this.executor.nginxService = this.nginxService;
    this.installerRsyslog(vfs);

    this.publishNginxPorts();

    this.executor.serviceMgr.registerConfigCheck('nginx', () => {
      const service = this.nginxService;
      if (!service) return { ok: true };
      // L'ordre est celui de nginx : le fichier d'abord (c'est lui qui
      // nomme les ports), le port ensuite. Un `nginx.conf` absent est un
      // `open()` qui échoue, un `nginx.conf` vide une configuration sans
      // section `events` — deux pannes, deux messages.
      const missing = checkNginxCriticalFiles({
        exists: (p) => this.executor.vfs.exists(p),
        readFile: (p) => this.executor.vfs.readFile(p),
      });
      const error = missing.ok ? service.loadConfig() : (missing.error ?? null);
      // The certificates are read here for the same reason `nginx -t`
      // reads them: a reload that would fail on one must be REFUSED
      // rather than tear the running server down first.
      const tls = error ? null : service.tlsProblem();
      const conflict = error ?? tls ? null : service.portConflict();
      const failure = error ?? tls ?? conflict;
      if (failure) {
        service.reportStartupFailure(failure);
        return { ok: false, error: failure, verbatim: true };
      }
      return { ok: true };
    });
    this.executor.serviceMgr.onLifecycle((event, name) => {
      if (name !== 'nginx') return;
      if (event === 'stop') { this.nginxService?.stopAll(); return; }
      if (event === 'reload') this.nginxService?.reload();
      // La configuration décide des ports, donc `ss` doit suivre la
      // configuration et non la table statique de `SERVICE_LISTENERS` :
      // sans cela, un `listen 8888` laisserait `:80` affiché pour une
      // écoute qui n'existe plus.
      this.publishNginxPorts();
      this.executor.resyncServicePorts('nginx');
    });
  }

  /**
   * rsyslog en RECEPTEUR.
   *
   * Mesure : `rsyslogd` existe, `systemctl status rsyslog` repond
   * `active`, `/var/log/syslog` se remplit — et `/etc/rsyslog.conf`
   * N'EXISTE PAS, `/etc/rsyslog.d/` non plus, rien n'ecoute sur 514. Un
   * routeur configure avec `logging host` posait donc de vrais
   * datagrammes sur le fil que personne ne recevait : la
   * centralisation, qui est le sujet meme d'un cours syslog, n'avait
   * aucun support.
   */
  rsyslogService: LinuxRsyslogService | null = null;

  private installerRsyslog(vfs: typeof this.executor.vfs): void {
    for (const [chemin, contenu] of RSYSLOG_SEEDED_FILES) {
      if (!vfs.exists(chemin)) vfs.writeFile(chemin, contenu, 0, 0, 0o022, true);
    }
    this.rsyslogService = new LinuxRsyslogService({
      lireFichier: (p) => vfs.readFile(p) ?? null,
      ecrireLigne: (p, l) => this.executor.logMgr.appendLine(p, l),
      listerRepertoire: (p) => vfs.listDirectory(p)?.map((e) => e.name) ?? [],
      // L'ecoute est REELLE : `udpBindAddress` pose la socket que `ss`
      // lit ET le recepteur qui traite le datagramme. Inscrire l'une
      // sans l'autre est exactement le defaut que ce lot referme.
      ecouterUdp: (port, onDatagram) => {
        // `udpBind` et non `udpBindAddress` : la livraison cherche
        // d'abord un service lie a UNE adresse (`192.168.100.50:514`) et
        // ne retombe sur la table par PORT qu'ensuite. Un rsyslog ecoute
        // sur toutes les interfaces, donc c'est cette seconde table qui
        // le concerne — lie a `0.0.0.0:514`, il apparaissait dans `ss` et
        // ne recevait rien, la cle cherchee etant l'adresse de
        // destination du datagramme.
        this.udpBind(port, (d) => {
          // Ce simulateur transporte des PDU STRUCTUREES et non des
          // octets — convention de tout le depot. Un emetteur interne
          // (`SyslogAgent`) pose donc un `SyslogPacket` et non une
          // chaine ; on reconstruit la ligne RFC 3164 depuis ses champs
          // plutot que d'exiger une serialisation qui n'existe nulle
          // part. Une charge deja textuelle (un `logger` distant, un
          // test) reste acceptee telle quelle.
          const p = d.udp.payload as unknown;
          let charge = '';
          if (typeof p === 'string') charge = p;
          else if (p && typeof p === 'object' && (p as { type?: string }).type === 'syslog') {
            const s2 = p as { facility: number; severity: number; hostname: string;
                              tag: string; message: string; timestamp: string };
            charge = `<${s2.facility * 8 + s2.severity}>${s2.timestamp} `
              + `${s2.hostname} ${s2.tag} ${s2.message}`;
          }
          if (charge) onDatagram(d.sourceIP.toString(), charge);
        }, 'rsyslogd');
        return () => this.udpClose(port);
      },
      hostname: () => this.getHostname(),
      maintenant: () => Date.now(),
    });
    this.executor.registerServiceSocketServer('rsyslog', this.rsyslogService);
    this.executor.rsyslogService = this.rsyslogService;
    this.rsyslogService.recharger();

    // La coherence entre l'ETAT DU SERVICE et l'ETAT DES FICHIERS : une
    // configuration fautive REFUSE le demarrage et le rechargement au
    // lieu de laisser une unite `active` derriere un demon qui n'a rien
    // lu. C'est le meme contrat que nginx et sshd tiennent deja.
    this.executor.serviceMgr.registerConfigCheck('rsyslog', () => {
      const svc = this.rsyslogService;
      if (!svc) return { ok: true };
      const manquant = checkRsyslogCriticalFiles({
        exists: (p) => this.executor.vfs.exists(p),
        readFile: (p) => this.executor.vfs.readFile(p),
      });
      if (!manquant.ok) return { ok: false, error: manquant.error ?? 'rsyslogd: configuration error' };
      const v = svc.verifierConfiguration();
      if (v.verdict === 'ok') return { ok: true };
      return { ok: false, error: v.erreur, verbatim: true };
    });

    // Demarrer, arreter et recharger OUVRENT et FERMENT les sockets pour
    // de bon. Sans cela, `systemctl stop rsyslog` laisserait le port 514
    // ouvert et la machine continuerait de recevoir apres l'arret.
    this.executor.serviceMgr.onLifecycle((event, name) => {
      if (name !== 'rsyslog') return;
      const svc = this.rsyslogService;
      if (!svc) return;
      if (event === 'stop') { svc.stopAll(); this.executor.resyncServicePorts('rsyslog'); return; }
      svc.recharger();
      this.publierPortsRsyslog();
      this.executor.resyncServicePorts('rsyslog');
    });
    this.publierPortsRsyslog();
  }

  /**
   * Declarer a la table des sockets les ports que la CONFIGURATION
   * demande. La liste vient du fichier et non d'une constante : c'est ce
   * qui fait qu'un `imudp` decommente puis recharge ouvre vraiment 514,
   * et qu'un `imudp` recommente le referme.
   */
  private publierPortsRsyslog(): void {
    const svc = this.rsyslogService;
    if (!svc) return;
    const ports = svc.listeningPorts();
    this.executor.serviceMgr.registerServiceListener('rsyslog', {
      processName: 'rsyslogd',
      sockets: ports.map((port) => ({ port, protocol: 'udp' as const })),
    });
  }

  /** Le serveur nginx de cette machine — `null` avant l'amorçage. */
  nginxService: LinuxNginxService | null = null;

  /** L'agent NTP de cette machine — le MÊME moteur que Cisco et Huawei. */
  private _ntpAgent: NtpAgent | null = null;
  getNtpAgent(): NtpAgent {
    if (!this._ntpAgent) {
      this._ntpAgent = new NtpAgent(this as unknown as NtpHost, () => this.getBus());
    }
    return this._ntpAgent;
  }

  /** Le démon chrony — `null` avant l'amorçage. */
  chronyService: LinuxChronyService | null = null;

  /**
   * chrony (`docs/PRD-NTP-Tutoriel.md` §4) — le paquet était déclaré
   * installé et RIEN n'existait : ni binaire, ni unité, ni fichier de
   * configuration. Une machine annonçait un logiciel qu'elle n'avait
   * pas, tandis que `timedatectl` affirmait sur la même machine
   * `System clock synchronized: yes` et `NTP service: active`.
   *
   * Le démon n'apporte pas un second moteur NTP : il pilote celui que
   * les routeurs utilisent déjà. Ce qu'il apporte est ce que chronyd
   * apporte vraiment — la lecture de son fichier de configuration.
   */
  private initChrony(): void {
    const vfs = this.executor.vfs;
    for (const dir of ['/etc/chrony', '/var/lib/chrony', '/var/log/chrony']) {
      if (!vfs.exists(dir)) vfs.mkdirp(dir, 0o755, 0, 0);
    }
    if (!vfs.exists(CHRONY_CONF_PATH)) {
      vfs.writeFile(CHRONY_CONF_PATH, LinuxChronyService.confParDefaut(), 0, 0, 0o022, true);
    }
    // Le paquet Debian dépose aussi le fichier de clés, VIDE de clés et
    // plein de commentaires — c'est ce que `keyfile` du fichier de
    // configuration désigne. Le mode 0640 root:root n'est pas décoratif :
    // un fichier de clés lisible par tous est le défaut que la
    // documentation de chrony signale en premier.
    if (!vfs.exists(CHRONY_KEYS_PATH)) {
      vfs.writeFile(CHRONY_KEYS_PATH, CHRONY_KEYS_DEBIAN, 0, 0, 0o137);
    }
    this.chronyService = new LinuxChronyService({
      readFile: (p) => vfs.readFile(p),
      ntp: () => this.getNtpAgent(),
    });
    this.executor.chronyService = this.chronyService;
    this.executor.ntpAgent = () => this.getNtpAgent();
    this.executor.dnsUpdateSender = () => (server, request, key) =>
      sendDynamicUpdate(this, server, request, 2000, key);

    // Le fichier absent EMPÊCHE le démarrage, le fichier vide non :
    // c'est la distinction que `CriticalFiles.ts` tient déjà pour sshd,
    // et elle vaut pour chronyd.
    this.executor.serviceMgr.registerConfigCheck('chrony', () => {
      const r = this.chronyService?.start();
      if (r && r.ok === false) return { ok: false, error: r.erreur, verbatim: true };
      return { ok: true };
    });
    this.executor.serviceMgr.onLifecycle((event, name) => {
      if (name !== 'chrony') return;
      if (event === 'stop') { this.chronyService?.stop(); return; }
      if (event === 'reload') this.chronyService?.reload();
    });
  }

  /** Déclare à systemd les ports que la configuration de nginx demande. */

  /**
   * docs/PRD-Manquements.md §M4a — apache2 really listens.
   *
   * Same wiring as nginx, deliberately: the two units have to behave the
   * same way under `systemctl`, otherwise the "compare the two servers"
   * lab also compares the simulator's own defects. They share port 80 and
   * therefore its conflict, in both directions.
   */
  private initApache(): void {
    const vfs = this.executor.vfs;
    for (const dir of ['/etc/apache2', APACHE_SITES_AVAILABLE, APACHE_SITES_ENABLED,
                       APACHE_MODS_ENABLED, APACHE_MODS_AVAILABLE, '/etc/apache2/conf-enabled',
                       APACHE_DOCROOT, '/var/log/apache2']) {
      if (!vfs.exists(dir)) vfs.mkdirp(dir, 0o755, 0, 0);
    }
    if (!vfs.exists(APACHE_CONF_PATH)) vfs.writeFile(APACHE_CONF_PATH, APACHE_CONF, 0, 0, 0o022, true);
    if (!vfs.exists(APACHE_PORTS_PATH)) vfs.writeFile(APACHE_PORTS_PATH, APACHE_PORTS_CONF, 0, 0, 0o022, true);
    // `envvars` is what makes `${APACHE_LOG_DIR}` mean something. Without
    // it the shipped `CustomLog ${APACHE_LOG_DIR}/access.log` names a
    // directory literally called `${APACHE_LOG_DIR}`, and no request is
    // ever logged where an operator looks for it.
    if (!vfs.exists(APACHE_ENVVARS_PATH)) {
      vfs.writeFile(APACHE_ENVVARS_PATH, APACHE_ENVVARS, 0, 0, 0o022, true);
    }
    const site = `${APACHE_SITES_AVAILABLE}/000-default.conf`;
    if (!vfs.exists(site)) vfs.writeFile(site, APACHE_DEFAULT_SITE, 0, 0, 0o022, true);
    // Available and NOT enabled, exactly as Debian ships it: `a2ensite
    // default-ssl` is the learner's own step, and so is producing the
    // certificate it names.
    const sslSite = `${APACHE_SITES_AVAILABLE}/default-ssl.conf`;
    if (!vfs.exists(sslSite)) vfs.writeFile(sslSite, APACHE_DEFAULT_SSL_SITE, 0, 0, 0o022, true);
    // `a2ensite` is only an `ln -s`: the link is what a learner removes
    // with `a2dissite`, so `rm` has to be enough too.
    if (!vfs.exists(`${APACHE_SITES_ENABLED}/000-default.conf`)) {
      vfs.createSymlink(`${APACHE_SITES_ENABLED}/000-default.conf`,
        '../sites-available/000-default.conf', 0, 0);
    }
    // The modules Debian enables at install time. `apachectl -M` READS
    // them rather than reciting them: an `ln -s` made by hand under
    // `mods-enabled` has to show up there and an `rm` has to remove it,
    // since that is all `a2enmod`/`a2dismod` do.
    // `mods-available` d'abord : c'est là que vivent les fichiers, et
    // `mods-enabled` n'en contient que des liens. Sans ce répertoire,
    // `a2enmod ssl` n'aurait rien à lier — et c'est la distinction
    // disponible/activé qui porte toute la leçon.
    for (const module of APACHE_AVAILABLE_MODULES) {
      const loadFile = `${APACHE_MODS_AVAILABLE}/${module}.load`;
      if (!vfs.exists(loadFile)) {
        vfs.writeFile(loadFile, apacheModuleLoadFile(module), 0, 0, 0o022, true);
      }
    }
    for (const module of APACHE_DEFAULT_MODULES) {
      const loadFile = `${APACHE_MODS_ENABLED}/${module}.load`;
      if (!vfs.exists(loadFile)) {
        vfs.createSymlink(loadFile, `../mods-available/${module}.load`, 0, 0);
      }
    }
    // Ubuntu's default page is only laid down if nginx has not already
    // written its own: both serve `/var/www/html`, and on a real machine
    // the last one installed does not overwrite the first either.
    const welcome = `${APACHE_DOCROOT}/index.html`;
    if (!vfs.exists(welcome)) vfs.writeFile(welcome, APACHE_DEFAULT_PAGE, 0, 0, 0o022, true);

    this.apacheService = new LinuxApacheService({
      fs: {
        read: (path) => vfs.readFile(path),
        list: (dir) => vfs.listDirectory(dir)?.map((e) => e.name) ?? null,
        exists: (path) => vfs.exists(path),
        isDirectory: (path) => vfs.listDirectory(path) !== null,
        readableBy: (path, uid, gid) => {
          const inode = vfs.resolveInode(path);
          return inode ? vfs.checkAccess(inode, 'r', uid, gid) : false;
        },
      },
      tcpStack: () => this.getTcpStack(),
      portTaken: (port) => this.getTcpStack().listListeners().some((l) => l.localPort === port),
      appendLog: (path, line) => this.executor.logMgr.appendLine(path, line),
      now: () => new Date(),
    });

    this.executor.registerServiceSocketServer('apache2', this.apacheService);
    this.executor.apacheService = this.apacheService;
    this.publishApachePorts();

    this.executor.serviceMgr.registerConfigCheck('apache2', () => {
      const service = this.apacheService;
      if (!service) return { ok: true };
      const error = service.loadConfig();
      const tls = error ? null : service.tlsProblem();
      const conflict = error ?? tls ? null : service.portConflict();
      const failure = error ?? tls ?? conflict;
      if (failure) {
        service.reportStartupFailure(failure);
        return { ok: false, error: failure, verbatim: true };
      }
      return { ok: true };
    });
    this.executor.serviceMgr.onLifecycle((event, name) => {
      if (name !== 'apache2') return;
      if (event === 'stop') { this.apacheService?.stopAll(); return; }
      if (event === 'reload') this.apacheService?.reload();
      this.publishApachePorts();
      this.executor.resyncServicePorts('apache2');
    });
  }

  private publishApachePorts(): void {
    const service = this.apacheService;
    if (!service) return;
    if (service.loadConfig() !== null) return;
    const ports = service.configuredPorts();
    if (ports.length === 0) return;
    this.executor.serviceMgr.registerServiceListener('apache2', {
      processName: 'apache2',
      sockets: ports.map((port) => ({ port, protocol: 'tcp' as const })),
    });
  }

  /** This machine's apache2 server — `null` before boot. */
  private apacheService: LinuxApacheService | null = null;

  private publishNginxPorts(): void {
    const service = this.nginxService;
    if (!service) return;
    if (service.loadConfig() !== null) return;
    const ports = service.configuredPorts();
    if (ports.length === 0) return;
    this.executor.serviceMgr.registerServiceListener('nginx', {
      processName: 'nginx',
      sockets: ports.map((port) => ({ port, protocol: 'tcp' as const })),
    });
  }

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

  private wireNetworkConfigLifecycle(): void {
    this.executor.serviceMgr.onLifecycle((event, name) => {
      if (event !== 'start' && event !== 'restart' && event !== 'reload') return;
      if (name === 'systemd-networkd') this.applyNetworkConfiguration();
      // `resolved.conf` n'était lu qu'à la toute première instanciation du
      // service : écrire `DNSOverTLS=` ou `DNSSEC=` puis redémarrer le
      // démon ne changeait rien, et le réglage global restait lettre morte.
      if (name === 'systemd-resolved') {
        this.loadResolvedConfig();
        this.loadDnssdServices();
      }
    });
  }

  /**
   * Ce que fait le démon quand il démarre ou relit : les fichiers natifs
   * d'abord, netplan ensuite pour ce qu'ils ne gouvernent pas. Avant, le
   * démon ne rejouait que netplan et un `.network` écrit à la main
   * n'avait aucun effet (`docs/PRD-networkd.md` §1.3, écart #1).
   */
  applyNetworkConfiguration(): { applied: string[]; warnings: string[] } {
    const existing = new Set(this.ports.keys());
    this.executor.netConfig.applyNetdevs(this.buildCommandContext().linkOps, existing);
    const native = this.executor.netConfig.applyNetworkd(this.net);
    const netplan = this.executor.netConfig.applyNetplan(this.net, native.governed);
    return {
      applied: [...native.applied, ...netplan.applied],
      warnings: netplan.warnings,
    };
  }

  /** True tant que systemd-networkd tourne — personne ne configure sinon. */
  isNetworkdActive(): boolean {
    return this.executor.serviceMgr.isActive('systemd-networkd');
  }

  private readonly _sshdActivePorts = new Set<number>();

  private sshdPortsFromConfig(): number[] {
    const raw = this.executor.vfs.readFile('/etc/ssh/sshd_config') ?? '';
    const ports = Array.from(raw.matchAll(/^\s*Port\s+(\d+)/gim))
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n) && n > 0 && n < 65536);
    return ports.length ? ports : [22];
  }

  /**
   * sshd, sur les deux familles d'adresses
   * (docs/PRD-Sockets-Une-Seule-Verite.md §P2b).
   *
   * Deux `socketTable.bind()` manuels posaient ces lignes à côté, avec le
   * pid et la bannière ; l'identité voyage maintenant avec l'écoute. Le
   * point délicat est l'écoute `::` : l'entrée `:::22` figurait dans `ss`
   * sans écoute propre, `findListener` rabattant une connexion v6 sur le
   * générique v4. Retirer le doublon sans ouvrir cette écoute aurait donc
   * créé en IPv6 l'erreur même que ce chantier corrige.
   */
  private static readonly SSHD_PID = 985;
  private static readonly SSHD_BANNER = 'SSH-2.0-Sandbox-Server\r\n';
  private static readonly SSHD_ADDRESSES = ['0.0.0.0', '::'] as const;

  private attachSshTcpListeners(): void {
    const stack = this.getTcpStack();
    const desired = new Set(this.sshdPortsFromConfig());
    for (const port of this._sshdActivePorts) {
      if (!desired.has(port)) {
        for (const addr of LinuxMachine.SSHD_ADDRESSES) stack.closeListener(port, addr);
        this._sshdActivePorts.delete(port);
      }
    }
    for (const port of desired) {
      if (this._sshdActivePorts.has(port)) continue;
      for (const addr of LinuxMachine.SSHD_ADDRESSES) {
        try {
          stack.listen(port, {
            identity: {
              pid: LinuxMachine.SSHD_PID,
              processName: 'sshd',
              banner: LinuxMachine.SSHD_BANNER,
            },
            onAccept: (socket) => {
              stack.setSocketOwner(socket, LinuxMachine.SSHD_PID);
              this.getSshServerHandler().register(socket as unknown as TcpStream, socket.remoteIp);
            },
          }, addr);
        } catch { /* déjà ouverte sur cette adresse */ }
      }
      this._sshdActivePorts.add(port);
    }
  }

  private detachSshTcpListeners(): void {
    const stack = this.getTcpStack();
    for (const port of this._sshdActivePorts) {
      for (const addr of LinuxMachine.SSHD_ADDRESSES) stack.closeListener(port, addr);
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
    // Account/password expiry (chage -E / -M) is a PAM *account*-phase
    // concern, checked after credentials verify — see
    // accountLifecycleGate() and its call site further down this file —
    // not here, which only gates policy that must refuse before any
    // auth method is even attempted (locked, DenyUsers, ...).
    return { ok: true };
  }

  private readonly sshPeerPorts: Map<string, number> = new Map();
  private sshNextClientPort = 0;

  private sshClientPort(fromIp: string): number {
    const known = this.sshPeerPorts.get(fromIp);
    if (known !== undefined) return known;
    const { min, max } = this.getTcpStack().getEphemeralRange();
    if (this.sshNextClientPort === 0) this.sshNextClientPort = min;
    const port = this.sshNextClientPort;
    this.sshNextClientPort = port >= max ? min : port + 1;
    this.sshPeerPorts.set(fromIp, port);
    return port;
  }

  sshForgetPeerPort(fromIp: string): void {
    this.sshPeerPorts.delete(fromIp);
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
    failureReason = 'authentication failure',
  ): void {
    const events = this.getSshServerContext().events;
    const port = this.sshClientPort(fromIp);
    if (accepted) {
      events.emit({ kind: 'auth_success', user, method: authMethod, ip: fromIp, fromHost, port });
    } else {
      const validUser = this.executor.userMgr.getUser(user) !== undefined;
      if (!validUser) {
        events.emit({ kind: 'auth_invalid_user', user, ip: fromIp, port });
      }
      events.emit({
        kind: 'auth_failure', user, method: authMethod, ip: fromIp, fromHost,
        port, reason: failureReason, validUser,
      });
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
      this.materializePtsNode(session.tty, uid, gid);
      this.executor.lastlog.record(user, fromIp, session.tty);
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
      events.emit({ kind: 'channel_opened', user, channelType: 'shell' });
      this.emitSessionOpenedLog(user, uid, sshdChild.pid, String(shell.pid));
      const myIp = this.getPorts()
        .map((p) => p.getIPAddress()?.toString())
        .find((ip): ip is string => !!ip) ?? '0.0.0.0';
      const peerPort = this.sshClientPort(fromIp);
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

  scheduleSshLogout(user: string, fromIp: string, holdSeconds: number): void {
    if (holdSeconds <= 0) { this.recordSshLogout(user, fromIp); return; }
    this.getScheduler().setTimeout(
      () => this.recordSshLogout(user, fromIp),
      holdSeconds * 1000,
    );
  }

  recordSshLogout(user: string, fromIp: string): void {
    const session = this.sessionTable.list()
      .find((s) => s.user === user && s.fromIp === fromIp && !s.closedAt);
    const port = this.sshClientPort(fromIp);
    if (session) {
      const sid = String(session.shellPid ?? session.sshdPid ?? 0);
      if (session.shellPid) this.executor.processMgr.reap(session.shellPid);
      if (session.sshdPid) this.executor.processMgr.reap(session.sshdPid);
      this.sessionTable.close(session.tty, 'normal');
      this.removePtsNode(session.tty);
      this.dropLogindSession(sid, session.uid);
      this.emitSessionClosedLog(user, session.sshdPid ?? 0, sid);
      this.socketTable.removeConnection({
        protocol: 'tcp', localPort: 22, remoteAddress: fromIp, remotePort: port,
      });
    }
    this.getSshServerContext().events.emit({
      kind: 'client_disconnected', user, ip: fromIp, port,
      authenticated: session !== undefined, reason: 'client_disconnect',
    });
    this.sshForgetPeerPort(fromIp);
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
    const previousCwd = this.executor.getCwd();
    const userEntry = um.getUser(user);
    if (userEntry) {
      um.currentUser = user;
      um.currentUid = userEntry.uid;
      um.currentGid = userEntry.gid;
      this.executor.setCwd(userEntry.home ?? `/home/${user}`);
    }
    try {
      const output = this.executor.execute(command);
      const normalised = output && !output.endsWith('\n') ? `${output}\n` : output;
      return { output: normalised, exitCode: this.executor.lastExitCode ?? 0 };
    } finally {
      um.currentUser = previousUser;
      um.currentUid = previousUid;
      um.currentGid = previousGid;
      this.executor.setCwd(previousCwd);
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
    const existed = this.sessionTable.list().some((s) => s.tty === 'tty1');
    this.sessionTable.ensureConsoleSession(user, uid);
    if (!existed) this.executor.lastlog.record(user, '', 'tty1');
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

  /** Materialise `/dev/pts/N` for a newly opened pty session — `ls
   *  /dev/pts/` (excluding ptmx) is real Linux's own way of counting
   *  active pseudo-terminals, and `who`/`w` must agree with it. */
  private materializePtsNode(tty: string, uid: number, gid: number): void {
    if (!tty.startsWith('pts/')) return;
    // The devpts filesystem, not the logging-in user, creates the slave
    // node — real Linux never requires write access to /dev/pts itself
    // to get a pty. Create as root, then hand ownership to the session.
    const inode = this.executor.vfs.createFileAt(`/dev/${tty}`, '', 0o620, 0, 0);
    if (inode) this.executor.vfs.chown(`/dev/${tty}`, uid, gid);
  }

  private removePtsNode(tty: string): void {
    if (!tty.startsWith('pts/')) return;
    this.executor.vfs.deleteFile(`/dev/${tty}`);
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
      this.removePtsNode(s.tty);
      this.dropLogindSession(sessionId, s.uid);
      this.emitSessionClosedLog(s.user, sshdPid, sessionId);
      this.getSshServerContext().events.emit({
        kind: 'client_disconnected', user: s.user, ip: s.fromIp,
        port: this.sshClientPort(s.fromIp), authenticated: true,
        reason: 'admin_disconnect',
      });
      this.sshForgetPeerPort(s.fromIp);
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
    void uid; void sshdPid;
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
    void sshdPid;
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

  /**
   * Name servers learned by DHCPv6 JOIN those already there rather than
   * replacing them. The v4 path rewrites the whole file, which is enough
   * while it is alone; a dual-stack host takes both leases, and the
   * second would silently erase the first resolver.
   */
  protected override onDhcpv6LeaseConfigured(
    iface: string, dnsServers: readonly string[], domainName: string | null,
  ): void {
    void iface;
    if (dnsServers.length === 0) return;
    const existant = (this.executor.readFile('/etc/resolv.conf') ?? '')
      .split('\n').filter((l) => l.trim() !== '');
    const lignes = [...existant];
    if (domainName && !lignes.some((l) => l.trim() === `search ${domainName}`)) {
      lignes.unshift(`search ${domainName}`);
    }
    for (const ip of dnsServers) {
      if (!lignes.some((l) => l.trim() === `nameserver ${ip}`)) lignes.push(`nameserver ${ip}`);
    }
    this.executor.vfs.writeFile('/etc/resolv.conf', lignes.join('\n') + '\n', 0, 0, 0o022);
    if (!this.dnsResolverIP && dnsServers[0]) this.dnsResolverIP = dnsServers[0];
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
    // Les deux `bind()` de sshd sont partis : `attachSshTcpListeners()`
    // ouvre les écoutes v4 ET v6 en portant pid, nom et bannière, donc
    // les lignes de `ss` viennent de l'écoute elle-même (§P2b).
    // L'entrée 127.0.0.53:53 est posée par bindResolvedStub(), avec un
    // vrai gestionnaire derrière — plus un bind() décoratif.

    if (isServer) this.bindTnsListener();
  }

  /**
   * Le listener TNS, réellement à l'écoute dès l'amorçage
   * (docs/PRD-Sockets-Une-Seule-Verite.md §P2c).
   *
   * Ces deux ports étaient la dernière entrée décorative : `ss` les
   * montrait, `lsnrctl status` annonçait le listener démarré, `ps`
   * affichait un vrai `tnslsnr` — et une connexion venue d'une autre
   * machine était refusée. Elle ne réussissait qu'APRÈS qu'une commande
   * Oracle ait été tapée sur la console du serveur, parce que c'est
   * `getOracleDatabase()` qui matérialisait la base et attachait
   * `OracleListenerNetworkBinding`. Un client distant dépendait donc de
   * ce que l'opérateur avait tapé en local : même défaut de
   * matérialisation paresseuse que les rôles Windows corrigés par
   * `docs/PRD-Curl.md` §P2.
   *
   * L'écoute posée ici est celle que `dbstart`/systemd auraient ouverte
   * au démarrage — ce que le commentaire de `startListener()` affirmait
   * déjà. Elle ne parle pas TNS : elle accepte, puis referme, ce que
   * fait aussi `OracleListenerNetworkBinding` pour une sonde. Quand la
   * base se matérialise, ce binding reprend le port (il ferme l'écoute
   * en place avant d'ouvrir la sienne), et `lsnrctl stop` le ferme pour
   * de bon.
   */
  private bindTnsListener(): void {
    const stack = this.getTcpStack();
    const identity = { pid: 2001, processName: 'tnslsnr', banner: TNS_BOOT_BANNER };
    for (const addr of ['0.0.0.0', '::']) {
      try {
        stack.listen(TNS_PORT, { onAccept: (socket) => socket.close(), identity }, addr);
      } catch { /* déjà ouvert */ }
    }
  }

  // ─── Ports ───────────────────────────────────────────────────────────

  /**
   * `lo`, l'interface de bouclage — un VRAI port, non plus une fiction.
   *
   * Elle était synthétisée dans le rendu (`getInterfaceInfo` fabriquait
   * un objet quand on lui demandait `lo`) sans qu'aucun port n'existe
   * derrière, si bien que `ip link show lo` la décrivait pendant que
   * `ip addr add 10.0.0.1/32 dev lo` — le laboratoire entier de la
   * partie Linux du sujet — répondait `Cannot find device "lo"` sur la
   * même machine au même instant. Une adresse ajoutée sur la boucle
   * n'avait nulle part où être rangée.
   *
   * Le noyau la crée au démarrage et elle ne peut pas être supprimée :
   * elle est donc posée ici, avant les ports physiques, avec les
   * propriétés que Linux lui donne — MTU 65536 (aucune contrainte
   * matérielle), MAC nulle, 127.0.0.1/8 et ::1/128, toujours UP.
   */
  private createLoopbackPort(): void {
    const lo = new Port('lo', 'ethernet', new MACAddress('00:00:00:00:00:00'),
      { loopback: true });
    lo.setMTU(65536);
    lo.setUp(true);
    lo.configureIP(new IPAddress('127.0.0.1'), SubnetMask.fromCIDR(8));
    lo.configureIPv6(new IPv6Address('::1'), 128);
    this.addPort(lo);
  }

  private createPortsFromProfile(): void {
    const { portCount, portPrefix } = this.profile;
    for (let i = 0; i < portCount; i++) {
      const port = new Port(`${portPrefix}${i}`, 'ethernet');
      port.onLinkChange((state) => {
        if (state === 'up' && !port.isIPv6Enabled()) port.enableIPv6();
      });
      this.addPort(port);
    }
    // `lo` est ajoutee APRES les cartes physiques, et c'est deliberé :
    // beaucoup de code designe « la premiere carte » par le premier port
    // (cablage, laboratoires), et la boucle n'est la premiere carte de
    // rien. L'ordre d'AFFICHAGE ne s'en trouve pas change : `ip` la
    // place en tete explicitement, comme le vrai.
    this.createLoopbackPort();
  }

  // ─── Command registry hooks ──────────────────────────────────────────


  /**
   * Can a REGISTRY command run at all? (docs/PRD-Pannes.md §F7.7)
   *
   * `dispatch()` already asked this at the top of its switch, but a
   * command served by the registry never goes through it: it arrives via
   * `tryNetworkCommand` or via bash's runner. Measured, with `curl` as the
   * control: `rm /usr/bin/curl` then `curl` still worked — and likewise
   * for `xxd`, `bc`, `nmap`, `nginx`, `ss`, `nc`, `openssl`. An `rm` that
   * does nothing teaches that the command comes from no file at all.
   *
   * Two sources, in this order: the shared table first (it also carries
   * the critical data files), then the `binaryPath` the command declares
   * itself — that is why the field exists, and it covers the ones the
   * table does not name.
   */
  private registryDependencyFailure(
    cmd: LinuxCommand, name: string,
  ): { output: string; exitCode: number } | null {
    const missing = checkCommandDependencies(this.executor.vfs, name, cmd.criticalFiles);
    if (missing) return { output: missing.message, exitCode: missing.exitCode };
    if (cmd.binaryPath && !this.executor.vfs.exists(canonicalBinPath(cmd.binaryPath))) {
      return { output: commandNotFoundMessage(name, cmd.binaryPath), exitCode: 127 };
    }
    return null;
  }

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

  /**
   * Exit code for a registry command run from inside a bash script (used
   * by `$?`/`||` chaining, which the top-level per-command dispatch never
   * needed). Matches the real tools' own conventions: `named-checkconf`
   * prints nothing on success; `named-checkzone` ends its success output
   * with a literal "OK" line. Anything else defaults to success — these
   * commands were unreachable from scripts before this bridge existed, so
   * there's no established failure convention yet to regress against.
   */
  private inferRegistryExitCode(cmd: string, output: string): number {
    if (cmd === 'named-checkconf') return output === '' ? 0 : 1;
    if (cmd === 'named-checkzone') return output === '' || output.endsWith('OK') ? 0 : 1;
    return 0;
  }

  /** Build the context object passed to every `LinuxCommand.run()` call. */
  protected buildCommandContext(outputPiped = false): LinuxCommandContext {
    return {
      outputPiped,
      executor: this.executor,
      net: this.net,
      netConfig: this.executor.netConfig,
      tlsTrustAnchors: this.trustedCAs,
      addTlsTrustAnchor: (cert) => { this.addTrustedCertificateAuthority(cert); },
      dnsService: this.dnsService,
      bind9: this.bind9,
      dhcpd: this.dhcpd,
      xfrm: this.xfrmCtx,
      profile: this.profile,
      fmt: this.fmt,
      greAgent: this.greAgentInstance,
      linkOps: {
        addDummy: (name: string) => this.addDummyInterface(name),
        addVeth: (name: string, peerName: string) => this.addVethPair(name, peerName),
        addVlan: (name: string, parent: string, vid: number) => this.addVlanSubInterface(name, parent, vid),
        deleteLink: (name: string) => this.deleteVirtualInterface(name),
      },
      netns: {
        add: (name: string) => this.addNetNamespace(name),
        remove: (name: string) => this.deleteNetNamespace(name),
        list: () => this.listNetNamespaces(),
        exec: (name: string, cmdLine: string) => this.execInNamespace(name, cmdLine),
      },
      maddr: {
        join: (ifName: string, group: string) => this.joinMulticastGroup(ifName, group),
        leave: (ifName: string, group: string) => this.leaveMulticastGroup(ifName, group),
        list: (ifName?: string) => this.listMulticastGroups(ifName),
      },
      sshServerConfig: () => this.getSshServerContext().effectiveSshdServerConfig(),
    };
  }

  /** Real GRE engine backing `ip tunnel`; exposed for direct tunnel-traffic testing. */
  getGreAgent(): GreAgent { return this.greAgentInstance; }

  // ─── ip link add/delete (veth, vlan, dummy) ──────────────────────

  private addDummyInterface(name: string): string {
    if (this.ports.has(name)) return 'RTNETLINK answers: File exists';
    // Une interface `dummy` n'a pas de porteuse : rien n'est branché au
    // bout et rien ne peut l'être. Sans cela, elle sortait
    // `<NO-CARRIER,BROADCAST,UP,MULTICAST> … state DOWN` alors que le
    // vrai Linux écrit `<BROADCAST,NOARP,UP,LOWER_UP> … state UNKNOWN`,
    // et `ip link set … up` ne changeait rien à ce qu'on lisait.
    // Le noyau charge le module a la demande : `ip link add … type
    // dummy` fonctionne sans `modprobe dummy` prealable sur une vraie
    // machine, et `lsmod` montre le module APRES coup. Passer par la
    // meme table que `modprobe` est ce qui rend les deux vues d'accord.
    this.executor.kernelModules.load('dummy');
    const port = new Port(name, 'ethernet', undefined, { carrierless: true });
    port.setUp(true);
    this.addPort(port);
    this.virtualInterfaces.add(name);
    return '';
  }

  private addVethPair(name: string, peerName: string): string {
    if (this.ports.has(name) || this.ports.has(peerName)) return 'RTNETLINK answers: File exists';
    const portA = new Port(name, 'ethernet');
    const portB = new Port(peerName, 'ethernet');
    portA.setUp(true);
    portB.setUp(true);
    this.addPort(portA);
    this.addPort(portB);
    new Cable(`veth-${this.id}-${name}-${peerName}`).connect(portA, portB);
    this.virtualInterfaces.add(name);
    this.virtualInterfaces.add(peerName);
    return '';
  }

  private addVlanSubInterface(name: string, parent: string, vid: number): string {
    if (this.ports.has(name)) return 'RTNETLINK answers: File exists';
    const parentPort = this.ports.get(parent);
    if (!parentPort) return `Cannot find device "${parent}"`;
    const port = new Port(name, 'ethernet', parentPort.getMAC());
    port.setUp(true);
    this.addPort(port);
    this.virtualInterfaces.add(name);
    this.vlanSubInterfaces.set(name, { parent, vid });
    return '';
  }

  private deleteVirtualInterface(name: string): string {
    if (!this.virtualInterfaces.has(name)) {
      return this.ports.has(name)
        ? `RTNETLINK answers: Operation not permitted`
        : `Cannot find device "${name}"`;
    }
    this.ports.delete(name);
    this.virtualInterfaces.delete(name);
    this.vlanSubInterfaces.delete(name);
    return '';
  }

  // ─── ip netns ─────────────────────────────────────────────────────

  private addNetNamespace(name: string): string {
    if (this.netNamespaces.has(name)) {
      return `Cannot create namespace file "/var/run/netns/${name}": File exists`;
    }
    this.netNamespaces.set(name, { routingTable: [], arpTable: new Map(), defaultGateway: null });
    return '';
  }

  private deleteNetNamespace(name: string): string {
    if (!this.netNamespaces.has(name)) {
      return `Cannot remove namespace file "/var/run/netns/${name}": No such file or directory`;
    }
    this.netNamespaces.delete(name);
    return '';
  }

  private listNetNamespaces(): string[] {
    return [...this.netNamespaces.keys()];
  }

  /**
   * Run a command with this namespace's routing/ARP/default-gateway state
   * swapped in for the duration of the call — genuine isolation between
   * namespaces reusing the existing route-resolution/ARP logic unchanged.
   */
  private async execInNamespace(name: string, cmdLine: string): Promise<string> {
    const ns = this.netNamespaces.get(name);
    if (!ns) return `Cannot open network namespace "${name}": No such file or directory`;

    const savedRouting = this.routingTable;
    const savedArp = this.arpTable;
    const savedGateway = this.defaultGateway;

    this.routingTable = ns.routingTable;
    this.arpTable = ns.arpTable;
    this.defaultGateway = ns.defaultGateway;

    try {
      return await this.executeCommand(cmdLine);
    } finally {
      ns.routingTable = this.routingTable;
      ns.arpTable = this.arpTable;
      ns.defaultGateway = this.defaultGateway;
      this.routingTable = savedRouting;
      this.arpTable = savedArp;
      this.defaultGateway = savedGateway;
    }
  }

  override sendFrame(portName: string, frame: EthernetFrame): boolean {
    const vlanSub = this.vlanSubInterfaces.get(portName);
    if (vlanSub) {
      const tagged: TaggedEthernetFrame = {
        ...frame,
        dot1q: { tpid: 0x8100, pcp: 0, dei: 0, vid: vlanSub.vid },
      };
      // Real transmission already happened above; this is a second,
      // capture-only signal so `tcpdump -i eth0.100` sees the untagged
      // frame (the subinterface has no `Cable` of its own to publish it).
      const sent = super.sendFrame(vlanSub.parent, tagged);
      this.getBus().publish({
        topic: 'port.frame.tx-requested',
        payload: { deviceId: this.id, portName, frame },
      });
      return sent;
    }
    return super.sendFrame(portName, frame);
  }

  protected override handleFrame(portName: string, frame: EthernetFrame): void {
    const tagged = frame as TaggedEthernetFrame;
    if (tagged.dot1q) {
      for (const [subName, sub] of this.vlanSubInterfaces) {
        if (sub.parent === portName && sub.vid === tagged.dot1q.vid) {
          const { dot1q, ...untagged } = tagged;
          const subPort = this.getPort(subName);
          if (subPort) {
            subPort.receiveFrame(untagged);
            return;
          }
          super.handleFrame(subName, untagged);
          return;
        }
      }
      return;
    }
    super.handleFrame(portName, frame);
  }

  /**
   * A VLAN sub-interface's own `Port` is never cabled (see
   * `addVlanSubInterface` — frames are tunneled through the parent via
   * the `sendFrame` override above), so `Port.isOperationallyUp()` on it
   * always reports no carrier even though the parent link is up. Reflect
   * the parent's real carrier for a sub-interface instead.
   */
  protected override isInterfaceOperationallyUp(portName: string, port: Port): boolean {
    const vlanSub = this.vlanSubInterfaces.get(portName);
    if (!vlanSub) return super.isInterfaceOperationallyUp(portName, port);
    const parentPort = this.ports.get(vlanSub.parent);
    return port.getIsUp() && !port.isAdminDown() && !!parentPort?.isOperationallyUp();
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
      { device: this },
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
      // Existence comes first, and it is NOT the same question as content.
      // Every reader of sshd_config does `?? ''`, so a deleted file used to
      // validate as an empty one — which is legal — and sshd started on
      // defaults as if nothing had happened (docs/PRD-Pannes.md §F7.1).
      const files = checkSshdCriticalFiles(this.executor.vfs);
      if (!files.ok) return files;

      const raw = this.executor.vfs.readFile('/etc/ssh/sshd_config') ?? '';
      const verdict = validateSshdConfig(raw);
      return verdict.ok
        ? { ok: true }
        : { ok: false, error: verdict.errors.join('\n') };
    });
    const isSsh = (p: { name: string }): boolean => p.name === 'ssh' || p.name === 'sshd';
    const reload = (): void => {
      this._sshContext = this._sshContext?.reloadConfig() ?? null;
      this.executor.logMgr.logSystemd('ssh', 'Received SIGHUP; restarting.');
    };
    const offRestart = bus.subscribeWhere('linux.service.restarted', isSsh, reload);
    const offReload = bus.subscribeWhere('linux.service.reloaded', isSsh, reload);
    // Ouvrir et refermer les écoutes suffit : elles s'inscrivent et se
    // retirent elles-mêmes de la table que lit `ss` (§P2b). Les
    // `bind()`/`unbind()` manuels qui doublaient ce cycle réinscrivaient
    // les mêmes lignes à côté, ce qui rendait le puits muet pour sshd —
    // son `announce` se tait sur un port déjà lié — et l'écoute cessait
    // d'être la seule à décider ce qui s'affiche.
    const rebindPorts = (): void => { this.attachSshTcpListeners(); };
    const offStopped = bus.subscribeWhere('linux.service.stopped', isSsh, () => {
      this.detachSshTcpListeners();
    });
    const offStarted = bus.subscribeWhere('linux.service.started', isSsh, rebindPorts);
    const offReloadPorts = bus.subscribeWhere('linux.service.reloaded', isSsh, rebindPorts);
    const offRestartPorts = bus.subscribeWhere('linux.service.restarted', isSsh, rebindPorts);
    this._sshLifecycleOff = () => { offRestart(); offReload(); offStopped(); offStarted(); offReloadPorts(); offRestartPorts(); };
    (this.executor as unknown as { sshContextForFail2ban?: (() => {
      bannedIps(): string[];
      totalAuthFailures(): number;
      unbanIp(ip: string): boolean;
      bantimeSeconds(): number;
    }) | null })
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
    if (LinuxMachine.SSHPASS_TRANSFER_RE.test(input)) return true;
    if (LinuxMachine.TRANSFER_RE.test(input)) return true;
    const words = input.split(/[\s;|&"'`()]+/);
    if (words.some(w => w === 'ps' || w === 'man' || w === 'sshd')) return true;
    // `bash script.sh` / `./script.sh` / `run-parts DIR` at the top of the
    // line: a network command (`ssh`, `curl`, …) may be hiding inside the
    // script file's content, invisible to the string scan above — treat
    // the whole line as network-possible so it is routed through the
    // async dispatcher instead of silently taking the synchronous path.
    return LinuxMachine.SCRIPT_FILE_HEAD_RE.test(input);
  }

  /**
   * `sshpass -p <pw> scp|sftp ...`: the only way scp/sftp can offer a
   * real credential (audit 03, MAJEUR §4) — routed through the async
   * network-command path because opening a genuinely authenticated
   * SshSession for the real-wire transfer needs `await`, which the
   * synchronous `execute()` pipeline `runSshTransport` normally runs
   * under cannot provide. Bare `scp`/`sftp` (no sshpass, the overwhelming
   * majority of existing usage) is untouched and stays on the sync path.
   */
  private static readonly SSHPASS_TRANSFER_RE = /^sshpass\s+-p\s+\S+\s+(scp|sftp)\b/;

  /**
   * `scp`/`sftp` en tête de ligne, sans `sshpass`. Un transfert sans mot de
   * passe est le cas ordinaire — et sur une vraie machine, s'il aboutit
   * c'est parce qu'une CLÉ l'authentifie. Ces lignes partaient jusqu'ici
   * sur le chemin synchrone, qui ne peut pas `await` l'ouverture d'une
   * vraie session : le transfert copiait donc d'un VFS à l'autre sans
   * qu'aucun octet ne traverse un câble (Phase 4 de la refonte SSH).
   * Elles passent maintenant par le dispatcher async, qui tente la vraie
   * session par clé publique avant de retomber, si elle échoue, sur le
   * comportement inchangé.
   */
  private static readonly TRANSFER_RE = /^\s*(?:sudo\s+)?(scp|sftp)\s+\S/;

  /**
   * Matches a top-of-line `bash`/`sh` file invocation (no `-c`), a direct
   * `./script`/`/path/script` execution, or `run-parts DIR` — the three
   * forms where {@link containsNetworkCommand}'s literal-token scan cannot
   * see whether a network command is hiding inside the invoked file.
   */
  private static readonly SCRIPT_FILE_HEAD_RE =
    /^\s*(?:sudo\s+)?(?:bash|sh)\s+(?!-[a-zA-Z]*c\b)\S|^\s*(?:sudo\s+)?(?:\.\/|\/)\S|^\s*(?:sudo\s+)?run-parts\s+\S/;

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
    if (LinuxMachine.SCRIPT_FILE_HEAD_RE.test(input)) return true;
    return false;
  }

  /** Advance the simulated clock — completes due background jobs/at-jobs/cron ticks. */
  advanceTime(ms: number): void {
    this.executor.advanceTime(ms);
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
    // user-manager output because the session table is the live truth —
    // but only for a bare invocation. `who | wc -l` etc. must still go
    // through the bash interpreter's real pipe/redirect machinery, or
    // the pipe/flag tokens after `who` get fed to who's own arg parser.
    if (!LinuxMachine.hasCompositeSyntax(trimmed) && !this.hasShellConstructs(trimmed)) {
      const sessionView = this.renderSessionView(trimmed);
      if (sessionView !== null) return sessionView;
    }

    if (!this.containsNetworkCommand(trimmed)) {
      return this.executor.execute(trimmed);
    }

    if (LinuxMachine.hasCompositeSyntax(trimmed) || this.hasShellConstructs(trimmed)) {
      return this.executor.executeAsync(trimmed);
    }

    // Single command: strip sudo, try network dispatch.
    const networkResult = await this.tryNetworkCommand(trimmed);
    if (networkResult !== null) return networkResult;

    // Otherwise, fall through to the bash interpreter (async: the line
    // may still reference a network command in argument position).
    return this.executor.executeAsync(trimmed);
  }

  /**
   * True when the line uses shell composition — pipes, sequencing,
   * logicals, redirections, substitution — that must run through the
   * interpreter (with the async network bridge) rather than the
   * single-command network fast path. Quote-aware: separators inside
   * single/double quotes don't count; `$(` and backticks stay active
   * inside double quotes, exactly like bash.
   */
  private static hasCompositeSyntax(input: string): boolean {
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (quote === "'") {
        if (ch === "'") quote = null;
        continue;
      }
      if (ch === '`') return true;
      if (ch === '$' && input[i + 1] === '(') return true;
      if (quote === '"') {
        if (ch === '"') quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '|' || ch === ';' || ch === '&' || ch === '<' || ch === '>' || ch === '\n') {
        return true;
      }
    }
    return false;
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

  /**
   * Shared `sudo` elevation + declarative privilege gate used by every
   * dispatch path in `tryNetworkCommand` that bypasses
   * `LinuxCommandExecutor.dispatch()` (whose own privilege check at
   * `commandPrivileges.check()` only runs for commands that fall through
   * to the bash interpreter).
   */
  private async withSudoAndPrivilegeGate(
    firstCmd: string,
    args: string[],
    isSudo: boolean,
    privilege: PrivilegeRequirement | undefined,
    run: () => Promise<string> | string,
  ): Promise<string> {
    const userMgr = this.executor.userMgr;
    let auth: SudoAuthorization | null = null;
    if (isSudo) {
      auth = this.executor.authorizeSudo(firstCmd, args, 'root');
      if (auth.reason === 'not-in-sudoers' || auth.reason === 'unknown-target-user') {
        this.executor.writeSudoAuditLine('not-in-sudoers', auth, [firstCmd, ...args].join(' '));
        return `${auth.invokingUser} is not in the sudoers file. This incident will be reported.`;
      }
      if (auth.reason === 'command-not-allowed') {
        this.executor.writeSudoAuditLine('command-not-allowed', auth, [firstCmd, ...args].join(' '));
        return `Sorry, user ${auth.invokingUser} is not allowed to execute '${[firstCmd, ...args].join(' ')}' as ${auth.runasUser} on ${auth.hostname}.`;
      }
    }
    const savedUser = isSudo
      ? { user: userMgr.currentUser, uid: userMgr.currentUid, gid: userMgr.currentGid }
      : null;
    if (savedUser) {
      userMgr.currentUser = 'root';
      userMgr.currentUid = 0;
      userMgr.currentGid = 0;
      this.executor.writeSudoAuditLine('success', auth!, [firstCmd, ...args].join(' '));
    }
    try {
      const actor = {
        uid: userMgr.currentUid,
        user: userMgr.currentUser,
        groups: userMgr.getUserGroups(userMgr.currentUser).map((g) => g.name),
      };
      const denial = privilege
        ? evaluatePrivilegeRequirement(privilege, firstCmd, args, actor)
        : this.executor.commandPrivileges.check(firstCmd, args, actor);
      if (denial) return denial.output;
      return await run();
    } finally {
      if (savedUser) {
        userMgr.currentUser = savedUser.user;
        userMgr.currentUid = savedUser.uid;
        userMgr.currentGid = savedUser.gid;
      }
    }
  }

  private async tryNetworkCommand(input: string): Promise<string | null> {
    const isSudo = input.startsWith('sudo ');
    const noSudo = isSudo ? input.slice(5).trim() : input;
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
      const tokenized = LinuxMachine.tokenizeArgsDetailed(noSudo);
      if (tokenized.unterminatedQuote) {
        return 'bash: syntax error: unexpected end of file (unterminated quote)';
      }
      const cmdArgs = tokenized.tokens.slice(1);
      // --help flag: return auto-generated help instead of running.
      if (cmdArgs.includes('--help')) {
        return renderHelp(cmd);
      }

      // A registry command bypasses LinuxCommandExecutor's dispatch(), so
      // the declarative privilege gate (and `sudo` elevation) that gate
      // applies there must be re-applied here explicitly. Likewise `$?`:
      // dispatch() would have set it from the command's real exit code,
      // so a status-aware command sets it here too instead of leaving
      // whatever the previous command left behind (bare run() commands
      // have no exit code to report and implicitly succeed, as before).
      // A plain terminal view shows stdout and stderr together (no
      // redirect has separated them here), matching what `run()` alone
      // already did for commands — like tcpdump — whose stderr carries
      // real content (its capture summary) that `runWithStatus`'s status
      // field otherwise leaves stranded off `output`.
      // The third path a registry command can leave by — the
      // single-command one. All three ask the same question, otherwise
      // `rm /usr/bin/curl` would only affect some ways of typing it.
      const unavailable = this.registryDependencyFailure(cmd, firstCmd);
      if (unavailable) {
        this.executor.lastExitCode = unavailable.exitCode;
        return unavailable.output;
      }
      return this.withSudoAndPrivilegeGate(
        firstCmd, cmdArgs, isSudo, cmd.privilege,
        async () => {
          if (cmd.runWithStatusSync) {
            const result = cmd.runWithStatusSync(this.buildCommandContext(), cmdArgs);
            this.executor.lastExitCode = result.exitCode;
            return [result.output, result.stderr].filter((s) => s).join('\n');
          }
          if (cmd.runWithStatus) {
            const result = await cmd.runWithStatus(this.buildCommandContext(), cmdArgs);
            this.executor.lastExitCode = result.exitCode;
            return [result.output, result.stderr].filter((s) => s).join('\n');
          }
          this.executor.lastExitCode = 0;
          return cmd.run(this.buildCommandContext(), cmdArgs);
        },
      );
    }

    // 2. Commands that need special handling outside the registry
    switch (firstCmd) {
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
      case 'sshpass': {
        const match = LinuxMachine.SSHPASS_TRANSFER_RE.exec(noSudo);
        if (!match) return null;
        const tokenized = LinuxMachine.tokenizeArgsDetailed(noSudo);
        if (tokenized.unterminatedQuote) {
          return 'bash: syntax error: unexpected end of file (unterminated quote)';
        }
        // tokens: sshpass -p <pw> scp|sftp <...args>
        const password = tokenized.tokens[2];
        const wrappedCmd = match[1] as 'scp' | 'sftp';
        const wrappedArgs = tokenized.tokens.slice(4);
        const result = await this.executor.runSshTransportAsync(wrappedCmd, wrappedArgs, password);
        this.executor.lastExitCode = result.exitCode;
        return result.output;
      }
      case 'scp':
      case 'sftp': {
        // Sans mot de passe offert : `runSshTransportAsync` tente la vraie
        // session par clé, puis retombe sur la résolution directe si elle
        // n'aboutit pas — c'est ce repli qui garde intacts les scénarios
        // qui n'ont jamais posé de clé.
        const tokenized = LinuxMachine.tokenizeArgsDetailed(noSudo);
        if (tokenized.unterminatedQuote) {
          return 'bash: syntax error: unexpected end of file (unterminated quote)';
        }
        const result = await this.executor.runSshTransportAsync(
          firstCmd as 'scp' | 'sftp', tokenized.tokens.slice(1), '');
        this.executor.lastExitCode = result.exitCode;
        return result.output;
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
   * Quote-aware argument tokenizer. Handles double and single quotes so
   * that e.g. `--comment "Allow SSH"` stays as a single token, and an
   * explicit empty quote (`""`) still yields an empty-string argument
   * rather than being dropped.
   */
  private static tokenizeArgs(input: string): string[] {
    return LinuxMachine.tokenizeArgsDetailed(input).tokens;
  }

  /** Same as {@link tokenizeArgs}, plus whether a quote was left unclosed. */
  private static tokenizeArgsDetailed(input: string): { tokens: string[]; unterminatedQuote: boolean } {
    const tokens: string[] = [];
    let cur = '', inQ = false, qc = '', hasToken = false;
    for (const ch of input) {
      if (inQ) { if (ch === qc) inQ = false; else cur += ch; }
      else if (ch === '"' || ch === "'") { inQ = true; qc = ch; hasToken = true; }
      else if (ch === ' ' || ch === '\t') { if (hasToken) { tokens.push(cur); cur = ''; hasToken = false; } }
      else { cur += ch; hasToken = true; }
    }
    if (hasToken) tokens.push(cur);
    return { tokens, unterminatedQuote: inQ };
  }

  // ─── Hostname resolution (shared between buildNetKernel & commands) ─

  /**
   * La résolution synchrone dont un service a besoin pour répondre dans
   * le même tour que la requête (§P6 : le mandataire de nginx).
   *
   * Elle passe par le NSS de la machine — donc `/etc/hosts` puis le
   * résolveur — plutôt que par une table à part : un service qui ne
   * résoudrait pas comme `ping` sur la même machine serait un piège.
   */
  private resolveHostnameSyncForServices(name: string): string | null {
    try { return new IPAddress(name).toString(); } catch { /* pas une adresse littérale */ }
    const r = this.executor.nss.lookup<NssHostEntry[]>('hosts', s => s.gethostbyname?.(name, 2));
    if (r.status === 'SUCCESS' && r.entry) {
      for (const h of r.entry) {
        if (h.addressFamily !== 2) continue;
        try { return new IPAddress(h.address).toString(); } catch { continue; }
      }
    }
    return null;
  }

  private async resolveHostnameOverWire(name: string): Promise<IPAddress | null> {
    try { return new IPAddress(name); } catch { void 0; }

    const r = await this.executor.nss.lookupAsync<NssHostEntry[]>(
      'hosts', s => s.gethostbynameAsync?.(name, 2) ?? s.gethostbyname?.(name, 2),
    );
    if (r.status === 'SUCCESS' && r.entry) {
      for (const h of r.entry) {
        if (h.addressFamily !== 2) continue;
        try { return new IPAddress(h.address); } catch { void 0; }
      }
    }
    return null;
  }

  /** IPv6 counterpart of `resolveHostnameOverWire` — `ping6`/`ping -6`
   *  previously only accepted literal addresses, so `/etc/hosts` entries
   *  like `::1 localhost ip6-localhost` never resolved. */
  private async resolveHostname6OverWire(name: string): Promise<IPv6Address | null> {
    try { return new IPv6Address(name); } catch { void 0; }

    const r = await this.executor.nss.lookupAsync<NssHostEntry[]>(
      'hosts', s => s.gethostbynameAsync?.(name, 10) ?? s.gethostbyname?.(name, 10),
    );
    if (r.status === 'SUCCESS' && r.entry) {
      for (const h of r.entry) {
        if (h.addressFamily !== 10) continue;
        try { return new IPv6Address(h.address); } catch { void 0; }
      }
    }
    return null;
  }

  protected override async resolveHost6ForCommand(targetStr: string): Promise<IPv6Address | null> {
    return this.resolveHostname6OverWire(targetStr);
  }

  // ─── LinuxNetKernel façade (closes over EndHost protected members) ──

  private getIfIndex(name: string): number {
    // `lo` porte l'index 1 sur toute machine Linux, et n'occupe donc pas
    // un rang dans la numerotation des autres : sans l'exclure, `eth0`
    // aurait recu l'index 3 la ou un vrai systeme lui donne 2.
    if (name === 'lo') return 1;
    if (!this.ifIndexMap) {
      this.ifIndexMap = new Map();
      for (const portName of this.ports.keys()) {
        if (portName === 'lo') continue;
        this.ifIndexMap.set(portName, this.nextIfIndex++);
      }
    }
    let idx = this.ifIndexMap.get(name);
    if (idx === undefined) {
      idx = this.nextIfIndex++;
      this.ifIndexMap.set(name, idx);
    }
    return idx;
  }

  private buildNetKernel(): LinuxNetKernel {
    return {
      getPorts: (): ReadonlyMap<string, Port> => {
        return this.ports;
      },
      getIfIndex: (name: string): number => {
        return this.getIfIndex(name);
      },
      buildTcpdumpDeps: (): TcpdumpDeps => {
        return this.buildTcpdumpDeps();
      },
      configureInterface: (name: string, ip: IPAddress, mask: SubnetMask): boolean => {
        return this.configureInterface(name, ip, mask);
      },
      configureIPv6Interface: (name: string, address: IPv6Address, prefixLength: number): boolean => {
        return this.configureIPv6Interface(name, address, prefixLength);
      },
      clearInterfaceIP: (name: string): void => {
        const port = this.ports.get(name);
        if (!port) return;
        const ip = port.getIPAddress();
        const cidr = port.getSubnetMask()?.toCIDR() ?? 0;
        port.clearIP();
        if (ip) this.getBus().publish({ topic: 'host.address.changed', payload: { ...this.hostRef(), iface: name, ip: ip.toString(), cidr, added: false } });
      },
      setInterfaceAdmin: (name: string, enabled: boolean): void => {
        const port = this.ports.get(name);
        if (!port) return;
        port.setUp(enabled);
        this.getBus().publish({ topic: 'host.link.state-changed', payload: { ...this.hostRef(), iface: name, up: enabled } });
      },
      isDHCPConfigured: (name: string): boolean => {
        return this.isDHCPConfigured(name);
      },
      getRoutingTable: (): HostRouteEntry[] => {
        return this.getRoutingTable();
      },
      getIPv6RoutingTable: () => {
        return this.getIPv6RoutingTable();
      },
      addStaticRoute: (network: IPAddress, mask: SubnetMask, gw: IPAddress, metric?: number): boolean => {
        return this.addStaticRoute(network, mask, gw, metric ?? 100);
      },
      addDeviceRoute: (network: IPAddress, mask: SubnetMask, iface: string, metric?: number): boolean => {
        return this.addDeviceRoute(network, mask, iface, metric ?? 0);
      },
      removeRoute: (
        network: IPAddress,
        mask: SubnetMask,
        filter?: { nextHop?: IPAddress | null; metric?: number },
      ): boolean => {
        return this.removeRoute(network, mask, filter);
      },
      setDefaultGateway: (gw: IPAddress): void => {
        this.setDefaultGateway(gw);
      },
      getDefaultGateway: (): IPAddress | null => {
        return this.getDefaultGateway();
      },
      clearDefaultGateway: (): void => {
        this.clearDefaultGateway();
      },
      getRoutingTableFor: (tableId: number): HostRouteEntry[] => {
        return this.getRoutingTableFor(tableId);
      },
      addStaticRouteToTable: (tableId: number, network: IPAddress, mask: SubnetMask, gw: IPAddress, metric?: number): boolean => {
        return this.addStaticRouteToTable(tableId, network, mask, gw, metric ?? 100);
      },
      addDeviceRouteToTable: (tableId: number, network: IPAddress, mask: SubnetMask, iface: string, metric?: number): boolean => {
        return this.addDeviceRouteToTable(tableId, network, mask, iface, metric ?? 0);
      },
      removeRouteFromTable: (
        tableId: number,
        network: IPAddress,
        mask: SubnetMask,
        filter?: { nextHop?: IPAddress | null; metric?: number },
      ): boolean => {
        return this.removeRouteFromTable(tableId, network, mask, filter);
      },
      addPolicyRule: (rule: HostPolicyRule): void => {
        this.addPolicyRule(rule);
      },
      removePolicyRule: (priority: number): boolean => {
        return this.removePolicyRule(priority);
      },
      getPolicyRules: (): HostPolicyRule[] => {
        return this.getPolicyRules();
      },
      resolveRouteFromTable: (
        targetIP: IPAddress, fromIP: IPAddress | null,
      ): { iface: string; nextHopIP: IPAddress; table: number } | null => {
        const r = this.resolveRouteFromTable(targetIP, fromIP);
        return r ? { iface: r.port.getName(), nextHopIP: r.nextHopIP, table: r.table } : null;
      },
      getArpTable: (): ReadonlyMap<string, ARPEntry> => {
        return this.arpTable;
      },
      addStaticARP: (ip: IPAddress, mac: MACAddress, iface: string): void => {
        this.addStaticARP(ip, mac, iface);
      },
      deleteARP: (ip: IPAddress): boolean => {
        return this.deleteARP(ip);
      },
      clearARPTable: (): void => {
        this.clearARPTable();
      },
      sendGratuitousArp: (iface: string, ip: IPAddress, mode: 'request' | 'reply'): boolean => {
        return this.sendGratuitousArp(iface, ip, mode);
      },
      hasRoute: (target: IPAddress): boolean => {
        return this.hasRouteOrLocal(target);
      },
      getScheduler: () => this.getScheduler(),
      pingSequence: (
        target: IPAddress,
        count: number,
        timeoutMs = 2000,
        ttl?: number,
        opts?: { dataSize?: number; df?: boolean },
      ): Promise<PingResult[]> => {
        return this.executePingSequence(target, count, timeoutMs, ttl, opts);
      },
      tcpProbe: (target: string, port: number): boolean => {
        if (target.includes(':')) return this.tcpProbeSyncIPv6(target, port);
        return this.tcpProbeSync(new IPAddress(target), port);
      },
      tcpConnectOutcome: (target: string, port: number): 'open' | 'refused' | 'timeout' => {
        if (target.includes(':')) return this.tcpConnectOutcome6(new IPv6Address(target), port);
        return this.tcpConnectOutcome(new IPAddress(target), port);
      },
      ping6Sequence: (
        target: IPv6Address,
        count: number,
        timeoutMs = 2000,
      ): Promise<PingResult[]> => {
        return this.executePing6Sequence(target, count, timeoutMs);
      },
      traceroute: async (target: IPAddress, maxHops?: number, probesPerHop?: number, firstTtl?: number, timeoutMs?: number): Promise<TracerouteHop[]> => {
        const hops = await this.executeTraceroute(target, maxHops, timeoutMs ?? 2000, probesPerHop, firstTtl);
        return hops as TracerouteHop[];
      },
      sendUdpProbe: (target: IPAddress, destinationPort: number, sourcePort: number): boolean => {
        return this.sendUdpDatagram(target, destinationPort, sourcePort, null, 0);
      },
      getResolvedService: () => this.getResolvedService(),
      publishResolvedState: () => this.publishResolvedState(),
      syncLinkLocalResponders: () => this.syncLinkLocalResponders(),
      getMdnsAgent: () => this.getMdnsAgent(),
      getLldpNeighbors: (iface?: string) => this.getLldpNeighbors(iface),
      getDhcpClient: (): DHCPClient => {
        return this.dhcpClient;
      },
      autoDiscoverDHCPServers: (): void => {
        this.autoDiscoverDHCPServers();
      },
      requestDhcpv6Lease: (iface: string, verbose?: boolean): string => {
        return this.requestDhcpv6Lease(iface, verbose);
      },
      requestDhcpv6Information: (iface: string, verbose?: boolean): string => {
        return this.requestDhcpv6Information(iface, verbose);
      },
      setIpForward: (enabled: boolean): void => {
        this.ipForwardEnabled = enabled;
      },
      isIpForwardEnabled: (): boolean => {
        return this.ipForwardEnabled;
      },
      addMasqueradeInterface: (iface: string): void => {
        this.masqueradeOnInterfaces.add(iface);
      },
      removeMasqueradeInterface: (iface: string): void => {
        this.masqueradeOnInterfaces.delete(iface);
      },
      extractPorts: (pkt: IPv4Packet): { srcPort?: number; dstPort?: number } => {
        return this.extractPorts(pkt);
      },
      resolveHostname: (name: string): Promise<IPAddress | null> => {
        return this.resolveHostnameOverWire(name);
      },
      resolveHostname6: (name: string): Promise<IPv6Address | null> => {
        return this.resolveHostname6OverWire(name);
      },
      // Repli synchrone : ne voit ni DNSSEC ni DoT, faute de pouvoir
      // attendre. Les appelants qui peuvent attendre prennent
      // `resolveHostname`.
      resolveHostnameSync: (name: string): IPAddress | null => {
        try { return new IPAddress(name); } catch { /* not a literal address */ }
        const r = this.executor.nss.lookup<NssHostEntry[]>('hosts', s => s.gethostbyname?.(name, 2));
        if (r.status === 'SUCCESS' && r.entry) {
          for (const h of r.entry) {
            if (h.addressFamily !== 2) continue;
            try { return new IPAddress(h.address); } catch { continue; }
          }
        }
        return null;
      },
      getTcpStack: (): TcpStack => {
        return this.getTcpStack();
      },
      queryDns: async (
        serverIP: string, name: string, qtype: string,
        timeoutMs?: number, options?: DnsQueryOptions,
      ) => {
        const server = parseDnsServerLiteral(serverIP);
        if (!server) return null;
        return this.queryDnsServer(server, name, qtype, timeoutMs, options);
      },
      readFile: (path: string): string | null => {
        return this.executor.readFile(path);
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
    if (verdict === 'reject') this.lastRejectWith = manager.getLastRejectWith();
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

  private logIptablesLog(prefix: string, pkt: PacketInfo): void {
    const proto = pkt.protocol === 6 ? 'TCP'
                : pkt.protocol === 17 ? 'UDP'
                : pkt.protocol === 1 ? 'ICMP'
                : String(pkt.protocol);
    const portFields = (pkt.srcPort || pkt.dstPort)
      ? ` SPT=${pkt.srcPort ?? 0} DPT=${pkt.dstPort ?? 0}`
      : '';
    this.executor.logMgr.logKernel(
      'netfilter',
      `${prefix}IN=${pkt.iface} OUT=${pkt.outIface ?? ''} SRC=${pkt.srcIP} DST=${pkt.dstIP} PROTO=${proto}${portFields}`,
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

  protected override evaluateNatOutput(
    srcIP: string, dstIP: IPAddress, dstPort: number, srcPort: number,
    protocol: number, tentativeOutIface: string,
  ): { action: string; address?: string } | null {
    const pkt: PacketInfo = {
      direction: 'out',
      protocol,
      srcIP,
      dstIP: dstIP.toString(),
      srcPort, dstPort,
      iface: tentativeOutIface,
    };
    return this.executor.iptables.evaluateNat(pkt, 'OUTPUT');
  }

  protected override evaluatePreRouting6(
    inPort: string,
    ipv6Pkt: import('../core/types').IPv6Packet,
  ): { action: string; address?: string } | null {
    const transport = ipv6Pkt.payload as { sourcePort?: number; destinationPort?: number } | undefined;
    const pkt: PacketInfo = {
      direction: 'in',
      protocol: ipv6Pkt.nextHeader,
      srcIP: ipv6Pkt.sourceIP.toString(),
      dstIP: ipv6Pkt.destinationIP.toString(),
      srcPort: transport?.sourcePort ?? 0,
      dstPort: transport?.destinationPort ?? 0,
      iface: inPort,
    };
    return this.executor.ip6tables.evaluateNat(pkt, 'PREROUTING');
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
    //
    // Only take this fast path for a plain, unredirected invocation: a
    // naive whitespace tokenizer has no idea `<`/`>`/`|`/`;`/`&` are shell
    // syntax, so `xxd < /tmp/file` (as produced by a vim `:%!xxd` filter)
    // would otherwise become `xxd` called with the literal argument `<`.
    // Anything with shell metacharacters falls through to the real bash
    // interpreter below, which parses redirection correctly and still
    // reaches registry commands via `_registryCommandHook`.
    const hasShellSyntax = /[<>|;&]/.test(trimmed);
    const head = trimmed.split(/\s+/)[0];
    const cmd = this.commands.get(head);
    if (!hasShellSyntax && cmd && cmd.needsNetworkContext) {
      const args = LinuxMachine.tokenizeArgs(trimmed).slice(1);
      const result = cmd.run(this.buildCommandContext(), args);
      if (typeof result === 'string') return result;
    }

    return this.executor.execute(trimmed);
  }

  writeFileFromEditor(path: string, content: string, declaredSizeBytes?: number): boolean {
    const absPath = this.executor.vfs.normalizePath(path, this.executor.getCwd());
    const uid = this.executor.getCurrentUid();
    const gid = uid === 0 ? 0 : 1000;
    return this.executor.vfs.writeFile(absPath, content, uid, gid, 0o022, false, declaredSizeBytes);
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
    if (spec.listener) {
      mgr.registerServiceListener(spec.name, spec.listener);
      // Une unité installée à l'exécution DÉCLARE son écoute : le
      // sous-système qui la pose affirme posséder le démon, et c'est cette
      // affirmation qui vaut serveur. La règle de docs/PRD-Nginx.md §P0
      // porte sur la table statique `SERVICE_LISTENERS`, où vit le décor.
      // Réserve honnête : le listener TNS d'Oracle passe par ici et n'a
      // toujours pas de boucle d'acceptation réelle — voir la dette notée
      // au point de liaison du port 1521.
      this.executor.registerServiceSocketServer(spec.name, {
        open: () => true,
        close: () => { /* l'écoute appartient au sous-système déclarant */ },
      }, { reconcile: false });
    }
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

  /**
   * Command-owned interactive flows (IoC): sudo/su/passwd/adduser declare
   * their dialogue here, on the device — the terminal just renders it.
   */
  interactionPlanFor(
    commandLine: string,
    ctx?: InteractionPlanContext,
  ): CommandInteractionPlan | null {
    return buildLinuxInteractionPlan(
      commandLine,
      {
        currentUser: ctx?.currentUser ?? this.getCurrentUser(),
        currentUid: ctx?.currentUid ?? this.getCurrentUid(),
      },
      this,
    );
  }

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

  /**
   * Tear down a shell session and frees its pty slot.
   * @param opts.graceful The `-bash` process exits normally (real exit
   * status, no signal) instead of being hung up with SIGHUP. Default:
   * hang up (matches closing a real terminal window). Pass
   * `{ graceful: true }` for a session that ran to completion on its
   * own — e.g. a one-shot `ssh host cmd` exec, where the shell simply
   * finishes and exits rather than being interrupted.
   */
  closeShellSession(sessionOrId: LinuxShellSession | string, opts?: { graceful?: boolean }): void {
    const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id;
    const s = this.shellSessions.get(id);
    if (!s) return;
    try {
      if (opts?.graceful) this.executor.processMgr.exit(s.shellPid, 0);
      else this.executor.processMgr.kill(s.shellPid, 'SIGHUP');
    } catch { /* ignore */ }
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
   *
   * @param opts.color Whether to colorize output (`ls`, etc.) the way a
   * real pty does. Default true (matches every existing caller — a live
   * terminal window). Pass `{ color: false }` for a non-interactive
   * context (e.g. one-shot `ssh host cmd` exec, which has no pty and so
   * real coreutils auto-detect no-tty and disable color).
   */
  executeCommandInSession(command: string, session: LinuxShellSession, opts?: { color?: boolean }): Promise<string> {
    // Chain on the per-device queue: subsequent commands wait their turn.
    return this.sessionQueue.run(async () => {
      if (!this.isPoweredOn) return 'Device is powered off';
      if (session.disposed) return '';
      return this.sessionSwap.within(session, async () => {
        this.executor.displayColor = opts?.color ?? true;
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

  private buildTcpdumpDeps(): TcpdumpDeps {
    return {
      interfaceNames: (): string[] => {
        return ['lo', ...this.ports.keys()];
      },
      interfaceExists: (name: string): boolean => {
        return name === 'lo' || this.ports.has(name);
      },
      interfaceUp: (name: string): boolean => {
        if (name === 'lo') return true;
        return this.ports.get(name)?.getIsUp() ?? false;
      },
      openCapture: (iface: string, sink: (frame: CaptureFrame) => void): () => void => {
        return this.openTcpdumpCapture(iface, sink);
      },
      now: (): Date => {
        return new Date();
      },
      delay: (ms: number): Promise<void> => {
        return new Promise((resolve) => setTimeout(resolve, ms));
      },
      onCancelRequested: (cb: () => void): () => void => {
        const pid = this.executor.currentPid();
        return this.getBus().subscribeWhere('linux.process.exited',
          (p) => p.deviceId === this.id && p.pid === pid,
          () => cb());
      },
      readFile: (path: string): string | null => {
        const v = this.executor.vfs.readFile(this.executor.vfs.normalizePath(path, this.executor.getCwd()));
        if (v != null) return v;
        const cap = this.executor.captureLog.all();
        if (cap.length === 0) return null;
        const fakeFrames = cap.map(pkt => makeTcpFrame(pkt, 'eth0'));
        return serializeCaptureFile(fakeFrames);
      },
      writeFile: (path: string, content: string): boolean => {
        const abs = this.executor.vfs.normalizePath(path, this.executor.getCwd());
        return this.executor.vfs.writeFile(abs, content, 0, 0, 0o022);
      },
      dirWritable: (path: string): boolean => {
        const abs = this.executor.vfs.normalizePath(path, this.executor.getCwd());
        const dir = abs.slice(0, abs.lastIndexOf('/')) || '/';
        return this.executor.vfs.exists(dir) && !dir.startsWith('/sys') && !dir.startsWith('/proc');
      },
    };
  }

  // Duplicate ACKs and a bare ACK immediately followed by data can share
  // identical (seq, flags, length), so pairing is by arrival order within
  // each key rather than by content alone — the oldest unpaired entry for
  // a key is always the other half of the same segment, never a later
  // duplicate.
  private static makeTcpSegmentDedupSink(sink: (frame: CaptureFrame) => void): (frame: CaptureFrame, fromPort: boolean) => void {
    interface PendingEntry { frame: CaptureFrame; fromPort: boolean; paired: boolean; }
    const pending = new Map<string, PendingEntry[]>();
    const key = (f: CaptureFrame): string => {
      const t = f.tcpFlags;
      const flags = t ? `${t.syn?1:0}${t.ack?1:0}${t.fin?1:0}${t.rst?1:0}${t.psh?1:0}${t.urg?1:0}` : '';
      return `${f.srcIp}:${f.srcPort}:${f.dstIp}:${f.dstPort}:${f.tcpSeq}:${f.l4}:${flags}:${f.payloadLength ?? 0}`;
    };
    return (frame: CaptureFrame, fromPort: boolean): void => {
      if (frame.l4 !== 'tcp' || frame.tcpSeq === undefined) { sink(frame); return; }
      const k = key(frame);
      const queue = pending.get(k) ?? [];
      pending.set(k, queue);
      const waiting = queue.find((e) => !e.paired);
      if (waiting) {
        waiting.paired = true;
        if (fromPort && !waiting.fromPort) { waiting.frame = frame; waiting.fromPort = true; }
        return;
      }
      const entry: PendingEntry = { frame, fromPort, paired: false };
      queue.push(entry);
      queueMicrotask(() => {
        const idx = queue.indexOf(entry);
        if (idx !== -1) queue.splice(idx, 1);
        if (queue.length === 0) pending.delete(k);
        sink(entry.frame);
      });
    };
  }

  openTcpdumpCapture(iface: string, sink: (frame: CaptureFrame) => void): () => void {
    const bus = this.getBus();
    const id = this.id;
    const unsubs: Array<() => void> = [];
    const wantPort = iface !== 'lo';
    const wantLoopback = iface === 'lo' || iface === 'any';
    const dedupedSink = LinuxMachine.makeTcpSegmentDedupSink(sink);

    if (wantPort) {
      unsubs.push(this.attachCapture(
        (tapped) => dedupedSink(
          decodeEthernetFrame(tapped.frame, tapped.iface, tapped.direction, new Date()), true),
        iface === 'any' ? undefined : iface));
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

    // captureLog's fallback relabels every entry with whatever iface was
    // requested, with no real per-port scoping — wrong for a VLAN
    // subinterface, which already has a real scoped event above.
    if (!this.vlanSubInterfaces.has(iface)) {
      const tcpIface = iface === 'any' ? 'eth0' : iface;
      for (const pkt of this.executor.captureLog.all()) sink(makeTcpFrame(pkt, tcpIface));
      unsubs.push(this.subscribeCapture((pkt) => dedupedSink(makeTcpFrame(pkt, tcpIface), false)));
    }

    return () => { for (const u of unsubs) u(); };
  }

  /** Vrai quand l'utilisateur a déjà un crontab — `crontab -e` le dit. */
  hasCrontab(user: string): boolean {
    const existing = this.executor.cron.list(user);
    return existing !== null && existing !== undefined && existing.trim().length > 0;
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

  /** Force a path to root:root 0440 — visudo's own guarantee for every
   *  sudoers-family file it installs, independent of the editing
   *  session's umask. */
  setSudoersFilePermissions(path: string): void {
    this.executor.vfs.chown(path, 0, 0);
    this.executor.vfs.chmod(path, 0o440);
  }

  /** Per-session variant of deleteFileFromEditor (used by editor swap/lock file cleanup). */
  deleteFileFromEditorInSession(path: string, session: LinuxShellSession): boolean {
    if (session.disposed) return this.deleteFileFromEditor(path);
    const absPath = this.executor.vfs.normalizePath(path, session.cwd);
    return this.executor.vfs.deleteFile(absPath);
  }
}
