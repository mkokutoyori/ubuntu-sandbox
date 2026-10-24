import type { NvList } from '../config/Ast';
import { arrayParam, getParams, numberParam, reportUnused, stringParam, type ParamDescriptor, type ParamValues } from '../config/Params';
import type { AllowedSenderList } from '../engine/AllowedSenders';
import type { Listener, StreamConnection } from '../engine/Host';
import { RS_RET } from '../engine/Log';
import type { StatsObject } from '../engine/Statistics';
import { emptyTlsExtras, copyTlsExtras, readTlsExtras, resolveStreamTls, type StreamTlsExtras, type StreamTlsOptions } from '../engine/StreamDriver';
import type { DirectiveRegistration, InputContext, InputInstance, InputModule, ModuleContext } from '../engine/Modules';
import { TcpFramer } from '../TcpFramer';

const MAX_FRAME_SIZE_LIMIT = 200_000_000;
const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_MAX_LISTENERS = 20;
const DEFAULT_MAX_FRAME_SIZE = 200_000;
const DEFAULT_RATE_LIMIT_BURST = 10000;
const LOG_INFO = 6;
const NO_ADDITIONAL_DELIMITER = -1;
const FIRST_STREAM_IDENTIFIER = 0x55e4c0a0d000;

const SHARED_PARAMS: readonly ParamDescriptor[] = [
  { name: 'flowcontrol', type: 'binary' }, { name: 'disablelfdelimiter', type: 'binary' }, { name: 'discardtruncatedmsg', type: 'binary' },
  { name: 'notifyonconnectionclose', type: 'binary' }, { name: 'notifyonconnectionopen', type: 'binary' },
  { name: 'addtlframedelimiter', type: 'nonneg' }, { name: 'maxframesize', type: 'int' }, { name: 'maxsessions', type: 'positive' },
  { name: 'workerthreads', type: 'positive' }, { name: 'starvationprotection.maxreads', type: 'nonneg' },
  { name: 'streamdriver.mode', type: 'nonneg' }, { name: 'streamdriver.authmode', type: 'string' },
  { name: 'streamdriver.permitexpiredcerts', type: 'string' }, { name: 'streamdriver.name', type: 'string' },
  { name: 'streamdriver.checkextendedkeypurpose', type: 'binary' }, { name: 'streamdriver.prioritizesan', type: 'binary' },
  { name: 'streamdriver.tlsverifydepth', type: 'positive' }, { name: 'streamdriver.tlsrevocationcheck', type: 'binary' },
  { name: 'streamdriver.cafile', type: 'string' }, { name: 'streamdriver.crlfile', type: 'string' }, { name: 'streamdriver.keyfile', type: 'string' },
  { name: 'streamdriver.certfile', type: 'string' }, { name: 'allowedsender', type: 'array' }, { name: 'permittedpeer', type: 'array' },
  { name: 'keepalive', type: 'binary' }, { name: 'keepalive.probes', type: 'nonneg' }, { name: 'keepalive.time', type: 'nonneg' },
  { name: 'keepalive.interval', type: 'nonneg' }, { name: 'gnutlsprioritystring', type: 'string' }, { name: 'preservecase', type: 'binary' },
  { name: 'compression.mode', type: 'string' }, { name: 'compression.driver', type: 'string' },
  { name: 'compression.maxexpansionratio', type: 'nonneg' }, { name: 'compression.maxdecompressedbytesperreceive', type: 'nonneg' },
  { name: 'compression.maxtotalzstdwindowbytes', type: 'nonneg' }, { name: 'networknamespace', type: 'string' },
];

const MODULE_PARAMS: readonly ParamDescriptor[] = [
  ...SHARED_PARAMS, { name: 'octetcountedframing', type: 'binary' }, { name: 'maxlistners', type: 'positive' }, { name: 'maxlisteners', type: 'positive' },
];

