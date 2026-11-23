/**
 * freeradius-equivalent service wrapper (PRD-RADIUS §2.2 "L'implémentation
 * freeradius sur Linux") — owns `clients.conf`/`users` parsing and applies
 * them to the already-built, already-tested `RadiusServerAgent`/
 * `RadiusTcpServer` engine. Mirrors `Bind9Service`'s shape: a config
 * loader/applier plus start/stop/restart/reload, wired into
 * `LinuxServiceManager` the same way `named` is.
 *
 * Scoped to the RADIUS engine's own single-shared-secret model: freeradius
 * itself supports a distinct secret per client, but `RadiusServerAgent`
 * doesn't — the first configured `client { }` block's secret becomes the
 * effective shared secret (documented simplification). `clients.conf`
 * doesn't drive `RadiusServerAgent.authorizeClient()`'s IP allow-list
 * either — that's a separate, pre-existing feature this PRD item doesn't
 * touch.
 */
import { knownGoodPassword } from '@/network/radius/KnownGoodPassword';
import { IPAddress } from '@/network/core/types';
import type { RadiusServerAgent } from '@/network/radius/RadiusServerAgent';
import type { RadiusTcpServer } from '@/network/radius/RadiusTcpTransport';
import { UDP_PORT_RADIUS_AUTH, UDP_PORT_RADIUS_ACCT } from '@/network/radius/types';
import { parseClientsConf } from './ClientsConfParser';
import { readEapModule, EAP_DEFAULT_FRAGMENT_SIZE, type EapModuleConfig } from './EapModuleConfig';
import type { EapTlsConfig } from '@/network/radius/eaptls/EapTlsConfig';
import { PeapMd5InnerAuthServer } from '@/network/radius/eaptls/PeapInnerAuth';
import { PeapMsChapV2InnerAuthServer } from '@/network/radius/eaptls/PeapMsChapV2InnerAuth';
import { TtlsPapInnerAuthServer } from '@/network/radius/eaptls/TtlsInnerAuth';
import { protocolOf, type RadiusClientEntry } from '@/network/radius/ClientTable';
import { parseUsersFile, matchUsersEntries, requestViewOf, type UsersEntry } from './UsersFileParser';
import { eapMessageHex, type RadiusUser, type RadiusAttribute, type RadiusPacket, type ProxyRoute } from '@/network/radius/types';
import { detailPath, detailEntry, acctUniqueFor, readDetailSettings, type DetailRecord } from './DetailModule';
import type { RadiusAuthDecidedPayload } from '@/network/radius/events';
import { parseFreeradiusConf, type ConfFileReader, type ConfSection } from './FreeradiusConf';
import { readRadiusdLogConfig, DEFAULT_RADIUS_LOG_FILE, type RadiusdLogConfig } from './RadiusdLogConfig';
import { readRadiusdSecurityConfig, type RadiusdSecurityConfig } from './RadiusdSecurityConfig';
import { requestDebugLines, knownGoodDisplayName, credentialMessages, type ResolutionTrace } from './RequestDebug';
import type { RadiusUserResolverContext, AccountingRun, AuthenticateOutcome } from '@/network/radius/RadiusServerAgent';
import { newContext, run, type Statement, type UnlangContext, type UnlangHost, type ModuleOutcome } from './Unlang';
import { MICROSOFT_VENDOR_ID } from '@/network/radius/dictionary';
import { formatRadiusAttribute } from '@/network/radius/attributeText';
import { readProxyConfig, findRealm, NO_PROXY, type ProxyConfig, type RadiusFormat, type HomePool, type HomeServer, type RadSecHomeTls } from './ProxyConfig';
import { readPipelines, pipelineAllows, type Pipeline, type ProcessingSection } from './PipelineConfig';
import { readPreprocess, applyPreprocess, NO_PREPROCESS, type PreprocessFiles } from './PreprocessModule';
import { RadSecServer, RadSecClientConnection } from '@/network/radius/RadSecTransport';
import { OcspClient, DEFAULT_OCSP_POLICY } from '@/network/http/ocsp/OcspHttpClient';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { certificateRejection, cipherOptions, tlsProtocolsOf, verifierOptions } from '@/network/radius/RadSecTlsPolicy';
import type { TlsClientConfig } from '@/network/tls/TlsClientSession';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { pemToCertChain, pemToPrivateKeyWithPassphrase } from '@/network/pki/pem';
import type { TlsServerConfig } from '@/network/tls/TlsServerSession';
import { type ControlSocket, type RadSecTls, readSiteConfig, describeListener, type ListenerSpec, type SiteConfig } from './RadiusdSiteConfig';
import { RadiusClientTable } from '@/network/radius/ClientTable';
import type { RadiusStats } from '@/network/radius/RadiusServerAgent';
import { formatCtime } from '../time/ctime';
import { formatLocalTime } from '../system/SystemInfo';
import { simulationNowMs } from '@/network/core/SystemClock';
import type { OperationResult } from '../LinuxServiceManager';
import type { EndHost } from '@/network/devices/EndHost';

export interface RadiusdFiles {
  read(path: string): string | null;
  append(path: string, text: string, umask?: number): void;
  list?(path: string): readonly string[] | null;
}

export interface RadiusdMachine {
  zone(): string | undefined;
  nowMs(): number;
  groupsOf(username: string): readonly string[];
}

export interface RadutmpEntry {
  login: string;
  nasPort: number;
  sessionId: string;
  nasAddress: string;
  framedAddress: string | null;
  protocol: 'P' | 'S' | 'T';
  portType: string;
  callerId: string;
  timeMs: number;
}

export interface RadiusdCheckReport {
  ok: boolean;
  logFile: string | null;
  errors: string[];
  mainFile: string;
  files: readonly string[];
}

export interface RadiusdListenOverride {
  authPort?: number;
  address?: string;
  debug?: boolean;
}

export interface RadiusdConfigPaths {
  main: string;
  clients: string;
  users: string;
}

const DEFAULT_SITE_FILE = '/etc/freeradius/3.0/sites-enabled/default';
const DEFAULT_SITE_AUTH_LISTEN_LINE = 59;

export const CLIENTS_CONF_PATH = '/etc/freeradius/3.0/clients.conf';
export const USERS_FILE_PATH = '/etc/freeradius/3.0/users';
export const RADIUSD_CONF_PATH = '/etc/freeradius/3.0/radiusd.conf';
const PROCESS_NAME = 'freeradius';

type ConfigLoadResult =
  | { ok: true; clients: RadiusClientEntry[]; users: UsersEntry[]; log: RadiusdLogConfig; security: RadiusdSecurityConfig; site: SiteConfig; preprocess: PreprocessFiles; pipelines: Map<string, Pipeline>; proxy: ProxyConfig; modules: readonly string[]; files: readonly string[]; eapTls: EapTlsConfig | null; root: ConfSection }
  | { ok: false; error: string };

const moduleProgram = (names: string[]): readonly Statement[] => names.map((name) => ({ kind: 'module', name, file: '', line: 0 }));
const DEFAULT_PREACCT_PROGRAM = moduleProgram(['preprocess', 'suffix', 'acct_unique']);
const DEFAULT_ACCOUNTING_PROGRAM = moduleProgram(['detail', 'radutmp']);
const DEFAULT_AUTHORIZE_PROGRAM: readonly Statement[] = ['preprocess', 'chap', 'mschap', 'eap', 'files', 'logintime', 'pap'].map((name) => ({ kind: 'module', name, file: '', line: 0 }));

const BUILTIN_AUTH_TYPES = new Set(['accept', 'reject', 'pap', 'chap', 'mschap', 'eap']);
const LOADED_MODULE_SECTIONS = new Set(['detail', 'preprocess', 'realm', 'eap']);

const MODULE_METHODS: Readonly<Record<string, readonly string[]>> = {
  detail: ['authorize', 'preacct', 'accounting', 'pre-proxy', 'post-proxy', 'post-auth', 'recv-coa', 'send-coa'],
  preprocess: ['authorize', 'preacct'],
  realm: ['authorize', 'preacct', 'recv-coa'],
  eap: ['authenticate', 'authorize', 'pre-proxy', 'post-proxy', 'post-auth'],
};
const MODULE_FLAGS: Readonly<Record<string, readonly string[]>> = { detail: ['reload-on-hup'], preprocess: [], realm: ['reload-on-hup'], eap: [] };

