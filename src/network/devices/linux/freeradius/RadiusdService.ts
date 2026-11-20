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
import type { RadiusClientEntry } from '@/network/radius/ClientTable';
import { parseUsersFile, matchUsersEntries, requestViewOf, type UsersEntry } from './UsersFileParser';
import type { RadiusUser, RadiusAttribute, RadiusPacket } from '@/network/radius/types';
import { detailPath, detailEntry, acctUniqueFor, type DetailRecord } from './DetailModule';
import type { RadiusAuthDecidedPayload } from '@/network/radius/events';
import { parseFreeradiusConf, type ConfFileReader } from './FreeradiusConf';
import { readRadiusdLogConfig, DEFAULT_RADIUS_LOG_FILE, type RadiusdLogConfig } from './RadiusdLogConfig';
import { readRadiusdSecurityConfig, type RadiusdSecurityConfig } from './RadiusdSecurityConfig';
import { requestDebugLines, knownGoodDisplayName, type ResolutionTrace } from './RequestDebug';
import type { RadiusUserResolverContext, AccountingRun } from '@/network/radius/RadiusServerAgent';
import { newContext, run, type Statement, type UnlangContext, type UnlangHost, type ModuleOutcome } from './Unlang';
import { MICROSOFT_VENDOR_ID } from '@/network/radius/dictionary';
import { readProxyConfig, findRealm, NO_PROXY, type ProxyConfig, type RadiusFormat, type HomePool } from './ProxyConfig';
import { readPipelines, pipelineAllows, type Pipeline, type ProcessingSection } from './PipelineConfig';
import { readPreprocess, applyPreprocess, NO_PREPROCESS, type PreprocessFiles } from './PreprocessModule';
import { readSiteConfig, describeListener, type ListenerSpec, type SiteConfig } from './RadiusdSiteConfig';
import { RadiusClientTable } from '@/network/radius/ClientTable';
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
  | { ok: true; clients: RadiusClientEntry[]; users: UsersEntry[]; log: RadiusdLogConfig; security: RadiusdSecurityConfig; site: SiteConfig; preprocess: PreprocessFiles; pipelines: Map<string, Pipeline>; proxy: ProxyConfig; files: readonly string[] }
  | { ok: false; error: string };