const INPUT_PARAMS: readonly ParamDescriptor[] = [
  ...SHARED_PARAMS, { name: 'port', type: 'string', required: true }, { name: 'maxlisteners', type: 'positive' },
  { name: 'listenportfilename', type: 'string' }, { name: 'address', type: 'string' }, { name: 'name', type: 'string' },
  { name: 'defaulttz', type: 'string' }, { name: 'ruleset', type: 'string' }, { name: 'supportoctetcountedframing', type: 'binary' },
  { name: 'ratelimit.interval', type: 'int' }, { name: 'framingfix.cisco.asa', type: 'binary' }, { name: 'ratelimit.burst', type: 'int' },
  { name: 'ratelimit.name', type: 'string' }, { name: 'socketbacklog', type: 'nonneg' }, { name: 'multiline', type: 'binary' },
  { name: 'framing.delimiter.regex', type: 'string' },
];

interface TcpDefaults {
  maxSessions: number;
  maxListeners: number;
  supportOctetCounted: boolean;
  streamDriverMode: number;
  streamDriverModeSet: boolean;
  streamDriverName: string | null;
  authMode: string | null;
  notifyOnClose: boolean;
  notifyOnOpen: boolean;
  flowControl: boolean;
  additionalDelimiter: number;
  maxFrameSize: number;
  disableLfDelimiter: boolean;
  discardTruncated: boolean;
  keepAlive: { enabled: boolean; probes: number; interval: number; time: number };
  preserveCase: boolean;
  compressionMode: string;
  networkNamespace: string | null;
  allowedSenders: AllowedSenderList | null;
  configuredViaModule: boolean;
  tls: StreamTlsExtras;
}

interface ImtcpLegacyState {
  runPorts: string[];
  inputName: string | null;
  bindRuleset: string | null;
  listenPortFile: string | null;
  permittedPeers: string[];
}

function defaultDefaults(): TcpDefaults {
  return {
    maxSessions: DEFAULT_MAX_SESSIONS, maxListeners: DEFAULT_MAX_LISTENERS, supportOctetCounted: true, streamDriverMode: 0,
    streamDriverModeSet: false, streamDriverName: null, authMode: null, notifyOnClose: false, notifyOnOpen: false, flowControl: true,
    additionalDelimiter: NO_ADDITIONAL_DELIMITER, maxFrameSize: DEFAULT_MAX_FRAME_SIZE, disableLfDelimiter: false, discardTruncated: false,
    keepAlive: { enabled: false, probes: 0, interval: 0, time: 0 }, preserveCase: true, compressionMode: 'none', networkNamespace: null,
    allowedSenders: null, configuredViaModule: false, tls: emptyTlsExtras(),
  };
}

function defaultLegacyState(): ImtcpLegacyState {
  return { runPorts: [], inputName: null, bindRuleset: null, listenPortFile: null, permittedPeers: [] };
}

function moduleDefaults(context: ModuleContext): TcpDefaults {
  return context.moduleState('imtcp.defaults', defaultDefaults);
}

function legacyDefaults(context: ModuleContext): TcpDefaults {
  return context.moduleState('imtcp.legacyDefaults', defaultDefaults);
}

function legacyState(context: ModuleContext): ImtcpLegacyState {
  return context.moduleState('imtcp.legacy', defaultLegacyState);
}

interface TcpInstanceSettings extends TcpDefaults {
  resolvedTls: StreamTlsOptions | null;
  port: string;
  address: string | null;
  inputName: string | null;
  ruleset: string | null;
  defaultTimeZone: string | null;
  listenPortFile: string | null;
  spFramingFix: boolean;
  multiLine: boolean;
  startRegex: string | null;
  rateInterval: number;
  rateBurst: number;
  rateName: string | null;
  socketBacklog: number | null;
}

let nextStreamIdentifier = FIRST_STREAM_IDENTIFIER;

class TcpSession {
  readonly identifier = `0x${(nextStreamIdentifier += 0x40).toString(16)}`;
  readonly framer: TcpFramer;
  private tlsProbe: number[] = [];
  private tlsProbeDone = false;
  tlsMismatchWarned = false;

  constructor(
    readonly connection: StreamConnection,
    readonly host: string,
    readonly ip: string,
    readonly port: string,
    framer: (session: TcpSession) => TcpFramer,
  ) {
    this.framer = framer(this);
  }

  probeTls(data: Uint8Array): boolean {
    if (this.tlsProbeDone) return false;
    for (const byte of data) {
      if (this.tlsProbe.length >= 5) break;
      this.tlsProbe.push(byte);
    }
    if (this.tlsProbe.length < 5) return false;
    this.tlsProbeDone = true;
    const [kind, major, minor, high, low] = this.tlsProbe;
    const recordLength = (high << 8) | low;
    return kind === 0x16 && major === 0x03 && minor <= 0x04 && recordLength >= 40 && recordLength <= 16384;
  }
}