function loadedModules(root: { sections: readonly { name1: string; name2: string | null }[] }): string[] {
  const modules = root.sections.find((section) => section.name1 === 'modules') as unknown as { sections: readonly { name1: string; name2: string | null }[] } | undefined;
  if (modules === undefined) return [];
  return modules.sections
    .filter((section) => LOADED_MODULE_SECTIONS.has(section.name1))
    .map((section) => (section.name2 === null ? section.name1 : `${section.name2} (${section.name1})`));
}

export class RadiusdService {
  private running = false;

  constructor(
    private readonly host: EndHost,
    private readonly radiusServer: RadiusServerAgent,
    private readonly radiusTcpServer: RadiusTcpServer,
    private readonly files: RadiusdFiles,
    private readonly clientsConfPath: string = CLIENTS_CONF_PATH,
    private readonly usersFilePath: string = USERS_FILE_PATH,
    private readonly wallClock: RadiusdMachine = { zone: () => undefined, nowMs: () => simulationNowMs(), groupsOf: () => [] },
  ) {}

  utmpEntries(): RadutmpEntry[] {
    return this.radiusServer.utmpSessions().map((record) => ({
      login: record.username.slice(0, 32),
      nasPort: record.utmp!.nasPort,
      sessionId: record.sessionId.slice(-8),
      nasAddress: record.nasIp,
      framedAddress: record.utmp!.framedAddress,
      protocol: record.utmp!.protocol,
      portType: record.utmp!.portType,
      callerId: record.utmp!.callerId,
      timeMs: record.utmp!.startedAtMs,
    }));
  }

  isRunning(): boolean {
    return this.running;
  }

  controlSocketPaths(): readonly ControlSocket[] {
    return this.running ? this.controlSockets : [];
  }

  configuredControlSockets(): readonly string[] {
    const loaded = this.loadConfig();
    return loaded.ok ? loaded.site.controlSockets.map((socket) => socket.path) : [];
  }

  private statisticsLines(kind: 'auth' | 'acct', stats: RadiusStats, serverForm: boolean): string[] {
    const lines = [`requests\t${stats.requests}`, `responses\t${stats.responses}`];
    if (kind === 'auth') lines.push(`accepts\t\t${stats.accepts}`, `rejects\t\t${stats.rejects}`, `challenges\t${stats.challenges}`);
    lines.push(
      `dup\t\t${stats.dup}`, `invalid\t\t${stats.invalid}`, `malformed\t${stats.malformed}`, `bad_authenticator\t${stats.badAuthenticator}`,
      `dropped\t\t${stats.dropped}`, `unknown_types\t${stats.unknownTypes}`, `no_records\t${stats.noRecords}`,
      ...(serverForm ? [`timeouts\t${stats.timeouts}`] : [`conflicts\t${stats.conflicts}`, `unresponsive_child\t${stats.unresponsiveChild}`]),
      `last_packet\t${stats.lastPacket}`,
    );
    ['1us', '10us', '100us', '1ms', '10ms', '100ms', '1s', '10s'].forEach((name, index) => lines.push(`elapsed.${name}\t${stats.elapsed[index]}`));
    return lines;
  }

  statisticsListing(kind: 'auth' | 'acct', clientIp: string | null): string[] {
    return this.statisticsLines(kind, this.radiusServer.clientStatistics(kind, clientIp), false);
  }

  socketStatisticsListing(address: string, port: number): string[] | null {
    const spec = this.activeListeners.find((candidate) => candidate.port === port && candidate.tls === undefined && (candidate.address === null || candidate.address === address));
    if (spec === undefined) return null;
    const kind = spec.type === 'acct' ? 'acct' : 'auth';
    return this.statisticsLines(kind, this.radiusServer.listenerStatistics(kind, port), false);
  }

  queueStatisticsListing(): string[] {
    return ['queue_len_internal\t0', 'queue_len_proxy\t\t0', 'queue_len_auth\t\t0', 'queue_len_acct\t\t0', 'queue_len_detail\t0', 'queue_pps_in\t\t0', 'queue_pps_out\t\t0'];
  }

  homeServerStatisticsListing(kind: 'auth' | 'acct', address: string | null, port: number | null): string[] | null {
    if (address !== null && this.proxyConfig.homeServers.find((server) => server.address === address && (kind === 'acct' ? (server.acctPort ?? server.port) : server.port) === port && (kind === 'acct' ? server.type !== 'auth' : server.type !== 'acct')) === undefined) return null;
    const { stats, outstanding } = this.radiusServer.homeServerStatistics(kind, address, port);
    const lines = this.statisticsLines(kind, stats, true);
    if (address !== null) lines.push(`outstanding\t${outstanding}`);
    return lines;
  }

  moduleType(name: string): string | null {
    const loaded = this.loadConfig();
    if (!loaded.ok) return null;
    const modules = loaded.root.sections.find((section) => section.name1 === 'modules');
    const found = modules?.sections.find((section) => LOADED_MODULE_SECTIONS.has(section.name1) && (section.name2 ?? section.name1) === name);
    return found === undefined ? null : found.name1;
  }

  moduleMethods(name: string): string[] | null {
    const type = this.moduleType(name);
    return type === null ? null : [...MODULE_METHODS[type]];
  }

  moduleFlags(name: string): string[] | null {
    const type = this.moduleType(name);
    return type === null ? null : [...MODULE_FLAGS[type]];
  }

  moduleConfigListing(name: string): string[] | 'unsupported' | null {
    const type = this.moduleType(name);
    if (type === null) return null;
    if (type !== 'detail') return 'unsupported';
    const loaded = this.loadConfig();
    if (!loaded.ok) return null;
    const settings = readDetailSettings(loaded.root);
    if (settings === null || 'error' in settings) return null;
    return [
      'detail {', `\tdetailfile = '${settings.filename}'`, `\tfilename = '${settings.filename}'`, `\theader = '${settings.header}'`,
      `\tdetailperm = ${settings.permissions}`, `\tpermissions = ${settings.permissions}`, `\tgroup = ${settings.group === null ? '' : `'${settings.group}'`}`,
      `\tlocking = ${settings.locking ? 'yes' : 'no'}`, `\tdates_as_integer = ${settings.datesAsInteger ? 'yes' : 'no'}`,
      `\tescape_filenames = ${settings.escapeFilenames ? 'yes' : 'no'}`, `\tlog_packet_header = ${settings.logPacketHeader ? 'yes' : 'no'}`, '}',
    ];
  }

  configValue(path: string): string | null {
    const loaded = this.loadConfig();
    if (!loaded.ok) return null;
    const names = path.split('.');
    let section: ConfSection | undefined = loaded.root;
    for (const name of names.slice(0, -1)) {
      section = section?.sections.find((candidate) => candidate.name1 === name || candidate.name2 === name);
    }
    if (section === undefined) return null;
    return section.pairs.find((pair) => pair.name === names[names.length - 1])?.value ?? null;
  }

  moduleListing(): string[] {
    const loaded = this.loadConfig();
    if (!loaded.ok) return [];
    return loaded.modules.slice();
  }

  clientConfig(address: string): string[] | null {
    const ip = IPAddress.tryParse(address);
    if (ip === null) return null;
    return this.radiusServer.clientTable.find(ip)?.confLines?.slice() ?? null;
  }

  clientListing(verbose: boolean): string[] {
    const entries = this.radiusServer.clientTable.list();
    const address = (entry: RadiusClientEntry) => entry.prefix === 32 ? entry.address.toString() : `${entry.address.toString()}/${entry.prefix}`;
    if (!verbose) return entries.map(address);
    return entries.flatMap((entry, index) => [
      `client ${entry.section ?? entry.shortname} {`, `\tipaddr = ${address(entry)}`, `\tproto = ${protocolOf(entry) === 'udp' ? 'udp' : protocolOf(entry) === 'tcp' ? 'tcp' : '*'}`, `\tsecret = ${entry.secret}`, `\tlongname = ${entry.name}`,
      `\tshortname = ${entry.shortname}`, ...(entry.nasType === '' ? [] : [`\tnas_type = ${entry.nasType}`]), `\tnumber = ${index}`, '\tglobal = yes', '}',
    ]);
  }

  checkConfig(): OperationResult {
    const loaded = this.loadConfig();
    return loaded.ok ? { ok: true } : loaded;
  }