const moduleProgram = (names: string[]): readonly Statement[] => names.map((name) => ({ kind: 'module', name, file: '', line: 0 }));
const DEFAULT_PREACCT_PROGRAM = moduleProgram(['preprocess', 'acct_unique']);
const DEFAULT_ACCOUNTING_PROGRAM = moduleProgram(['detail', 'radutmp']);
const DEFAULT_AUTHORIZE_PROGRAM: readonly Statement[] = ['preprocess', 'chap', 'mschap', 'eap', 'files', 'logintime', 'pap'].map((name) => ({ kind: 'module', name, file: '', line: 0 }));

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
    for (const spec of specs) {
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
  private proxyDecision: RadiusUser['proxy'] | null = null;
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

  private runAccounting(info: AccountingRun): boolean {
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
    const lines: string[] = [];
    const preacct = run(pipeline?.preacct ?? DEFAULT_PREACCT_PROGRAM, context, host, lines, 3);
    if (preacct.result === 'reject' || preacct.result === 'fail') return false;
    run(pipeline?.accounting ?? DEFAULT_ACCOUNTING_PROGRAM, context, host, lines, 3);
    return true;
  }

  private boundPorts: number[] = [];
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
    const trace: ResolutionTrace['authType'] = authType === 'accept' ? 'Accept' : authType === 'pap' ? 'PAP' : authType === 'chap' ? 'CHAP' : null;
    this.lastResolution = { lines, result: outcome.result, authType: trace };
    if (outcome.result === 'reject' || authType === 'reject') return undefined;
    if (this.proxyDecision !== null && this.proxyDecision !== undefined) return { username, password: '', proxy: this.proxyDecision };
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
      return { result: present ? 'ok' : 'noop', messages };
    }
    if (name === 'eap') {
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
    if (name === 'suffix' || name === 'ntdomain') return this.runRealmModule(name, context);
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

  private runRealmModule(instanceName: string, context: UnlangContext): ModuleOutcome {
    const messages: string[] = [];
    const format: RadiusFormat = this.proxyConfig.instances.get(instanceName) ?? (instanceName === 'ntdomain' ? { format: 'prefix', delimiter: '\\', ignoreDefault: false, ignoreNull: false } : { format: 'suffix', delimiter: '@', ignoreDefault: false, ignoreNull: false });
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
    const realm = findRealm(this.proxyConfig, realmName);
    if (realm === null) {
      messages.push(`${instanceName}: No such realm "${realmName ?? 'NULL'}"`);
      return { result: 'noop', messages };
    }
    messages.push(`${instanceName}: Found realm "${realm.name}"`);
    if (realm.strip && position >= 0) {
      context.strippedName = local;
      context.overlay.set('stripped-user-name', local);
      messages.push(`${instanceName}: Adding Stripped-User-Name = "${local}"`);
    }
    context.overlay.set('realm', realm.name);
    messages.push(`${instanceName}: Adding Realm = "${realm.name}"`);
    if (realm.authPool === null) {
      messages.push(`${instanceName}: Authentication realm is LOCAL`);
      return { result: 'ok', messages };
    }
    messages.push(`${instanceName}: Proxying request from user ${name} to realm ${realm.name}`);
    const server = this.pickHomeServer(realm.authPool);
    this.proxyDecision = {
      realm: realm.name, forwardName: realm.strip && position >= 0 ? local : name,
      homeServerIp: server.address, homePort: server.port, homeSecret: server.secret, timeoutMs: server.responseWindowMs,
    };
    return { result: 'updated', messages };
  }

  private pickHomeServer(pool: HomePool) {
    if (pool.type === 'fail-over') return pool.servers[0];
    const turn = this.proxyRotation.get(pool.name) ?? 0;
    this.proxyRotation.set(pool.name, turn + 1);
    return pool.servers[turn % pool.servers.length];
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
    const preprocess = readPreprocess(main.root, (path) => this.files.read(path));
    if ('error' in preprocess) return { ok: false, error: preprocess.error };
    const pipelines = readPipelines(main.root);
    if ('error' in pipelines) return { ok: false, error: pipelines.error };
    const proxy = readProxyConfig(main.root);
    if ('error' in proxy) return { ok: false, error: proxy.error };
    const clientsSource = this.files.read(clientsPath);
    if (clientsSource === null) return { ok: false, error: `open: ${clientsPath}: file not found` };
    const usersSource = this.files.read(usersPath);
    if (usersSource === null) return { ok: false, error: `open: ${usersPath}: file not found` };
    const parsed = parseClientsConf(clientsSource, clientsPath, (path) => this.files.read(path));
    if (parsed.errors.length > 0) return { ok: false, error: parsed.errors[0] };
    const users = parseUsersFile(usersSource, usersPath, (path) => this.files.read(path));
    if ('error' in users) return { ok: false, error: users.error };
    return { ok: true, clients: parsed.clients, users: users.entries, log, security, site, preprocess, pipelines, proxy, files: main.files };
  }

  private applyConfig(loaded: { clients: RadiusClientEntry[]; users: UsersEntry[]; log: RadiusdLogConfig; security: RadiusdSecurityConfig; preprocess: PreprocessFiles; pipelines: Map<string, Pipeline>; proxy: ProxyConfig }): void {
    this.logConfig = loaded.log;
    this.preprocessFiles = loaded.preprocess;
    this.pipelines = loaded.pipelines;
    this.proxyConfig = loaded.proxy;
    this.radiusServer.setAccountingRunner((info) => this.runAccounting(info));
    this.radiusServer.setPostAuthHook((info) => this.runPostAuth(info.port, info.accepted, info.userReply));
    this.radiusServer.setDebugBuilder((info) => requestDebugLines({
      server: this.portServers.get(info.port) ?? 'default', pipeline: this.pipelines.get(this.portServers.get(info.port) ?? 'default'),
      request: info.request, user: info.user, resolution: this.lastResolution, usersPath: this.usersFilePath, accepted: info.accepted,
      receivedLines: info.receivedLines, replyLines: info.replyLines, postAuthLines: info.postAuthLines,
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