class ImtcpListener implements InputInstance {
  readonly description: string;
  private listeners: Listener[] = [];
  private readonly sessions = new Set<TcpSession>();
  private limiter: import('../engine/RateLimiter').RateLimiter | null | undefined;
  private statistics: StatsObject | null = null;
  private submitted = 0;

  constructor(private readonly settings: TcpInstanceSettings, private readonly context: InputContext) {
    this.description = `imtcp(${settings.address ?? '*'}/${settings.port})`;
  }

  get displayInputName(): string {
    return this.settings.inputName ?? 'imtcp';
  }

  check(): void {
    const ruleset = this.settings.ruleset;
    if (ruleset !== null && !this.context.rulesetExists(ruleset)) {
      this.context.runtime.error(`imtcp: ruleset '${ruleset}' for port ${this.settings.port} not found - using default ruleset instead`, RS_RET.ERR);
    }
  }

  private effectiveRuleset(): string | null {
    const ruleset = this.settings.ruleset;
    return ruleset !== null && this.context.rulesetExists(ruleset) ? ruleset : null;
  }

  private allowedList(): AllowedSenderList {
    return this.settings.allowedSenders ?? this.context.settings.allowedSenders.tcp;
  }

  start(): boolean {
    const settings = this.settings;
    if (settings.rateName !== null && (this.limiterForSubmissions(), this.limiter === null)) return false;
    let port = settings.port;
    const numericPrefix = /^\d*/.exec(port)?.[0] ?? '';
    const portNumber = numericPrefix === '' ? 0 : Number(numericPrefix);
    if (portNumber > 65535) {
      this.context.runtime.error(`Invalid TCP listen port ${port} - ignored.\n`, RS_RET.NO_ERRCODE);
      return false;
    }
    if (portNumber === 0 && settings.listenPortFile === null) {
      this.context.runtime.log(4, RS_RET.OK_WARN, 'imtcp: port 0 and no port file set -> using port 514 instead');
      port = '514';
    }
    const requested = Number(port);
    const outcome = this.context.host.network.listenStream(
      requested, settings.address === '*' ? null : settings.address,
      { family: this.context.settings.ipProtocol, freeBind: 0, ...(settings.resolvedTls === null ? {} : { tls: settings.resolvedTls }) },
      (connection) => this.accept(connection),
    );
    if (outcome.listeners.length === 0) {
      this.context.runtime.error(
        `Could not create tcp listener for port ${port} bind-address ${settings.address ?? '**UNSPECIFIED**'}${settings.networkNamespace === null ? '' : ` namespace ${settings.networkNamespace}`}.`,
        RS_RET.ERR,
      );
      return false;
    }
    if (settings.listenPortFile !== null) this.context.host.files.write(settings.listenPortFile, `${outcome.listeners[0].port}\n`);
    this.listeners = outcome.listeners;
    this.statistics = this.context.statistics.create(`${this.displayInputName}(${port})`, { origin: 'imtcp' });
    this.statistics.addCounter({ name: 'submitted', read: () => this.submitted, reset: () => { this.submitted = 0; } });
    return true;
  }

  stop(): void {
    for (const session of [...this.sessions]) this.closeSession(session, false);
    for (const listener of this.listeners) listener.close();
    this.listeners = [];
    if (this.statistics !== null) this.context.statistics.remove(this.statistics);
    this.statistics = null;
  }

  private limiterForSubmissions(): import('../engine/RateLimiter').RateLimiter | undefined {
    if (this.limiter === undefined) {
      const settings = this.settings;
      const created = this.context.rateLimiter({
        module: 'tcpsrv', interval: settings.rateInterval, burst: settings.rateBurst, configName: settings.rateName, forInput: true,
      });
      this.limiter = created === null ? null : created.limiter;
    }
    return this.limiter ?? undefined;
  }