  checkConfigReport(paths?: RadiusdConfigPaths): RadiusdCheckReport {
    const main = paths?.main ?? RADIUSD_CONF_PATH;
    const loaded = this.loadConfig(paths);
    if (loaded.ok) return { ok: true, logFile: loaded.log.destination === 'files' ? loaded.log.file : null, errors: [], mainFile: main, files: loaded.files };
    const error = 'error' in loaded ? loaded.error : 'failed to start';
    const inMain = error.startsWith(main) || error.includes(`'${main}'`) || error.startsWith('radiusd: Error:');
    return {
      ok: false,
      logFile: inMain ? null : this.logConfig?.file ?? DEFAULT_RADIUS_LOG_FILE,
      errors: inMain ? [error, `Errors reading or parsing ${main}`] : [error],
      mainFile: main,
      files: [main],
    };
  }

  startFromCommandLine(listen: RadiusdListenOverride = {}): { ok: true } | { ok: false; errors: string[] } {
    if (listen.authPort !== undefined) {
      if (this.running) {
        return {
          ok: false,
          errors: listen.authPort === UDP_PORT_RADIUS_AUTH
            ? [`There appears to be another RADIUS server running on the authentication port ${listen.authPort}`]
            : ['A second daemon instance beside the running unit is not modelled in this simulator: stop it first with systemctl stop freeradius.'],
        };
      }
      const started = this.start(listen);
      return started.ok ? { ok: true } : { ok: false, errors: [started.error ?? 'failed to start'] };
    }
    if (this.running) {
      const first = this.activeListeners.find((spec) => spec.type === 'auth' || spec.type === 'auth+acct') ?? this.activeListeners[0];
      return {
        ok: false,
        errors: [
          `Failed binding to ${describeListener(first)}: Address already in use `,
          `${first.file === '' ? DEFAULT_SITE_FILE : first.file}[${first.file === '' ? DEFAULT_SITE_AUTH_LISTEN_LINE : first.line}]: Error binding to port for ${first.address ?? '0.0.0.0'} port ${first.port}`,
        ],
      };
    }
    const started = this.start({ debug: listen.debug });
    return started.ok ? { ok: true } : { ok: false, errors: [started.error ?? 'failed to start'] };
  }

  start(listen: RadiusdListenOverride = {}): OperationResult {
    if (this.running) return { ok: true };
    const loaded = this.loadConfig();
    if (!loaded.ok) return loaded;
    this.controlSockets = loaded.site.controlSockets;
    const specs: ListenerSpec[] = listen.authPort === undefined ? loaded.site.listeners : [
      { type: 'auth', address: listen.address ?? null, port: listen.authPort, server: 'default', file: '', line: 0 },
      { type: 'acct', address: listen.address ?? null, port: listen.authPort + 1, server: 'default', file: '', line: 0 },
    ];
    const bound: number[] = [];
    const tables = this.serverClientTables(loaded.site);
    const handlerOf = (spec: ListenerSpec) => (dgram: { inPort: string; sourceIP: unknown; udp: never }): void => {
      if (!(dgram.sourceIP instanceof IPAddress)) return;
      const udp = dgram.udp as { payload?: { code?: string } };
      if (spec.type === 'auth') this.radiusServer.handleUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
      else if (spec.type === 'acct') this.radiusServer.handleAcctUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
      else if (spec.type === 'status') this.radiusServer.handleStatusUdp(dgram.inPort, dgram.sourceIP, dgram.udp, tables.get(spec.server) ?? this.radiusServer.clientTable);
      else if (udp.payload?.code === 'accounting-request') this.radiusServer.handleAcctUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
      else this.radiusServer.handleUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
    };
    const radSecServers: RadSecServer[] = [];
    for (const spec of specs.filter((candidate) => candidate.tls !== undefined)) {
      const config = this.radSecTlsConfig(spec.tls as RadSecTls);
      if (typeof config === 'string') return { ok: false, error: config };
      const server = new RadSecServer(this.host.getTcpStack(), spec.port, this.radiusServer, { tlsConfig: (clientIp) => this.radSecConfigFor(clientIp, spec.tls as RadSecTls, config), checkPeer: (clientIp, certificate) => certificateRejection(certificate, this.radSecLimitsFor(clientIp, spec.tls as RadSecTls)) ?? this.ocspRejection(certificate, this.radSecClientTls(clientIp) ?? (spec.tls as RadSecTls)), onConnection: (_ip, accepted, reason) => { if (!accepted && reason !== undefined) this.writeLogLine('Auth', `tls: ${reason}`); } });
      server.start({ processName: PROCESS_NAME });
      radSecServers.push(server);
    }
    this.radSecServers = radSecServers;
    for (const spec of specs.filter((candidate) => candidate.tls === undefined)) {
      const owner = spec.address === null ? {} : { acceptsDestination: (destination: { toString(): string }) => destination.toString() === spec.address };
      let bindFailed = false;
      try {
        bindFailed = this.host.udpBind(spec.port, handlerOf(spec) as never, PROCESS_NAME, owner as never) === false;
      } catch (error) {
        if (!(error instanceof Error && error.message.startsWith('EADDRINUSE'))) throw error;
        bindFailed = true;
      }
      if (bindFailed) {
        for (const taken of bound) this.host.udpClose(taken);
        for (const server of radSecServers) server.stop();
        this.radSecServers = [];
        const what = spec.type === 'acct' ? 'accounting' : spec.type === 'status' ? 'status' : 'authentication';
        return { ok: false, error: `There appears to be another RADIUS server running on the ${what} port ${spec.port}` };
      }
      bound.push(spec.port);
    }
    const authPort = specs.find((spec) => spec.type === 'auth' || spec.type === 'auth+acct')?.port ?? UDP_PORT_RADIUS_AUTH;
    const acctPort = specs.find((spec) => spec.type === 'acct')?.port ?? authPort;
    this.activeListeners = specs;
    this.portServers = new Map(specs.map((spec) => [spec.port, spec.server]));
    this.radiusServer.setAnyPort(true);

    this.applyConfig(loaded);
    this.radiusServer.setPorts(authPort, acctPort);
    this.radiusServer.start();
    this.radiusTcpServer.start();
    this.radiusServer.setDecisionListener((payload) => this.writeAuthLog(payload));
    this.radiusServer.setAccountingListener((record) => this.writeDetail(record));
    this.radiusServer.setWarningListener((message) => this.writeLogLine('Warning', message));
    this.radiusServer.setUnknownClientListener((event) => this.writeLogLine('Error',
      `Ignoring request to ${this.listenerNamed(event.kind, event.port)} from unknown client ${event.clientIp} port ${event.clientPort} proto udp`));
    this.boundPorts = bound;
    this.running = true;
    this.debugMode = listen.debug === true;
    if (!this.debugMode) this.writeLogLine('Info', 'Ready to process requests');
    return { ok: true };
  }

  stop(): void {
    if (!this.running) return;
    if (!this.debugMode) {
      this.writeLogLine('Info', 'Signalled to terminate');
      this.writeLogLine('Info', 'Exiting normally');
    }
    this.radiusServer.setDecisionListener(null);
    this.radiusServer.setAccountingListener(null);
    this.radiusServer.setWarningListener(null);
    this.radiusServer.setUnknownClientListener(null);
    for (const port of this.boundPorts) this.host.udpClose(port);
    this.boundPorts = [];
    this.radiusServer.stop();
    this.radiusTcpServer.stop();
    for (const server of this.radSecServers) server.stop();
    this.closeRadSecConnections();
    this.radSecServers = [];
    this.running = false;
  }

  restart(): OperationResult {
    this.stop();
    return this.start();
  }

  reload(): OperationResult {
    if (!this.running) return { ok: false, error: 'freeradius is not running' };
    const loaded = this.loadConfig();
    if (!loaded.ok) return loaded;
    this.applyConfig(loaded);
    return { ok: true };
  }

  appendLog(path: string, text: string): void { this.files.append(path, text); }

  private pipelines = new Map<string, Pipeline>();
  private proxyConfig: ProxyConfig = NO_PROXY;
  private controlSockets: readonly ControlSocket[] = [];
  private proxyDecision: ProxyRoute | null = null;
  private proxyRotation = new Map<string, number>();
  private portServers = new Map<number, string>();

  private sectionPresent(port: number, section: ProcessingSection, module: string): boolean {
    const names = this.pipelines.get(this.portServers.get(port) ?? 'default')?.sections.get(section);
    return names?.has(module) === true;
  }

  private sectionAllows(port: number, section: ProcessingSection, module: string): boolean {
    const server = this.portServers.get(port) ?? 'default';
    return pipelineAllows(this.pipelines.get(server), section, module);
  }