  private accept(connection: StreamConnection): void {
    const settings = this.settings;
    const resolved = this.context.resolveSender(connection.remoteIp);
    const host = settings.preserveCase ? resolved.fqdn : resolved.fqdnLowerCase;
    const port = String(connection.remotePort);
    if (this.sessions.size >= settings.maxSessions) {
      this.context.runtime.error('too many tcp sessions - dropping incoming request', RS_RET.MAX_SESS_REACHED);
      this.refuseOpen(connection, host, resolved.ip, port);
      return;
    }
    const list = this.allowedList();
    if (list.verdict(connection.remoteIp, host, true) !== 'allowed') {
      this.context.runtime.error(`connection request from disallowed sender ${host} (${resolved.ip}:${port}) discarded`, RS_RET.HOST_NOT_PERMITTED);
      connection.close();
      return;
    }
    const session = new TcpSession(connection, host, resolved.ip, port, (owner) => new TcpFramer(
      {
        inputName: this.displayInputName,
        maxLine: this.context.settings.parser.maxLine,
        supportOctetCounted: settings.supportOctetCounted,
        spFramingFix: settings.spFramingFix,
        disableLfDelimiter: settings.disableLfDelimiter,
        additionalDelimiter: settings.additionalDelimiter === NO_ADDITIONAL_DELIMITER ? null : settings.additionalDelimiter,
        maxFrameSize: settings.maxFrameSize,
        discardTruncated: settings.discardTruncated,
        multiLine: settings.multiLine,
        startRegex: settings.startRegex,
      },
      {
        submit: (bytes) => this.submit(owner, bytes),
        error: (text) => this.context.runtime.error(text, RS_RET.NO_ERRCODE),
        peer: () => ({ host: owner.host, ip: owner.ip, port: owner.port }),
      },
    ));
    this.sessions.add(session);
    connection.onData((bytes) => this.receive(session, bytes));
    connection.onClose(() => this.closeSession(session, true));
    if (settings.notifyOnOpen) {
      this.context.runtime.log(LOG_INFO, RS_RET.NO_ERRCODE, `imtcp: connection established with host: ${host} (${resolved.ip}:${port})`);
    }
  }

  private refuseOpen(connection: StreamConnection, host: string, ip: string, port: string): void {
    if (this.settings.notifyOnOpen) {
      this.context.runtime.error(`imtcp: connection could not be established with host: ${host} (${ip}:${port})`, RS_RET.NO_ERRCODE);
    }
    connection.close();
  }

  private receive(session: TcpSession, bytes: Uint8Array): void {
    if (bytes.length === 0 || !this.sessions.has(session)) return;
    if (this.settings.streamDriverMode === 0 && session.probeTls(bytes) && !session.tlsMismatchWarned) {
      session.tlsMismatchWarned = true;
      this.context.runtime.error(
        `imtcp: TLS handshake detected from ${session.host} (${session.ip}:${session.port}) but listener is not TLS-enabled. Enable TLS on this listener or disable TLS on the client. See https://www.rsyslog.com/doc/faq/imtcp-tls-gibberish.html for troubleshooting.`,
        RS_RET.SERVER_NO_TLS,
      );
      this.context.runtime.error(`Tearing down TCP Session from ${session.ip}:${session.port}`, RS_RET.SERVER_NO_TLS);
      this.closeSession(session, false);
      return;
    }
    const before = this.submitted;
    session.framer.push(bytes);
    this.context.recordSender(session.host, this.submitted - before, Math.floor(this.context.host.clock.wallMs() / 1000));
  }

  private closeSession(session: TcpSession, closedByPeer: boolean): void {
    if (!this.sessions.has(session)) return;
    if (closedByPeer && this.settings.notifyOnClose) {
      this.context.runtime.error(`Netstream session ${session.identifier} closed by remote peer ${session.ip}:${session.port}.`, RS_RET.PEER_CLOSED_CONN);
    }
    session.framer.finish();
    this.sessions.delete(session);
    session.connection.close();
  }

  private submit(session: TcpSession, bytes: Uint8Array): void {
    this.context.submitter.submit({
      raw: '',
      bytes,
      inputName: this.displayInputName,
      fromHost: session.host,
      fromHostIp: session.ip,
      fromHostPort: session.port,
      ruleset: this.effectiveRuleset(),
      defaultTimeZone: this.settings.defaultTimeZone,
      limiter: this.limiterForSubmissions(),
      flowControl: this.settings.flowControl ? 'light' : 'none',
    });
    this.submitted++;
  }
}

function warnInsecure(settings: TcpDefaults, context: ModuleContext): void {
  if (context.settings.compatDefaultsSecure !== 'warn') return;
  const faq = 'https://docs.rsyslog.com/doc/faq/tls_mode0_disables_tls.html';
  const driver = settings.streamDriverName ?? context.settings.defaultNetstreamDriver ?? 'ptcp';
  const tlsCapable = ['ossl', 'gtls', 'mbedtls'].includes(driver.toLowerCase());
  const warn = (detail: string): void => context.warn(
    `backward-compatible insecure default in use: ${detail}; use global(compatibility.defaults.secure="strict") to enable the secure default`,
  );
  if (settings.streamDriverMode === 0) {
    if (settings.authMode !== null || tlsCapable) warn(`imtcp has TLS-related settings but streamdriver.mode="0"; mode 0 uses plain TCP so TLS is not active (see ${faq})`);
    else warn(`imtcp input uses streamdriver.mode="0" (plain TCP without TLS); see ${faq}`);
  } else if (settings.authMode !== null && settings.authMode.toLowerCase() === 'anon') {
    warn('imtcp uses streamdriver.authmode="anon"; server identity is not authenticated, so MITM is possible (see https://docs.rsyslog.com/doc/faq/tls_anon_auth_mitm.html)');
  }
}

function applySecureDefaults(settings: TcpDefaults, context: ModuleContext, label: string): boolean {
  const driver = settings.streamDriverName ?? context.settings.defaultNetstreamDriver ?? 'ptcp';
  if (['ossl', 'gtls', 'mbedtls'].includes(driver.toLowerCase()) && settings.streamDriverMode === 0 && context.settings.compatDefaultsSecure === 'strict') {
    if (settings.streamDriverModeSet) {
      context.runtime.error(
        `${label}: compatibility.defaults.secure="strict" rejects explicit streamdriver.mode="0" with TLS-capable stream driver "${driver}"; use streamdriver.mode="1" to enable TLS or select ptcp/plain TCP intentionally`,
        RS_RET.PARAM_ERROR,
      );
      return false;
    }
    settings.streamDriverMode = 1;
  }
  return true;
}

function validateMaxFrameSize(value: number, context: ModuleContext): boolean {
  if (value < 1 || value > MAX_FRAME_SIZE_LIMIT) {
    context.runtime.error(`imtcp: invalid value for 'maxFrameSize' parameter given is ${value}, valid range is 1..${MAX_FRAME_SIZE_LIMIT}`, RS_RET.PARAM_ERROR);
    return false;
  }
  return true;
}

function parseCompressionMode(text: string, context: ModuleContext): string | null {
  const lowered = text.toLowerCase();
  if (lowered === 'none') return 'none';
  if (lowered === 'stream:always') return 'stream:always';
  context.runtime.error(`imtcp: invalid compression.mode '${text}', supported values are 'none' and 'stream:always'`, RS_RET.CONF_PARSE_ERROR);
  return null;
}

function checkCompressionDriver(text: string, context: ModuleContext): boolean {
  const lowered = text.toLowerCase();
  if (lowered === 'zlib') return true;
  if (lowered === 'zstd') context.runtime.error("imtcp: compression.driver='zstd' requires rsyslog to be built with libzstd support", RS_RET.CONF_PARSE_ERROR);
  else context.runtime.error(`imtcp: invalid compression.driver '${text}', supported values are 'zlib' and 'zstd'`, RS_RET.CONF_PARSE_ERROR);
  return false;
}