  private writeDetail(record: DetailRecord): void {
    const settings = this.logConfig?.detail ?? null;
    if (settings === null || !this.sectionAllows(record.destinationPort, 'accounting', 'detail')) return;
    this.files.append(detailPath(settings, record), detailEntry(settings, record, this.sectionAllows(record.destinationPort, 'preacct', 'acct_unique') ? acctUniqueFor(record) : null), ~settings.permissions & 0o777);
  }

  private runStatus(info: { port: number; accounting: boolean; request: readonly RadiusAttribute[] }): { verdict: 'ok' | 'reject' | 'drop'; reply: RadiusAttribute[] } | null {
    const server = this.portServers.get(info.port) ?? 'default';
    const pipeline = this.pipelines.get(server);
    const section = info.accounting ? pipeline?.accounting : pipeline?.authorize;
    const wanted = info.accounting ? 'Acct-Type Status-Server' : 'Autz-Type Status-Server';
    const group = section?.find((statement) => statement.kind === 'typed' && statement.name === wanted);
    if (group === undefined || group.kind !== 'typed') return null;
    const context = newContext(String(info.request.find((attribute) => attribute.type === 'user-name')?.value ?? ''), info.request, null, this.wallClock.nowMs());
    const lines: string[] = [];
    const host: UnlangHost = { runModule: (name): ModuleOutcome => (name === 'ok' ? { result: 'ok', messages: [] } : name === 'reject' ? { result: 'reject', messages: [] } : { result: 'noop', messages: [] }) };
    const outcome = run(group.body, context, host, lines, 3);
    this.radiusServer.emitDebugLines([`# Executing group from file ${group.file} line ${group.line}`, `  ${wanted} {`, ...lines, `  } # ${wanted} = ${outcome.result}`]);
    const verdict = outcome.result === 'ok' || outcome.result === 'updated' ? 'ok' : outcome.result === 'fail' || outcome.result === 'handled' ? 'drop' : 'reject';
    return { verdict, reply: context.reply };
  }

  private runSession(info: { port: number; username: string; active: number; maximum: number }): number | null {
    const pipeline = this.pipelines.get(this.portServers.get(info.port) ?? 'default');
    const program = pipeline?.session;
    if (program === undefined || program === null) return pipeline !== undefined && pipeline.sections.has('session') && !pipeline.sections.get('session')!.has('radutmp') ? null : info.active;
    let counted = 0;
    const context = newContext(info.username, [], null, this.wallClock.nowMs());
    const lines: string[] = [];
    const host: UnlangHost = {
      runModule: (name): ModuleOutcome => {
        if (name === 'radutmp') {
          counted = info.active;
          return { result: 'ok', messages: [] };
        }
        if (name === 'ok') return { result: 'ok', messages: [] };
        if (name === 'reject') return { result: 'reject', messages: [] };
        return { result: 'noop', messages: [] };
      },
    };
    const outcome = run(program, context, host, lines, 3);
    return outcome.result === 'ok' ? counted : null;
  }

  private runAuthenticate(info: { port: number; accepted: boolean; user: RadiusUser | undefined; request: readonly RadiusAttribute[]; messages?: readonly string[] }): AuthenticateOutcome | null {
    const pipeline = this.pipelines.get(this.portServers.get(info.port) ?? 'default');
    const raw = this.lastResolution?.authTypeName ?? null;
    if (pipeline === undefined || raw === null) return null;
    const builtin = raw.toLowerCase();
    const group = pipeline.authGroups.get(builtin === 'mschap' ? 'ms-chap' : builtin);
    if (group === undefined) return null;
    const userName = String(info.request.find((attribute) => attribute.type === 'user-name')?.value ?? '');
    const context = newContext(userName, info.request, null, this.wallClock.nowMs());
    const lines: string[] = [];
    const host: UnlangHost = {
      runModule: (name): ModuleOutcome => {
        if ((name === 'pap' && builtin === 'pap') || (name === 'chap' && builtin === 'chap') || (name === 'mschap' && builtin === 'mschap')) {
          return { result: info.accepted ? 'ok' : 'reject', messages: credentialMessages(builtin === 'pap' ? 'PAP' : builtin === 'chap' ? 'CHAP' : 'MS-CHAP', info.accepted, userName, info.user?.knownGoodName) };
        }
        if (name === 'eap' && builtin === 'eap') return { result: info.accepted ? 'ok' : 'reject', messages: [...(info.messages ?? [])] };
        if (name === 'ok') return { result: 'ok', messages: [] };
        if (name === 'reject') return { result: 'reject', messages: [] };
        if (this.isRealmInstance(name)) return this.runRealmModule(name, context);
        return { result: 'noop', messages: [] };
      },
    };
    const outcome = run(group.program, context, host, lines, 3);
    return {
      accepted: outcome.result === 'ok' || outcome.result === 'handled' || outcome.result === 'updated',
      reply: context.reply,
      trace: { type: group.name, name: group.name, file: group.file, line: group.line, lines, result: outcome.result },
    };
  }

  private runProxyStage(section: 'pre-proxy' | 'post-proxy', port: number, request: readonly RadiusAttribute[], outbound: RadiusAttribute[], reply: RadiusAttribute[]): { attributes: RadiusAttribute[] | null } {
    const server = this.portServers.get(port) ?? 'default';
    const pipeline = this.pipelines.get(server);
    const program = section === 'pre-proxy' ? pipeline?.preProxy : pipeline?.postProxy;
    const keep = section === 'pre-proxy' ? outbound : reply;
    if (program === null || program === undefined || program.length === 0) return { attributes: keep };
    const username = String(request.find((attribute) => attribute.type === 'user-name')?.value ?? '');
    const context = newContext(username, request, null, this.wallClock.nowMs());
    context.proxyRequest = [...outbound];
    context.proxyReply = [...reply];
    const lines: string[] = [];
    const host: UnlangHost = { runModule: (name, ctx) => (this.isRealmInstance(name) ? this.runRealmModule(name, ctx) : { result: 'noop', messages: [] }) };
    const outcome = run(program, context, host, lines, 3);
    const place = pipeline?.locations.get(section);
    this.radiusServer.emitDebugLines([
      `# Executing section ${section}${place === undefined ? '' : ` from file ${place.file} line ${place.line}`}`, `  ${section} {`, ...lines, `  } # ${section} = ${outcome.result}`,
    ]);
    if (outcome.result === 'reject' || outcome.result === 'fail') return { attributes: null };
    return { attributes: section === 'pre-proxy' ? context.proxyRequest : context.proxyReply };
  }

  private runAccounting(info: AccountingRun): boolean | ProxyRoute {
    const pipeline = this.pipelines.get(this.portServers.get(info.destinationPort) ?? 'default');
    const attributes = info.packet.attributes;
    const username = String(attributes.find((attribute) => attribute.type === 'user-name')?.value ?? '');
    const context = newContext(username, attributes, {
      sourceIp: info.sourceIp, sourcePort: info.sourcePort, destinationIp: info.destinationIp, destinationPort: info.destinationPort,
      server: this.portServers.get(info.destinationPort) ?? 'default', type: 'Accounting-Request', authenticator: info.packet.authenticator,
    }, this.wallClock.nowMs());
    const recordOf = (): DetailRecord => ({
      sourceIp: info.sourceIp, destinationIp: info.destinationIp, sourcePort: info.sourcePort, destinationPort: info.destinationPort,
      packet: { ...info.packet, attributes: context.request }, atMs: info.atMs,
    });
    const host: UnlangHost = {
      runModule: (name, ctx) => {
        if (name === 'preprocess') {
          const rejected = applyPreprocess(this.preprocessFiles, ctx, info.sourceIp, Math.floor(this.wallClock.nowMs() / 1000), (user) => this.wallClock.groupsOf(user));
          return { result: rejected ? 'reject' : 'ok', messages: [] };
        }
        if (this.isRealmInstance(name)) return this.runRealmModule(name, ctx);
        if (name === 'acct_unique') {
          ctx.overlay.set('acct-unique-session-id', acctUniqueFor(recordOf()));
          return { result: 'updated', messages: [] };
        }
        if (name === 'detail') {
          const settings = this.logConfig?.detail ?? null;
          if (settings === null) return { result: 'noop', messages: [] };
          const record = recordOf();
          this.files.append(detailPath(settings, record), detailEntry(settings, record, ctx.overlay.get('acct-unique-session-id') ?? null), ~settings.permissions & 0o777);
          return { result: 'ok', messages: [] };
        }
        if (name === 'radutmp') {
          info.recordUtmp(ctx.request);
          return { result: 'ok', messages: [] };
        }
        return { result: 'noop', messages: [] };
      },
    };
    const server = this.portServers.get(info.destinationPort) ?? 'default';
    const lines: string[] = [`Virtual server ${server} received request`, ...info.packet.attributes.map((attribute) => `  ${formatRadiusAttribute(attribute)}`), `server ${server} {`];
    const place = (section: ProcessingSection): string => {
      const location = pipeline?.locations.get(section);
      return location === undefined ? '' : ` from file ${location.file} line ${location.line}`;
    };
    const runSection = (section: ProcessingSection, program: readonly Statement[]) => {
      lines.push(`  # Executing section ${section}${place(section)}`, `    ${section} {`);
      const outcome = run(program, context, host, lines, 3);
      lines.push(`    } # ${section} = ${outcome.result}`);
      return outcome;
    };
    this.proxyDecision = null;
    const preacct = runSection('preacct', pipeline?.preacct ?? DEFAULT_PREACCT_PROGRAM);
    const rejected = preacct.result === 'reject' || preacct.result === 'fail';
    const proxied = !rejected ? this.proxyDecision : null;
    if (!rejected && proxied === null) runSection('accounting', pipeline?.accounting ?? DEFAULT_ACCOUNTING_PROGRAM);
    lines.push(`} # server ${server}`, 'Virtual server sending reply');
    this.radiusServer.emitDebugLines(lines);
    return proxied ?? !rejected;
  }