function applySharedParams(
  target: TcpDefaults, values: ParamValues, context: InputContext, label: string,
): boolean {
  const flag = (key: string): boolean | undefined => {
    const value = values.get(key);
    return value?.kind === 'N' ? value.n !== 0 : undefined;
  };
  target.discardTruncated = flag('discardtruncatedmsg') ?? target.discardTruncated;
  target.disableLfDelimiter = flag('disablelfdelimiter') ?? target.disableLfDelimiter;
  target.notifyOnClose = flag('notifyonconnectionclose') ?? target.notifyOnClose;
  target.notifyOnOpen = flag('notifyonconnectionopen') ?? target.notifyOnOpen;
  target.flowControl = flag('flowcontrol') ?? target.flowControl;
  target.additionalDelimiter = numberParam(values, 'addtlframedelimiter') ?? target.additionalDelimiter;
  const frame = numberParam(values, 'maxframesize');
  if (frame !== undefined) {
    if (!validateMaxFrameSize(frame, context)) return false;
    target.maxFrameSize = frame;
  }
  target.maxSessions = numberParam(values, 'maxsessions') ?? target.maxSessions;
  target.maxListeners = numberParam(values, 'maxlisteners') ?? numberParam(values, 'maxlistners') ?? target.maxListeners;
  const keepAlive = target.keepAlive;
  keepAlive.enabled = flag('keepalive') ?? keepAlive.enabled;
  keepAlive.probes = numberParam(values, 'keepalive.probes') ?? keepAlive.probes;
  keepAlive.time = numberParam(values, 'keepalive.time') ?? keepAlive.time;
  keepAlive.interval = numberParam(values, 'keepalive.interval') ?? keepAlive.interval;
  const mode = numberParam(values, 'streamdriver.mode');
  if (mode !== undefined) {
    target.streamDriverMode = mode;
    target.streamDriverModeSet = true;
  }
  target.streamDriverName = stringParam(values, 'streamdriver.name') ?? target.streamDriverName;
  target.authMode = stringParam(values, 'streamdriver.authmode') ?? target.authMode;
  readTlsExtras(target.tls, values);
  target.preserveCase = flag('preservecase') ?? target.preserveCase;
  target.networkNamespace = stringParam(values, 'networknamespace') ?? target.networkNamespace;
  const depth = numberParam(values, 'streamdriver.tlsverifydepth');
  if (depth !== undefined && depth < 2) context.runtime.error(`streamdriver.TlsVerifyDepth must be 2 or higher but is ${depth}`, RS_RET.CONF_PARSE_ERROR);
  const compression = stringParam(values, 'compression.mode');
  if (compression !== undefined) {
    const parsed = parseCompressionMode(compression, context);
    if (parsed === null) return false;
    target.compressionMode = parsed;
  }
  const driver = stringParam(values, 'compression.driver');
  if (driver !== undefined && !checkCompressionDriver(driver, context)) return false;
  const senders = arrayParam(values, 'allowedsender');
  if (senders !== undefined) {
    const list = context.allowedSenders(senders, label);
    if (list === null) return false;
    target.allowedSenders = list;
  }
  return true;
}

function resolveTransport(settings: TcpInstanceSettings, context: ModuleContext): boolean {
  const resolved = resolveStreamTls(
    { mode: settings.streamDriverMode, driver: settings.streamDriverName, authMode: settings.authMode },
    { ...settings.tls, permittedPeers: [...settings.tls.permittedPeers, ...legacyState(context).permittedPeers] }, context, 'imtcp', 'server',
  );
  if (resolved === false) return true;
  settings.resolvedTls = resolved;
  return refuseUnavailableCompression(settings, context);
}

function refuseUnavailableCompression(settings: TcpDefaults, context: ModuleContext): boolean {
  if (settings.compressionMode === 'stream:always') {
    context.runtime.error('imtcp: compression.mode="stream:always" requires a streaming inflate driver, which this rsyslogd build cannot provide', RS_RET.PARAM_ERROR);
    return true;
  }
  return false;
}

function createInstances(params: NvList, context: InputContext): InputInstance[] | null {
  const report = (message: string): void => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR);
  const values = getParams(params, INPUT_PARAMS, { report, uidOf: () => null, gidOf: () => null });
  if (values === null) {
    context.runtime.error('imtcp: required parameter are missing\n', RS_RET.MISSING_CNFPARAMS);
    return null;
  }
  reportUnused(params, report);
  const base = moduleDefaults(context);
  const settings: TcpInstanceSettings = {
    ...base, keepAlive: { ...base.keepAlive }, tls: copyTlsExtras(base.tls), resolvedTls: null, port: stringParam(values, 'port') ?? '', address: stringParam(values, 'address') ?? null,
    inputName: stringParam(values, 'name') ?? null, ruleset: stringParam(values, 'ruleset') ?? null,
    defaultTimeZone: stringParam(values, 'defaulttz') ?? null, listenPortFile: stringParam(values, 'listenportfilename') ?? null,
    spFramingFix: (numberParam(values, 'framingfix.cisco.asa') ?? 0) !== 0, multiLine: (numberParam(values, 'multiline') ?? 0) !== 0,
    startRegex: stringParam(values, 'framing.delimiter.regex') ?? null, rateInterval: numberParam(values, 'ratelimit.interval') ?? -1,
    rateBurst: numberParam(values, 'ratelimit.burst') ?? -1, rateName: stringParam(values, 'ratelimit.name') ?? null,
    socketBacklog: numberParam(values, 'socketbacklog') ?? null, allowedSenders: base.allowedSenders,
  };
  if (!applySharedParams(settings, values, context, 'imtcp')) return null;
  const octet = numberParam(values, 'supportoctetcountedframing');
  if (octet !== undefined) settings.supportOctetCounted = octet !== 0;
  if (settings.rateName !== null) {
    if (settings.rateInterval !== -1 || settings.rateBurst !== -1) {
      context.runtime.error('imtcp: ratelimit.name is mutually exclusive with ratelimit.interval and ratelimit.burst - using named ratelimit', RS_RET.INVALID_PARAMS);
    }
  } else {
    if (settings.rateInterval === -1) settings.rateInterval = 0;
    if (settings.rateBurst === -1) settings.rateBurst = DEFAULT_RATE_LIMIT_BURST;
  }
  if (!applySecureDefaults(settings, context, 'imtcp input')) return null;
  warnInsecure(settings, context);
  if (resolveTransport(settings, context)) return null;
  if (settings.startRegex !== null) {
    try {
      new RegExp(settings.startRegex);
    } catch (error) {
      context.runtime.error(`imtcp: error in framing.delimiter.regex expansion: ${error instanceof Error ? error.message : String(error)}`, RS_RET.ERR);
      return null;
    }
  }
  return [new ImtcpListener(settings, context)];
}