  private boundPorts: number[] = [];
  private radSecServers: RadSecServer[] = [];

  private radSecConnections = new Map<string, RadSecClientConnection>();

  private radSecRequest(address: string, port: number, request: RadiusPacket): RadiusPacket | null {
    const home = this.proxyConfig.homeServers.find((server) => server.address === address && server.radSec !== null && (server.port === port || server.acctPort === port));
    if (home === undefined || home.radSec === null) return null;
    const key = `${address}:${port}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      let connection = this.radSecConnections.get(key);
      if (connection !== undefined && !connection.isOpen()) {
        this.radSecConnections.delete(key);
        connection = undefined;
      }
      const reused = connection !== undefined;
      if (connection === undefined) {
        const config = this.radSecClientConfig(home.radSec);
        if (typeof config === 'string') return null;
        const opened = RadSecClientConnection.open(this.host.getTcpStack(), address, port, config, (certificate) => certificateRejection(certificate, home.radSec!.limits));
        if (!(opened instanceof RadSecClientConnection)) return null;
        connection = opened;
        this.radSecConnections.set(key, connection);
      }
      const outcome = connection.exchange(request);
      if (outcome.ok && outcome.reply !== undefined) return outcome.reply;
      connection.close();
      this.radSecConnections.delete(key);
      if (!reused) return null;
    }
    return null;
  }

  private closeRadSecConnections(): void {
    for (const connection of this.radSecConnections.values()) connection.close();
    this.radSecConnections.clear();
  }

  private radSecClientConfig(tls: RadSecHomeTls): TlsClientConfig | string {
    const certificateText = this.files.read(tls.certificateFile);
    if (certificateText === null) return `Failed reading certificate_file "${tls.certificateFile}": No such file or directory`;
    const chain = pemToCertChain(certificateText);
    if (chain.length === 0) return `Failed parsing certificate_file "${tls.certificateFile}": no certificate found`;
    const keyText = this.files.read(tls.privateKeyFile);
    if (keyText === null) return `Failed reading private_key_file "${tls.privateKeyFile}": No such file or directory`;
    const key = pemToPrivateKeyWithPassphrase(keyText, tls.privateKeyPassword);
    if (key === null) return `Failed reading private_key_file "${tls.privateKeyFile}": bad decrypt or not a private key`;
    const caText = this.files.read(tls.caFile);
    if (caText === null) return `Failed reading ca_file "${tls.caFile}": No such file or directory`;
    return {
      verifier: new CertificateVerifier(verifierOptions(caText, tls.limits, () => this.wallClock.nowMs())),
      clientCert: chain[0], clientChain: chain.slice(1), clientPrivateKey: key, versions: tlsProtocolsOf(tls.limits), ...cipherOptions(tls.limits),
    };
  }

  private radSecClientTls(clientIp: string): RadSecTls | undefined {
    return this.radiusServer.clientTable.find(new IPAddress(clientIp), 'tls')?.tls;
  }

  private radSecConfigFor(clientIp: string, listener: RadSecTls, listenerConfig: TlsServerConfig): TlsServerConfig | null {
    const own = this.radSecClientTls(clientIp);
    if (own === undefined || own === listener) return listenerConfig;
    const config = this.radSecTlsConfig(own);
    if (typeof config === 'string') {
      this.writeLogLine('Error', `tls: ${config}`);
      return null;
    }
    return config;
  }

  private ocspRejection(certificate: X509Certificate | null, tls: RadSecTls): string | null {
    const ocsp = tls.ocsp;
    if (ocsp === undefined || certificate === null) return null;
    const material = this.caMaterial(tls);
    const anchors = pemToCertChain(typeof material === 'string' ? material : '');
    const client = new OcspClient({ tcpStack: () => this.host.getTcpStack(), now: () => this.wallClock.nowMs() }, {
      ...DEFAULT_OCSP_POLICY, responderUrl: ocsp.url, overrideResponder: ocsp.overrideCertUrl, trusted: anchors, useNonce: ocsp.useNonce,
      cacheMs: 0, timeoutMs: ocsp.timeoutSeconds === 0 ? null : ocsp.timeoutSeconds * 1000,
    });
    const lookup = client.lookup(certificate, anchors.find((anchor) => anchor.subject === certificate.issuer));
    if (lookup.ok === false) {
      this.writeLogLine('Error', `tls: ocsp: ${lookup.reason}`);
      if (lookup.kind === 'unreachable' && ocsp.softfail) {
        this.writeLogLine('Warning', 'tls: (TLS) ocsp: Unable to check certificate, assuming it\'s valid');
        return null;
      }
      return lookup.kind === 'unreachable' ? '(TLS) ocsp: Unable to check certificate, failing' : '(TLS) ocsp: Certificate has been expired/revoked';
    }
    if (lookup.single.status === 'good') return null;
    this.writeLogLine('Error', `tls: ocsp: Cert status: ${lookup.single.status}`);
    return '(TLS) ocsp: Certificate has been expired/revoked';
  }

  private caMaterial(tls: { caFile: string | null; caPath?: string }): string | null | { error: string } {
    let text: string | null = null;
    if (tls.caFile !== null) {
      text = this.files.read(tls.caFile);
      if (text === null) return { error: `Failed reading ca_file "${tls.caFile}": No such file or directory` };
    }
    if (tls.caPath !== undefined) {
      const names = this.files.list?.(tls.caPath);
      if (names === null || names === undefined) return { error: `Failed reading ca_path "${tls.caPath}": No such file or directory` };
      text = (text ?? '') + [...names].sort().map((name) => this.files.read(`${tls.caPath}/${name}`) ?? '').join('\n');
    }
    return text;
  }

  private radSecLimitsFor(clientIp: string, listener: RadSecTls): RadSecTls['limits'] {
    return (this.radSecClientTls(clientIp) ?? listener).limits;
  }

  private radSecTlsConfig(tls: RadSecTls): TlsServerConfig | string {
    const certificateText = this.files.read(tls.certificateFile);
    if (certificateText === null) return `Failed reading certificate_file "${tls.certificateFile}": No such file or directory`;
    const chain = pemToCertChain(certificateText);
    if (chain.length === 0) return `Failed parsing certificate_file "${tls.certificateFile}": no certificate found`;
    const keyText = this.files.read(tls.privateKeyFile);
    if (keyText === null) return `Failed reading private_key_file "${tls.privateKeyFile}": No such file or directory`;
    const key = pemToPrivateKeyWithPassphrase(keyText, tls.privateKeyPassword);
    if (key === null) return `Failed reading private_key_file "${tls.privateKeyFile}": bad decrypt or not a private key`;
    const caText = this.caMaterial(tls);
    if (typeof caText === 'object' && caText !== null) return caText.error;
    return {
      serverCert: chain[0], serverPrivateKey: key, serverChain: chain.slice(1),
      requestClientCert: tls.requireClientCert, clientCertPolicy: tls.requireClientCert ? 'strict' : 'optional',
      verifier: new CertificateVerifier(verifierOptions(caText as string | null, tls.limits, () => this.wallClock.nowMs())),
      protocols: tlsProtocolsOf(tls.limits), ...cipherOptions(tls.limits),
    };
  }
  private activeListeners: ListenerSpec[] = [];

  listeners(): readonly ListenerSpec[] { return this.activeListeners; }

  private listenerNamed(kind: 'auth' | 'acct', port: number): string {
    const spec = this.activeListeners.find((candidate) => candidate.port === port && (candidate.type === kind || candidate.type === 'auth+acct'))
      ?? { type: kind, address: null, port, server: 'default' } as ListenerSpec;
    return describeListener(spec);
  }

  private serverClientTables(site: SiteConfig): Map<string, RadiusClientTable> {
    const tables = new Map<string, RadiusClientTable>();
    for (const [name, entries] of site.serverClients) {
      const table = new RadiusClientTable();
      for (const entry of entries) table.add(entry);
      tables.set(name, table);
    }
    return tables;
  }
  private debugMode = false;
  private logConfig: RadiusdLogConfig | null = null;

  private writeAuthLog(payload: RadiusAuthDecidedPayload): void {
    const log = this.logConfig;
    if (log === null || log.destination !== 'files') return;
    const logged = payload.accepted ? log.auth || log.authAccept : log.auth || log.authReject;
    if (!logged) return;
    const cli = payload.callingStationId === null ? '' : ` cli ${payload.callingStationId}`;
    const user = payload.username === null ? '<no User-Name attribute>' : String(payload.username);
    const line = (message: string, withPassword: boolean): void => this.writeLogLine('Auth', `(${payload.number}) ${message}: `
      + `[${user}${withPassword ? `/${payload.password}` : ''}] (from client ${payload.clientShortname} port ${payload.nasPort}${cli})`);
    if (payload.precedingMessage !== undefined) line(payload.precedingMessage, log.authGoodpass);
    line(payload.accepted ? 'Login OK' : 'Login incorrect', payload.accepted ? log.authGoodpass : log.authBadpass);
  }

  private writeLogLine(level: string, message: string): void {
    const log = this.logConfig;
    if (log === null || log.destination !== 'files') return;
    this.files.append(log.file, `${formatCtime(new Date(simulationNowMs()))} : ${level}: ${message}\n`);
  }

  private preprocessFiles: PreprocessFiles = NO_PREPROCESS;
  private lastResolution: ResolutionTrace | null = null;
  private lastContext: UnlangContext | null = null;

  private runPostAuth(port: number, accepted: boolean, userReply: readonly RadiusAttribute[]): { reply: RadiusAttribute[]; lines: string[] } | null {
    const pipeline = this.pipelines.get(this.portServers.get(port) ?? 'default');
    const program = pipeline?.postAuth;
    const context = this.lastContext;
    if (program === null || program === undefined || context === null) return null;
    context.reply = accepted ? [...userReply] : [];
    const place = pipeline?.locations.get('post-auth');
    const lines: string[] = [];
    const host: UnlangHost = { runModule: () => ({ result: 'noop', messages: [] }) };
    const at = (text: string, depth: number): void => { lines.push(`${'  '.repeat(depth)}${text}`); };
    if (accepted) {
      at(`# Executing section post-auth from file ${place?.file ?? ''} line ${place?.line ?? 0}`, 1);
      at('post-auth {', 2);
      const outcome = run(program.filter((statement) => statement.kind !== 'typed'), context, host, lines, 3);
      at(`} # post-auth = ${outcome.result}`, 2);
      return { reply: context.reply, lines };
    }
    const typed = program.find((statement) => statement.kind === 'typed' && statement.name === 'Post-Auth-Type REJECT');
    if (typed === undefined || typed.kind !== 'typed') return { reply: [], lines };
    at('Using Post-Auth-Type Reject', 1);
    at(`# Executing group from file ${typed.file} line ${typed.line}`, 1);
    at('Post-Auth-Type REJECT {', 2);
    const outcome = run(typed.body, context, host, lines, 3);
    at(`} # Post-Auth-Type REJECT = ${outcome.result}`, 2);
    return { reply: context.reply, lines };
  }

  private resolveUser(entries: UsersEntry[], username: string, attributes: RadiusAttribute[], nasIp = '', listenPort = UDP_PORT_RADIUS_AUTH, packet?: RadiusUserResolverContext['packet']): RadiusUser | undefined {
    const groupsOf = (name: string) => this.wallClock.groupsOf(name);
    const pipeline = this.pipelines.get(this.portServers.get(listenPort) ?? 'default');
    const program: readonly Statement[] = pipeline?.authorize ?? DEFAULT_AUTHORIZE_PROGRAM;
    const context = newContext(username, attributes, packet === undefined ? null : { ...packet, server: this.portServers.get(listenPort) ?? 'default' }, this.wallClock.nowMs());
    this.lastContext = context;
    this.proxyDecision = null;
    const lines: string[] = [];
    const host: UnlangHost = { runModule: (name, ctx) => this.runAuthorizeModule(name, ctx, entries, nasIp, groupsOf) };
    const outcome = run(program, context, host, lines, 3);
    const authType = context.control.get('auth-type')?.toLowerCase();
    const trace: ResolutionTrace['authType'] = authType === 'accept' ? 'Accept' : authType === 'pap' ? 'PAP' : authType === 'chap' ? 'CHAP' : authType === 'mschap' ? 'MS-CHAP' : authType === 'eap' ? 'EAP' : null;
    this.lastResolution = { lines, result: outcome.result, authType: trace, authTypeName: context.control.get('auth-type') ?? null };
    if (outcome.result === 'reject' || authType === 'reject') return undefined;
    if (this.proxyDecision !== null && this.proxyDecision !== undefined) return { username, password: '', proxy: this.proxyDecision };
    const customGroup = authType !== undefined && !BUILTIN_AUTH_TYPES.has(authType) && pipeline?.authGroups.has(authType) === true;
    if (customGroup) return { username, password: '', acceptAny: true, replyAttributes: context.reply };
    const known = knownGoodPassword(context.knownGood);
    const acceptAny = authType === 'accept';
    if (known === null && !acceptAny) return undefined;
    const knownItem = context.knownGood.find((item) => knownGoodPassword([item]) !== null);
    const loginTime = context.control.get('login-time');
    const simultaneous = context.control.get('simultaneous-use');
    return {
      ...(knownItem === undefined ? {} : { knownGoodName: knownGoodDisplayName(knownItem.name) }),
      username, password: known?.cleartext ?? context.control.get('cleartext-password') ?? '', verify: known?.verify,
      acceptAny, replyAttributes: context.reply,
      ...(loginTime === undefined || !this.sectionAllows(listenPort, 'authorize', 'logintime') ? {} : { loginTime }),
      ...(simultaneous === undefined ? {} : { simultaneousUse: Number(simultaneous) }),
    };
  }

  private runAuthorizeModule(name: string, context: UnlangContext, entries: UsersEntry[], nasIp: string, groupsOf: (username: string) => readonly string[]): ModuleOutcome {
    const has = (type: string) => context.request.some((attribute) => attribute.type === type);
    const messages: string[] = [];
    if (name === 'preprocess') {
      const rejected = applyPreprocess(this.preprocessFiles, context, nasIp, Math.floor(this.wallClock.nowMs() / 1000), groupsOf);
      return { result: rejected ? 'reject' : 'ok', messages };
    }
    if (name === 'chap' && has('chap-password')) {
      if (!context.control.has('auth-type')) context.control.set('auth-type', 'chap');
      messages.push('chap: &control:Auth-Type := CHAP');
      return { result: 'ok', messages };
    }
    if (name === 'mschap') {
      const present = context.request.some((attribute) => attribute.type === 'vendor-specific' && attribute.vendor?.id === MICROSOFT_VENDOR_ID && attribute.vendor.type === 25);
      if (present && !context.control.has('auth-type')) context.control.set('auth-type', 'mschap');
      if (present) messages.push("mschap: Found MS-CHAP attributes.  Setting 'Auth-Type  = mschap'");
      return { result: present ? 'ok' : 'noop', messages };
    }
    if (name === 'eap') {
      const eapHex = eapMessageHex(context.request) ?? '';
      if (eapHex.length >= 10) {
        const code = parseInt(eapHex.slice(0, 2), 16);
        const codeName = ['', 'Request', 'Response', 'Success', 'Failure'][code];
        if (codeName !== undefined && codeName !== '') messages.push(`eap: Peer sent EAP ${codeName} (code ${code}) ID ${parseInt(eapHex.slice(2, 4), 16)} length ${parseInt(eapHex.slice(4, 8), 16)}`);
        if (!context.control.has('auth-type')) context.control.set('auth-type', 'eap');
        if (code === 2 && eapHex.slice(8, 10) === '01' && !has('state')) {
          messages.push("eap: EAP-Identity reply, returning 'ok' so we can short-circuit the rest of authorize");
          return { result: 'ok', messages };
        }
        messages.push("eap: No EAP Start, assuming it's an on-going EAP conversation");
        return { result: 'updated', messages };
      }
      if (has('eap-message')) return { result: 'ok', messages };
      messages.push('eap: No EAP-Message, not doing EAP');
      return { result: 'noop', messages };
    }
    if (name === 'files') {
      const match = matchUsersEntries(entries, context.strippedName ?? context.username, requestViewOf(context, groupsOf));
      if (match === null) return { result: 'noop', messages };
      for (const entry of match.matchedEntries) messages.push(`files: ${this.usersFilePath}: Matched entry ${entry.name} at line ${entry.line}`);
      for (const item of match.knownGood) {
        context.control.set(item.name, item.value);
        context.knownGood = [...context.knownGood.filter((known) => known.name !== item.name), item];
      }
      if (match.acceptAny) context.control.set('auth-type', 'accept');
      if (match.rejected) context.control.set('auth-type', 'reject');
      if (match.loginTime !== null) context.control.set('login-time', match.loginTime);
      if (match.simultaneousUse !== null) context.control.set('simultaneous-use', String(match.simultaneousUse));
      context.reply.push(...match.reply);
      return { result: 'ok', messages };
    }
    if (this.isRealmInstance(name)) return this.runRealmModule(name, context);
    if (name === 'logintime') {
      const loginTime = context.control.get('login-time');
      if (loginTime === undefined) return { result: 'noop', messages };
      messages.push('logintime: Checking Login-Time');
      const verdict = this.radiusServer.loginTimeOutcome({ username: context.username, password: '', loginTime });
      if (verdict.result === 'updated') {
        messages.push(`logintime: Login within allowed time-slot, ${verdict.secondsLeft} seconds left in this session`);
        messages.push(`logintime: reply:Session-Timeout set to ${verdict.secondsLeft}`);
      } else if (verdict.result === 'userlock') messages.push('logintime: ERROR: Login outside of allowed time-slot');
      return { result: verdict.result, messages };
    }
    if (name === 'pap') {
      if (!has('user-password')) {
        messages.push('pap: No User-Password attribute in the request.  Cannot do PAP');
        return { result: 'noop', messages };
      }
      if (knownGoodPassword(context.knownGood) === null) {
        messages.push('pap: WARNING: No "known good" password found for the user.  Not setting Auth-Type');
        messages.push('pap: WARNING: Authentication will fail unless a "known good" password is available');
        return { result: 'noop', messages };
      }
      if (!context.control.has('auth-type')) context.control.set('auth-type', 'pap');
      return { result: 'updated', messages };
    }
    return { result: 'noop', messages };
  }

  private isRealmInstance(name: string): boolean {
    return name === 'suffix' || name === 'ntdomain' || this.proxyConfig.instances.has(name);
  }

  private runRealmModule(instanceName: string, context: UnlangContext): ModuleOutcome {
    const messages: string[] = [];
    const configured = this.proxyConfig.instances.get(instanceName);
    const format: RadiusFormat = configured ?? (instanceName === 'ntdomain' ? { format: 'prefix', delimiter: '\\', ignoreDefault: false, ignoreNull: false, returnNotfound: false } : { format: 'suffix', delimiter: '@', ignoreDefault: false, ignoreNull: false, returnNotfound: false });
    if (context.overlay.has('realm')) {
      messages.push(`${instanceName}: Request already has destination realm set.  Ignoring`);
      return { result: 'noop', messages };
    }
    const name = context.username;
    const position = format.format === 'suffix' ? name.lastIndexOf(format.delimiter) : name.indexOf(format.delimiter);
    let realmName: string | null = null;
    let local = name;
    if (position >= 0) {
      realmName = format.format === 'suffix' ? name.slice(position + 1) : name.slice(0, position);
      local = format.format === 'suffix' ? name.slice(0, position) : name.slice(position + 1);
      messages.push(`${instanceName}: Looking up realm "${realmName}" for User-Name = "${name}"`);
    } else {
      messages.push(`${instanceName}: No '${format.delimiter}' in User-Name = "${name}", looking up realm NULL`);
    }
    if (realmName === null && format.ignoreNull) return { result: 'noop', messages };
    const found = findRealm(this.proxyConfig, realmName);
    const realm = found !== null && found.name === 'DEFAULT' && format.ignoreDefault ? null : found;
    if (realm === null) {
      messages.push(`${instanceName}: No such realm "${realmName ?? 'NULL'}"`);
      return { result: format.returnNotfound ? 'notfound' : 'noop', messages };
    }
    messages.push(`${instanceName}: Found realm "${realm.name}"`);
    if (realm.strip && position >= 0) {
      context.strippedName = local;
      context.overlay.set('stripped-user-name', local);
      messages.push(`${instanceName}: Adding Stripped-User-Name = "${local}"`);
    }
    context.overlay.set('realm', realm.name);
    messages.push(`${instanceName}: Adding Realm = "${realm.name}"`);
    const accounting = context.packet?.type === 'Accounting-Request';
    const pool = accounting ? realm.acctPool : realm.authPool;
    if (pool === null) {
      messages.push(`${instanceName}: ${accounting ? 'Accounting' : 'Authentication'} realm is LOCAL`);
      return { result: 'ok', messages };
    }
    messages.push(`${instanceName}: Proxying request from user ${name} to realm ${realm.name}`);
    const server = this.pickHomeServer(pool, accounting);
    const route = (candidate: typeof server) => ({ homeServerIp: candidate.address, homePort: accounting ? candidate.acctPort ?? candidate.port : candidate.port, homeSecret: candidate.secret, timeoutMs: candidate.responseWindowMs, ...(candidate.statusCheck === null ? {} : { statusCheck: candidate.statusCheck }), ...(candidate.radSec === null ? {} : { radSec: true }) });
    const rest = pool.servers.filter((candidate) => candidate !== server);
    this.proxyDecision = {
      realm: realm.name, forwardName: realm.strip && position >= 0 ? local : name,
      ...route(server), fallbacks: rest.map(route),
    };
    return { result: 'updated', messages };
  }

  private homeStateOf(server: HomeServer, accounting: boolean) {
    return this.radiusServer.homeServerState(server.address, accounting ? server.acctPort ?? server.port : server.port, server);
  }

  private pickHomeServer(pool: HomePool, accounting: boolean): HomeServer {
    const usable = pool.servers.filter((server) => !['dead', 'down'].includes(this.homeStateOf(server, accounting).state));
    const candidates = usable.length > 0 ? usable : pool.servers;
    if (pool.type === 'fail-over') return candidates[0];
    const turn = this.proxyRotation.get(pool.name) ?? 0;
    this.proxyRotation.set(pool.name, turn + 1);
    return candidates[turn % candidates.length];
  }

  private findHomeServer(address: string, port: number): { server: HomeServer; accounting: boolean } | null {
    for (const server of this.proxyConfig.homeServers) {
      if (server.address !== address) continue;
      if (server.port === port && server.type !== 'acct') return { server, accounting: false };
      if (server.acctPort === port && server.type !== 'auth') return { server, accounting: true };
    }
    return null;
  }

  homeServerStateText(address: string, port: number): string | null {
    const found = this.findHomeServer(address, port);
    return found === null ? null : this.radiusServer.homeServerState(found.server.address, port, found.server).state;
  }

  setHomeServerState(address: string, port: number, state: 'alive' | 'dead' | 'down'): boolean {
    const found = this.findHomeServer(address, port);
    if (found === null) return false;
    this.radiusServer.setHomeServerState(address, port, found.server, state);
    return true;
  }

  homeServerListing(all: boolean): string[] {
    const lines: string[] = [];
    for (const server of this.proxyConfig.homeServers) {
      const entries: Array<{ port: number; type: string }> = server.type === 'auth+acct' && server.radSec === null
        ? [{ port: server.port, type: 'auth+acct' }, { port: server.port + 1, type: 'acct' }]
        : [{ port: server.port, type: server.type }];
      for (const entry of entries) {
        const { state, outstanding } = this.radiusServer.homeServerState(server.address, entry.port, server);
        lines.push(`${server.address}\t${entry.port}\t${server.radSec === null ? 'udp' : 'tcp'}\t${entry.type}\t${state}\t${outstanding}${all ? `\t(name=${server.name}, dynamic=no)` : ''}`);
      }
    }
    return lines;
  }

  private confReader(): ConfFileReader {
    const read = ((path: string) => this.files.read(path)) as ConfFileReader;
    read.list = (path) => this.files.list?.(path) ?? null;
    return read;
  }

  private loadConfig(paths?: RadiusdConfigPaths): ConfigLoadResult {
    const mainPath = paths?.main ?? RADIUSD_CONF_PATH;
    const clientsPath = paths?.clients ?? this.clientsConfPath;
    const usersPath = paths?.users ?? this.usersFilePath;
    const mainSource = this.files.read(mainPath);
    if (mainSource === null) return { ok: false, error: `Unable to open file '${mainPath}': No such file or directory` };
    const main = parseFreeradiusConf(mainSource, mainPath, this.confReader());
    if ('error' in main) return { ok: false, error: main.error };
    const log = readRadiusdLogConfig(main.root);
    if ('error' in log) return { ok: false, error: log.error };
    const security = readRadiusdSecurityConfig(main.root);
    if ('error' in security) return { ok: false, error: security.error };
    const site = readSiteConfig(main.root);
    if ('error' in site) return { ok: false, error: site.error };
    for (const spec of site.listeners) {
      if (spec.tls === undefined) continue;
      const tlsConfig = this.radSecTlsConfig(spec.tls);
      if (typeof tlsConfig === 'string') return { ok: false, error: `${spec.file}[${spec.line}]: ${tlsConfig}` };
    }
    const preprocess = readPreprocess(main.root, (path) => this.files.read(path));
    if ('error' in preprocess) return { ok: false, error: preprocess.error };
    const pipelines = readPipelines(main.root);
    if ('error' in pipelines) return { ok: false, error: pipelines.error };
    const proxy = readProxyConfig(main.root);
    if ('error' in proxy) return { ok: false, error: proxy.error };
    for (const server of proxy.homeServers) {
      if (server.radSec === null) continue;
      const tlsConfig = this.radSecClientConfig(server.radSec);
      if (typeof tlsConfig === 'string') return { ok: false, error: `home_server ${server.name}: ${tlsConfig}` };
    }
    const clientsSource = this.files.read(clientsPath);
    if (clientsSource === null) return { ok: false, error: `open: ${clientsPath}: file not found` };
    const usersSource = this.files.read(usersPath);
    if (usersSource === null) return { ok: false, error: `open: ${usersPath}: file not found` };
    const parsed = parseClientsConf(clientsSource, clientsPath, (path) => this.files.read(path));
    if (parsed.errors.length > 0) return { ok: false, error: parsed.errors[0] };
    const users = parseUsersFile(usersSource, usersPath, (path) => this.files.read(path));
    if ('error' in users) return { ok: false, error: users.error };
    const eapModule = readEapModule(main.root.sections.find((section) => section.name1 === 'modules'));
    if (eapModule !== null && 'error' in eapModule) return { ok: false, error: eapModule.error };
    const eapTls = eapModule === null ? null : this.eapTlsConfig(eapModule as EapModuleConfig, users.entries);
    if (typeof eapTls === 'string') return { ok: false, error: eapTls };
    return { ok: true, clients: parsed.clients, users: users.entries, log, security, site, preprocess, pipelines, proxy, modules: loadedModules(main.root), files: main.files, eapTls, root: main.root };
  }

  private eapTlsConfig(module: EapModuleConfig, entries: UsersEntry[]): EapTlsConfig | string | null {
    const tls = module.tls;
    if (tls === null) return null;
    const certificateText = this.files.read(tls.certificateFile);
    if (certificateText === null) return `Failed reading certificate_file "${tls.certificateFile}": No such file or directory`;
    const chain = pemToCertChain(certificateText);
    if (chain.length === 0) return `Failed parsing certificate_file "${tls.certificateFile}": no certificate found`;
    const keyText = this.files.read(tls.privateKeyFile);
    if (keyText === null) return `Failed reading private_key_file "${tls.privateKeyFile}": No such file or directory`;
    const key = pemToPrivateKeyWithPassphrase(keyText, tls.privateKeyPassword);
    if (key === null) return `Failed reading private_key_file "${tls.privateKeyFile}": bad decrypt or not a private key`;
    let caText: string | null = null;
    if (tls.caFile !== null) {
      caText = this.files.read(tls.caFile);
      if (caText === null) return `Failed reading ca_file "${tls.caFile}": No such file or directory`;
    }
    const lookup = (username: string): RadiusUser | undefined => this.resolveUser(entries, username, []);
    return {
      serverCert: chain[0], serverPrivateKey: key,
      verifier: new CertificateVerifier(verifierOptions(caText, tls, () => this.wallClock.nowMs())),
      requireClientCert: module.defaultType === 'tls', eapType: module.defaultType as 'tls' | 'peap' | 'ttls',
      mtu: tls.fragmentSize ?? EAP_DEFAULT_FRAGMENT_SIZE,
      ...(module.defaultType === 'peap' ? { innerAuth: module.peapInner === 'md5' ? new PeapMd5InnerAuthServer(lookup) : new PeapMsChapV2InnerAuthServer(lookup) } : module.defaultType === 'ttls' ? { innerAuth: new TtlsPapInnerAuthServer(lookup) } : {}),
    };
  }

  private applyConfig(loaded: { clients: RadiusClientEntry[]; users: UsersEntry[]; log: RadiusdLogConfig; security: RadiusdSecurityConfig; preprocess: PreprocessFiles; pipelines: Map<string, Pipeline>; proxy: ProxyConfig; eapTls: EapTlsConfig | null }): void {
    this.logConfig = loaded.log;
    this.radiusServer.setEapTlsConfig(loaded.eapTls);
    this.preprocessFiles = loaded.preprocess;
    this.pipelines = loaded.pipelines;
    this.proxyConfig = loaded.proxy;
    this.radiusServer.setAuthenticateHook((info) => this.runAuthenticate(info));
    this.radiusServer.setSessionHook((info) => this.runSession(info));
    this.radiusServer.setStatusHook((info) => this.runStatus(info));
    this.radiusServer.setRadSecClient((address, port, request) => this.radSecRequest(address, port, request));
    this.radiusServer.setAccountingRunner((info) => this.runAccounting(info));
    this.radiusServer.setProxyHooks({
      pre: (info) => this.runProxyStage('pre-proxy', info.port, info.request, info.outbound, []).attributes,
      post: (info) => this.runProxyStage('post-proxy', info.port, info.request, [], info.reply).attributes,
    });
    this.radiusServer.setPostAuthHook((info) => this.runPostAuth(info.port, info.accepted, info.userReply));
    this.radiusServer.setDebugBuilder((info) => requestDebugLines({
      server: this.portServers.get(info.port) ?? 'default', pipeline: this.pipelines.get(this.portServers.get(info.port) ?? 'default'),
      request: info.request, user: info.user, resolution: this.lastResolution, usersPath: this.usersFilePath, accepted: info.accepted,
      receivedLines: info.receivedLines, replyLines: info.replyLines, postAuthLines: info.postAuthLines,
      ...(info.eap === undefined ? {} : { eap: info.eap }),
      ...(info.authenticate === undefined ? {} : { authenticate: info.authenticate }),
    }));
    this.radiusServer.setFeaturePolicy((feature, port) => {
      const both = (name: string) => this.sectionAllows(port, 'authorize', name) && this.sectionAllows(port, 'authenticate', name);
      if (feature === 'session') return this.sectionAllows(port, 'session', 'radutmp');
      if (feature === 'accounting-utmp') return this.sectionAllows(port, 'accounting', 'radutmp');
      return both(feature);
    });
    this.radiusServer.setStatusServer(loaded.security.statusServer);
    this.radiusServer.setDeniedMessage(loaded.log.msgDenied);
    this.radiusServer.setWallClock(() => this.wallClock.nowMs(), (epochMs) => {
      const [day, hour, minute] = formatLocalTime('%w %H %M', epochMs, this.wallClock.zone()).split(' ').map(Number);
      return day * 1440 + hour * 60 + minute;
    });
    this.radiusServer.setRejectReplyMessage(null);
    const secret = loaded.clients[0].secret;
    this.radiusServer.setSharedSecret(secret);
    this.radiusServer.clientTable.clear();
    for (const client of loaded.clients) this.radiusServer.clientTable.add(client);
    this.radiusServer.setUserResolver((username, context) => this.resolveUser(loaded.users, username, context?.attributes ?? [], context?.nasIp ?? '', context?.listenPort, context?.packet));
  }
}