function directives(): DirectiveRegistration[] {
  const legacy = (apply: (defaults: TcpDefaults, value: number | string, context: InputContext) => void) =>
    (value: number | string, context: InputContext): void => {
      if (moduleDefaults(context).configuredViaModule) {
        context.runtime.error('imtcp legacy directive not permitted after module(...) parameters were given', RS_RET.ERR);
        return;
      }
      apply(legacyDefaults(context), value, context);
    };
  return [
    { name: 'inputtcpserverinputname', type: 'word', apply: (value, context) => { legacyState(context).inputName = String(value); } },
    { name: 'inputtcpserverbindruleset', type: 'word', apply: (value, context) => { legacyState(context).bindRuleset = String(value); } },
    { name: 'inputtcpserverlistenportfile', type: 'word', apply: (value, context) => { legacyState(context).listenPortFile = String(value); } },
    { name: 'inputtcpserverstreamdriverpermittedpeer', type: 'word', apply: (value, context) => { legacyState(context).permittedPeers.push(String(value)); } },
    { name: 'inputtcpserverstreamdriverauthmode', type: 'word', apply: legacy((defaults, value) => { defaults.authMode = String(value); }) },
    { name: 'inputtcpserverstreamdrivermode', type: 'int', apply: legacy((defaults, value) => { defaults.streamDriverMode = Number(value); defaults.streamDriverModeSet = true; }) },
    { name: 'inputtcpserverkeepalive', type: 'binary', apply: legacy((defaults, value) => { defaults.keepAlive.enabled = value === 1; }) },
    { name: 'inputtcpserverkeepalive_probes', type: 'int', apply: legacy((defaults, value) => { defaults.keepAlive.probes = Number(value); }) },
    { name: 'inputtcpserverkeepalive_intvl', type: 'int', apply: legacy((defaults, value) => { defaults.keepAlive.interval = Number(value); }) },
    { name: 'inputtcpserverkeepalive_time', type: 'int', apply: legacy((defaults, value) => { defaults.keepAlive.time = Number(value); }) },
    { name: 'inputtcpflowcontrol', type: 'binary', apply: legacy((defaults, value) => { defaults.flowControl = value === 1; }) },
    { name: 'inputtcpserverdisablelfdelimiter', type: 'binary', apply: legacy((defaults, value) => { defaults.disableLfDelimiter = value === 1; }) },
    { name: 'inputtcpserveraddtlframedelimiter', type: 'int', apply: legacy((defaults, value) => { defaults.additionalDelimiter = Number(value); }) },
    { name: 'inputtcpserversupportoctetcountedframing', type: 'binary', apply: legacy((defaults, value) => { defaults.supportOctetCounted = value === 1; }) },
    { name: 'inputtcpmaxsessions', type: 'int', apply: legacy((defaults, value) => { defaults.maxSessions = Number(value); }) },
    { name: 'inputtcpmaxlisteners', type: 'int', apply: legacy((defaults, value) => { defaults.maxListeners = Number(value); }) },
    { name: 'inputtcpservernotifyonconnectionclose', type: 'binary', apply: legacy((defaults, value) => { defaults.notifyOnClose = value === 1; }) },
    { name: 'inputtcpserverpreservecase', type: 'binary', apply: legacy((defaults, value) => { defaults.preserveCase = value === 1; }) },
    {
      name: 'inputtcpservercompressionmode', type: 'word',
      apply: legacy((defaults, value, context) => {
        const mode = parseCompressionMode(String(value), context);
        if (mode !== null) defaults.compressionMode = mode;
      }),
    },
    { name: 'inputtcpservercompressiondriver', type: 'word', apply: legacy((_defaults, value, context) => { checkCompressionDriver(String(value), context); }) },
    {
      name: 'inputtcpserverrun', type: 'word',
      apply: (value, context) => {
        const state = legacyState(context);
        const base = legacyDefaults(context);
        const settings: TcpInstanceSettings = {
          ...base, keepAlive: { ...base.keepAlive }, tls: copyTlsExtras(base.tls), resolvedTls: null, port: String(value), address: null, inputName: state.inputName, ruleset: state.bindRuleset,
          defaultTimeZone: null, listenPortFile: state.listenPortFile, spFramingFix: false, multiLine: false, startRegex: null, rateInterval: 0,
          rateBurst: DEFAULT_RATE_LIMIT_BURST, rateName: null, socketBacklog: null,
        };
        if (!applySecureDefaults(settings, context, 'imtcp input') || resolveTransport(settings, context)) return;
        context.registerInput('imtcp', new ImtcpListener(settings, context));
      },
    },
  ];
}

export const imtcp: InputModule = {
  kind: 'input',
  name: 'imtcp',
  builtin: false,
  newInstances: createInstances,
  directives,
  setModuleConfig(params, context) {
    const report = (message: string): void => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR);
    const values = getParams(params, [{ name: 'load', type: 'string' }, ...MODULE_PARAMS], { report, uidOf: () => null, gidOf: () => null });
    if (values === null) {
      context.runtime.error('imtcp: error processing module config parameters [module(...)]', RS_RET.MISSING_CNFPARAMS);
      return false;
    }
    const defaults = moduleDefaults(context);
    if (!applySharedParams(defaults, values, context as InputContext, 'imtcp')) return false;
    const octet = numberParam(values, 'octetcountedframing');
    if (octet !== undefined) defaults.supportOctetCounted = octet !== 0;
    defaults.configuredViaModule = true;
    if (!applySecureDefaults(defaults, context, 'imtcp module')) return false;
    warnInsecure(defaults, context);
    return true;
  },
  check(instanceCount, context) {
    const defaults = moduleDefaults(context);
    if (!defaults.configuredViaModule) {
      const legacy = legacyDefaults(context);
      for (const [name, value] of [['inputtcpmaxsessions', legacy.maxSessions], ['inputtcpmaxlisteners', legacy.maxListeners]] as const) {
        if (value < 1) {
          context.runtime.error(`imtcp: invalid value for legacy '${name}' parameter given is ${value}, minimum is 1`, RS_RET.PARAM_ERROR);
        }
      }
    }
    if (instanceCount === 0) context.runtime.error('imtcp: module loaded, but no listeners defined - no input will be gathered', RS_RET.NO_LISTNERS);
  },
  reset(context) {
    Object.assign(legacyState(context), defaultLegacyState());
    Object.assign(legacyDefaults(context), defaultDefaults());
  },
};
