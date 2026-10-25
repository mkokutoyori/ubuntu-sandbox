import type { NvList } from '../config/Ast';
import { getParams, numberParam, reportUnused, type ParamDescriptor, type ParamValues } from '../config/Params';
import type { Listener, LocalStreamBinding, StreamConnection } from '../engine/Host';
import { RS_RET } from '../engine/Log';
import { isNumericHost } from '../engine/NumericHost';
import type { DirectiveRegistration, InputContext, InputInstance, InputModule, ModuleContext } from '../engine/Modules';
import type { StatsObject } from '../engine/Statistics';
import { PtcpFramer } from '../PtcpFramer';
import { ZlibError, ZlibInflateStream, zlibErrorCode } from '../Zlib';

const DEFAULT_WORKERS = 2;
const DEFAULT_MAX_FRAME_SIZE = 200_000;
const MAX_FRAME_SIZE_LIMIT = 200_000_000;
const DEFAULT_BACKLOG = 64;
const DEFAULT_RATE_BURST = 10_000;
const NO_ADDITIONAL_DELIMITER = -1;
const RECEIVE_BUFFER_BYTES = 128 * 1024;
const INFLATE_BUFFER_BYTES = 64 * 1024;
const SNIFF_MIN_BYTES = 2;
const SNIFF_MAX_BYTES = 4096;
const STATISTICS_NAME_LIMIT = 63;
const UNIX_PATH_LIMIT = 107;
const FIRST_SESSION_DESCRIPTOR = 6;
const LOG_INFO = 6;
const LOCAL_HOST_ADDRESS = '127.0.0.1';
const Z_STREAM_END = 1;
const Z_BUF_ERROR = -5;

const ZLIB_NAMES: Readonly<Record<number, string>> = {
  0: 'Z_OK', 1: 'Z_STREAM_END', 2: 'Z_NEED_DICT', [-1]: 'Z_ERRNO', [-2]: 'Z_STREAM_ERROR', [-3]: 'Z_DATA_ERROR', [-4]: 'Z_MEM_ERROR',
  [-5]: 'Z_BUF_ERROR', [-6]: 'Z_VERSION_ERROR',
};

type CompressionMode = 'never' | 'always' | 'auto';

const MODULE_PARAMS: readonly ParamDescriptor[] = [
  { name: 'threads', type: 'positive' }, { name: 'maxsessions', type: 'int' }, { name: 'processonpoller', type: 'binary' },
];

const INPUT_PARAMS: readonly ParamDescriptor[] = [
  { name: 'port', type: 'string' }, { name: 'address', type: 'string' }, { name: 'path', type: 'string' }, { name: 'unlink', type: 'binary' },
  { name: 'discardtruncatedmsg', type: 'binary' }, { name: 'fileowner', type: 'uid' }, { name: 'fileownernum', type: 'int' },
  { name: 'filegroup', type: 'gid' }, { name: 'filegroupnum', type: 'int' }, { name: 'filecreatemode', type: 'filemode' },
  { name: 'failonchownfailure', type: 'binary' }, { name: 'flowcontrol', type: 'binary' }, { name: 'name', type: 'string' },
  { name: 'maxframesize', type: 'int' }, { name: 'framing.delimiter.regex', type: 'string' }, { name: 'ruleset', type: 'string' },
  { name: 'defaulttz', type: 'string' }, { name: 'supportoctetcountedframing', type: 'binary' }, { name: 'framingfix.cisco.asa', type: 'binary' },
  { name: 'maxsessions', type: 'int' }, { name: 'notifyonconnectionclose', type: 'binary' }, { name: 'notifyonconnectionopen', type: 'binary' },
  { name: 'compression.mode', type: 'word' }, { name: 'keepalive', type: 'binary' }, { name: 'keepalive.probes', type: 'int' },
  { name: 'keepalive.time', type: 'int' }, { name: 'keepalive.interval', type: 'int' }, { name: 'addtlframedelimiter', type: 'int' },
  { name: 'ratelimit.interval', type: 'int' }, { name: 'ratelimit.burst', type: 'int' }, { name: 'ratelimit.name', type: 'string' },
  { name: 'multiline', type: 'binary' }, { name: 'listenportfilename', type: 'string' }, { name: 'socketbacklog', type: 'int' },
];

interface PtcpModuleConfig {
  configuredViaModule: boolean;
  workers: number;
  maxSessions: number;
  processOnPoller: boolean;
}

interface PtcpLegacyConfig {
  keepAlive: { enabled: boolean; probes: number; time: number; interval: number };
  notifyOnClose: boolean;
  notifyOnOpen: boolean;
  supportOctetCounted: boolean;
  additionalDelimiter: number;
  maxFrameSize: number;
  inputName: string | null;
  listenAddress: string | null;
  bindRuleset: string | null;
  workers: number;
  maxSessions: number;
}

interface PtcpRuntime {
  total: number;
  attempted: number;
  succeeded: number;
  running: number;
  queueStatistics: StatsObject | null;
  enqueued: number;
  largestQueue: number;
  descriptors: Set<number>;
}

interface PtcpSettings {
  port: string | null;
  address: string | null;
  path: string | null;
  unlink: boolean;
  discardTruncated: boolean;
  fileOwner: number | null;
  fileGroup: number | null;
  fileCreateMode: number;
  maxFrameSize: number;
  inputName: string | null;
  startRegex: string | null;
  ruleset: string | null;
  defaultTimeZone: string | null;
  supportOctetCounted: boolean;
  spFramingFix: boolean;
  maxSessions: number;
  notifyOnClose: boolean;
  notifyOnOpen: boolean;
  compression: CompressionMode;
  keepAlive: { enabled: boolean; probes: number; time: number; interval: number };
  additionalDelimiter: number;
  rateInterval: number;
  rateBurst: number;
  rateName: string | null;
  multiLine: boolean;
  listenPortFile: string | null;
  socketBacklog: number;
  flowControl: boolean;
}

function defaultModuleConfig(): PtcpModuleConfig {
  return { configuredViaModule: false, workers: DEFAULT_WORKERS, maxSessions: 0, processOnPoller: true };
}

function defaultLegacyConfig(): PtcpLegacyConfig {
  return {
    keepAlive: { enabled: false, probes: 0, time: 0, interval: 0 }, notifyOnClose: false, notifyOnOpen: false, supportOctetCounted: true,
    additionalDelimiter: NO_ADDITIONAL_DELIMITER, maxFrameSize: DEFAULT_MAX_FRAME_SIZE, inputName: null, listenAddress: null, bindRuleset: null,
    workers: DEFAULT_WORKERS, maxSessions: 0,
  };
}

function defaultRuntime(): PtcpRuntime {
  return {
    total: 0, attempted: 0, succeeded: 0, running: 0, queueStatistics: null, enqueued: 0, largestQueue: 0, descriptors: new Set<number>(),
  };
}

const moduleConfig = (context: ModuleContext): PtcpModuleConfig => context.moduleState('imptcp.module', defaultModuleConfig);
const legacyConfig = (context: ModuleContext): PtcpLegacyConfig => context.moduleState('imptcp.legacy', defaultLegacyConfig);
const runtimeOf = (context: ModuleContext): PtcpRuntime => context.moduleState('imptcp.runtime', defaultRuntime);

function baseSettings(): PtcpSettings {
  return {
    port: null, address: null, path: null, unlink: false, discardTruncated: false, fileOwner: null, fileGroup: null, fileCreateMode: 0o644,
    maxFrameSize: DEFAULT_MAX_FRAME_SIZE, inputName: null, startRegex: null, ruleset: null, defaultTimeZone: null, supportOctetCounted: true,
    spFramingFix: false, maxSessions: -1, notifyOnClose: false, notifyOnOpen: false, compression: 'never',
    keepAlive: { enabled: false, probes: 0, time: 0, interval: 0 }, additionalDelimiter: NO_ADDITIONAL_DELIMITER, rateInterval: -1, rateBurst: -1,
    rateName: null, multiLine: false, listenPortFile: null, socketBacklog: DEFAULT_BACKLOG, flowControl: true,
  };
}

function firstFreeDescriptor(taken: ReadonlySet<number>): number {
  let candidate = FIRST_SESSION_DESCRIPTOR;
  while (taken.has(candidate)) candidate++;
  return candidate;
}

class PtcpListener {
  statistics: StatsObject | null = null;
  submitted = 0;
  opened = 0;
  openFailed = 0;
  closed = 0;
  receivedBytes = 0;
  decompressedBytes = 0;
  readonly closers: Array<() => void> = [];
}

class PtcpSession {
  readonly descriptor: number;
  readonly framer: PtcpFramer;
  compression: CompressionMode;
  sniffing: boolean;
  readonly sniffed: number[] = [];
  inflater: ZlibInflateStream | null = null;
  streamEnded = false;
  streamFailure: number | null = null;
  decompressing = false;

  constructor(
    readonly connection: StreamConnection,
    readonly listener: PtcpListener,
    readonly host: string,
    readonly ip: string,
    readonly port: string,
    descriptor: number,
    mode: CompressionMode,
    framer: (session: PtcpSession) => PtcpFramer,
  ) {
    this.descriptor = descriptor;
    this.compression = mode;
    this.sniffing = mode === 'auto';
    this.framer = framer(this);
  }
}

type SniffDecision = 'undecided' | 'compressed' | 'plain';

function detectCompression(sniffed: readonly number[]): SniffDecision {
  if (sniffed.length < SNIFF_MIN_BYTES) return 'undecided';
  const [method, flags] = sniffed;
  if (method !== 0x78 || ((method << 8) + flags) % 31 !== 0 || (flags & 0x20) !== 0) return 'plain';
  const probe = new ZlibInflateStream();
  try {
    const result = probe.write(Uint8Array.from(sniffed));
    if (result.output.length > 0 || result.ended) return 'compressed';
  } catch (error) {
    if (error instanceof ZlibError) return 'plain';
    throw error;
  }
  return sniffed.length >= SNIFF_MAX_BYTES ? 'compressed' : 'undecided';
}

class PtcpServer implements InputInstance {
  readonly description: string;
  readonly bindsBeforePrivilegeDrop = true;
  private readonly listeners: PtcpListener[] = [];
  private readonly sessions = new Set<PtcpSession>();
  private limiter: import('../engine/RateLimiter').RateLimiter | null | undefined;
  private unixBound = false;

  constructor(private readonly settings: PtcpSettings, private readonly context: InputContext) {
    this.description = `imptcp(${settings.address ?? '*'}/${settings.port ?? settings.path})`;
    runtimeOf(context).total++;
  }

  private get displayName(): string {
    return this.settings.inputName ?? 'imptcp';
  }

  private get endpoint(): string {
    return this.settings.path ?? this.settings.port ?? '';
  }

  check(): void {
    const ruleset = this.settings.ruleset;
    if (ruleset !== null && !this.context.rulesetExists(ruleset)) {
      this.context.runtime.error(`imptcp: ruleset '${ruleset}' for port ${this.settings.port} not found - using default ruleset instead`, RS_RET.NO_ERRCODE);
    }
  }

  private effectiveRuleset(): string | null {
    const ruleset = this.settings.ruleset;
    return ruleset !== null && this.context.rulesetExists(ruleset) ? ruleset : null;
  }

  private limiterForSubmissions(): import('../engine/RateLimiter').RateLimiter | undefined {
    if (this.limiter === undefined) {
      const settings = this.settings;
      const created = this.context.rateLimiter({
        module: 'imptcp', interval: settings.rateInterval, burst: settings.rateBurst, configName: settings.rateName, forInput: true,
      });
      this.limiter = created === null ? null : created.limiter;
    }
    return this.limiter ?? undefined;
  }

  start(): boolean {
    const runtime = runtimeOf(this.context);
    runtime.attempted++;
    const started = this.bind();
    if (started) runtime.succeeded++;
    if (!started && this.context.settings.requireAllInputs) return false;
    return runtime.attempted < runtime.total || runtime.succeeded > 0;
  }

  private bind(): boolean {
    const settings = this.settings;
    if (settings.rateName !== null && (this.limiterForSubmissions(), this.limiter === null)) {
      this.context.runtime.error(`imptcp: error ${RS_RET.NOT_FOUND} trying to add listener`, RS_RET.NO_ERRCODE);
      return false;
    }
    return settings.path !== null ? this.bindUnix(settings.path) : this.bindTcp();
  }

  private resolvePort(): number | null {
    const text = this.settings.port ?? '';
    if (/^\d+$/.test(text)) {
      const number = Number(text);
      return number <= 65535 ? number : null;
    }
    return this.context.host.network.service(text, 'tcp');
  }

  private bindUnix(path: string): boolean {
    const settings = this.settings;
    const target = path.slice(0, UNIX_PATH_LIMIT);
    const listener = new PtcpListener();
    const outcome: LocalStreamBinding = this.context.host.sockets.listenStream(
      target, { unlink: settings.unlink, mode: settings.fileCreateMode, uid: settings.fileOwner, gid: settings.fileGroup },
      (connection) => this.accept(connection, listener),
    );
    if ('errno' in outcome) {
      const text = outcome.stage === 'bind' ? 'imptcp: error while binding unix socket' : `imptcp: unix socket ${outcome.stage} error`;
      this.context.runtime.error(text, RS_RET.ERR_CRE_AFUX, outcome.errno);
      return false;
    }
    listener.closers.push(outcome.close);
    this.unixBound = true;
    this.attach(listener, false);
    return true;
  }

  private ownerNote(port: number): string | null {
    const owner = this.context.host.network.streamListenerOwner?.(port) ?? null;
    if (owner === null) return null;
    return owner.comm === null ? `one visible listener is PID ${owner.pid}` : `one visible listener is PID ${owner.pid} (${owner.comm})`;
  }

  private reportBindFailure(errno: import('@/network/core/Errno').Errno, port: number): void {
    if (errno === 'EADDRINUSE') {
      const owner = this.ownerNote(port);
      if (owner !== null) {
        this.context.runtime.error(`imptcp: Error binding TCP port ${port}: ${owner}`, RS_RET.NO_ERRCODE, errno);
      } else {
        this.context.runtime.error(
          `imptcp: Error binding TCP port ${port}; listener owner unavailable (try ss -ltnp 'sport = :${port}')`, RS_RET.NO_ERRCODE, errno,
        );
      }
    } else {
      this.context.runtime.error(`imptcp: Error binding TCP port ${port}`, RS_RET.NO_ERRCODE, errno);
    }
  }

  private bindTcp(): boolean {
    const settings = this.settings;
    let port = this.resolvePort();
    if (port === null) return false;
    const policy = this.context.settings.ipProtocol;
    const wanted: Array<'IPv4' | 'IPv6'> = settings.address !== null
      ? [settings.address.includes(':') ? 'IPv6' : 'IPv4']
      : policy === 'ipv4-only' ? ['IPv4'] : policy === 'ipv6-only' ? ['IPv6'] : ['IPv4', 'IPv6'];
    let bound = 0;
    for (const family of wanted) {
      const listener = new PtcpListener();
      const outcome = this.context.host.network.listenStream(
        port, settings.address,
        {
          family: family === 'IPv4' ? 'ipv4-only' : 'ipv6-only', freeBind: 0, backlog: settings.socketBacklog,
          ...(settings.keepAlive.enabled ? { keepAlive: { probes: settings.keepAlive.probes, timeSeconds: settings.keepAlive.time, intervalSeconds: settings.keepAlive.interval } } : {}),
        },
        (connection) => this.accept(connection, listener),
      );
      for (const failure of outcome.failures) this.reportBindFailure(failure.errno, port);
      const first = outcome.listeners[0] as Listener | undefined;
      if (first === undefined) continue;
      for (const each of outcome.listeners) listener.closers.push(() => each.close());
      if (port === 0) {
        port = first.port;
        if (settings.listenPortFile !== null && !this.context.host.files.write(settings.listenPortFile, String(port))) {
          this.context.runtime.error('imptcp: ListenPortFileName: error while trying to open file', RS_RET.IO_ERROR);
          for (const close of listener.closers) close();
          return false;
        }
      }
      this.attach(listener, family === 'IPv6');
      bound++;
    }
    if (bound === 0) return false;
    return !(this.context.settings.requireAllInputs && bound !== wanted.length);
  }

  private attach(listener: PtcpListener, isIPv6: boolean): void {
    const settings = this.settings;
    const label = `${this.displayName}(${settings.address ?? '*'}/${this.endpoint}/${isIPv6 ? 'IPv6' : 'IPv4'})`.slice(0, STATISTICS_NAME_LIMIT);
    const statistics = this.context.statistics.create(label, { origin: 'imptcp' });
    const counter = (name: string, read: () => number, reset: () => void): void => statistics.addCounter({ name, read, reset });
    counter('submitted', () => listener.submitted, () => { listener.submitted = 0; });
    counter('sessions.opened', () => listener.opened, () => { listener.opened = 0; });
    counter('sessions.openfailed', () => listener.openFailed, () => { listener.openFailed = 0; });
    counter('sessions.closed', () => listener.closed, () => { listener.closed = 0; });
    counter('bytes.received', () => listener.receivedBytes, () => { listener.receivedBytes = 0; });
    counter('bytes.decompressed', () => listener.decompressedBytes, () => { listener.decompressedBytes = 0; });
    listener.statistics = statistics;
    this.listeners.push(listener);
  }

  run(): void {
    const runtime = runtimeOf(this.context);
    runtime.running++;
    if (runtime.queueStatistics !== null) return;
    const statistics = this.context.statistics.create('io-work-q', { origin: 'imptcp' });
    statistics.addCounter({ name: 'enqueued', read: () => runtime.enqueued, reset: () => { runtime.enqueued = 0; } });
    statistics.addCounter({ name: 'maxqsize', read: () => runtime.largestQueue });
    runtime.queueStatistics = statistics;
  }

  stop(): void {
    const runtime = runtimeOf(this.context);
    for (const session of [...this.sessions]) this.dropSession(session);
    for (const listener of this.listeners) {
      for (const close of listener.closers) close();
      if (listener.statistics !== null) this.context.statistics.remove(listener.statistics);
    }
    this.listeners.length = 0;
    if (this.unixBound && this.settings.unlink && this.settings.path !== null) this.context.host.files.remove(this.settings.path.slice(0, UNIX_PATH_LIMIT));
    this.unixBound = false;
    if (runtime.running > 0) runtime.running--;
    if (runtime.running === 0 && runtime.queueStatistics !== null) {
      this.context.statistics.remove(runtime.queueStatistics);
      runtime.queueStatistics = null;
    }
  }

  private noteWorkItem(): void {
    if (moduleConfig(this.context).processOnPoller) return;
    const runtime = runtimeOf(this.context);
    runtime.enqueued++;
    runtime.largestQueue = Math.max(runtime.largestQueue, 1);
  }

  private peerNames(connection: StreamConnection): { host: string; ip: string; port: string; malicious: boolean } {
    if (this.settings.path !== null) {
      return { host: this.context.localHostName(), ip: LOCAL_HOST_ADDRESS, port: '', malicious: false };
    }
    const ip = connection.remoteIp;
    const port = String(connection.remotePort);
    if (this.context.settings.disableDns) return { host: ip, ip, port, malicious: false };
    const name = this.context.host.network.reverse(ip);
    if (name === null) return { host: ip, ip, port, malicious: false };
    if (isNumericHost(name)) {
      return { host: `[MALICIOUS:IP=${ip}]`, ip, port, malicious: true };
    }
    return { host: name, ip, port, malicious: false };
  }

  private accept(connection: StreamConnection, listener: PtcpListener): void {
    this.noteWorkItem();
    const settings = this.settings;
    const peer = this.peerNames(connection);
    if (peer.malicious) {
      if (settings.notifyOnOpen) this.context.runtime.error(`imptcp: connection could not be established with host: ${peer.host}`, RS_RET.NO_ERRCODE);
      listener.openFailed++;
      connection.close();
      return;
    }
    if (settings.notifyOnOpen) this.context.runtime.log(LOG_INFO, RS_RET.NO_ERRCODE, `imptcp: connection established with host: ${peer.host}`);
    listener.opened++;
    const limit = settings.maxSessions;
    if (limit > 0 && this.sessions.size >= limit) {
      this.context.runtime.error('imptcp: too many tcp sessions - dropping incoming request', RS_RET.MAX_SESS_REACHED);
      this.context.runtime.error(
        `imptcp: failed to fully accept session from remote peer ${peer.host}[${peer.ip}]. This can be caused by a peer that closed the session immediately after connect, like during a security or health check port probe.`,
        RS_RET.MAX_SESS_REACHED,
      );
      connection.close();
      return;
    }
    const runtime = runtimeOf(this.context);
    const descriptor = firstFreeDescriptor(runtime.descriptors);
    runtime.descriptors.add(descriptor);
    const session = new PtcpSession(connection, listener, peer.host, peer.ip, peer.port, descriptor, settings.compression, (owner) => this.framerFor(owner));
    this.sessions.add(session);
    connection.onData((bytes) => this.receive(session, bytes));
    connection.onClose(() => this.peerClosed(session));
    listener.openFailed++;
  }

  private framerFor(session: PtcpSession): PtcpFramer {
    const settings = this.settings;
    return new PtcpFramer(
      {
        inputName: this.displayName,
        maxLine: this.context.settings.parser.maxLine,
        maxFrameSize: settings.maxFrameSize,
        supportOctetCounted: settings.supportOctetCounted,
        spFramingFix: settings.spFramingFix,
        additionalDelimiter: settings.additionalDelimiter === NO_ADDITIONAL_DELIMITER ? null : settings.additionalDelimiter,
        discardTruncated: settings.discardTruncated,
        multiLine: settings.multiLine,
        startRegex: settings.startRegex,
      },
      {
        submit: (bytes, frameOversize) => this.submit(session, bytes, frameOversize),
        error: (text) => this.context.runtime.error(text, RS_RET.NO_ERRCODE),
        peer: () => ({ host: session.host, ip: session.ip }),
      },
    );
  }

  private receive(session: PtcpSession, bytes: Uint8Array): void {
    if (bytes.length === 0 || !this.sessions.has(session)) return;
    this.noteWorkItem();
    for (let offset = 0; offset < bytes.length; offset += RECEIVE_BUFFER_BYTES) {
      if (!this.dataReceived(session, bytes.subarray(offset, offset + RECEIVE_BUFFER_BYTES))) {
        this.closeSession(session);
        return;
      }
    }
  }

  private now(): number {
    return Math.floor(this.context.host.clock.wallMs() / 1000);
  }

  private dataReceived(session: PtcpSession, data: Uint8Array): boolean {
    session.listener.receivedBytes += data.length;
    let rest = data;
    if (session.sniffing) {
      let taken = 0;
      while (session.sniffed.length < SNIFF_MAX_BYTES && taken < rest.length) session.sniffed.push(rest[taken++]);
      rest = rest.subarray(taken);
      const decision = detectCompression(session.sniffed);
      if (decision === 'undecided') return true;
      session.compression = decision === 'compressed' ? 'always' : 'never';
      session.sniffing = false;
      const held = Uint8Array.from(session.sniffed);
      const accepted = decision === 'compressed' ? this.inflateReceived(session, held) : this.plainReceived(session, held);
      if (!accepted) return false;
      if (rest.length === 0) return true;
    }
    return session.compression === 'always' ? this.inflateReceived(session, rest) : this.plainReceived(session, rest);
  }

  private plainReceived(session: PtcpSession, data: Uint8Array): boolean {
    const messages = session.framer.push(data);
    this.context.recordSender(session.host, messages, this.now());
    return true;
  }

  private reportStreamFailure(session: PtcpSession, failure: string, code: number): false {
    const name = ZLIB_NAMES[code] ?? 'Z_UNKNOWN';
    this.context.runtime.error(
      `imptcp: ${failure} compressed stream from peer ${session.host}[${session.ip}]: zlib state ${name} (${code})`, RS_RET.ZLIB_ERR,
    );
    return false;
  }

  private deliverInflated(session: PtcpSession, output: Uint8Array, whole: boolean): void {
    const usable = whole ? output.length : output.length - (output.length % INFLATE_BUFFER_BYTES);
    for (let offset = 0; offset < usable; offset += INFLATE_BUFFER_BYTES) {
      const chunk = output.subarray(offset, Math.min(usable, offset + INFLATE_BUFFER_BYTES));
      session.listener.decompressedBytes += chunk.length;
      session.decompressing = true;
      try {
        this.plainReceived(session, chunk);
      } finally {
        session.decompressing = false;
      }
    }
  }

  private inflateReceived(session: PtcpSession, data: Uint8Array): boolean {
    if (session.streamEnded) return this.reportStreamFailure(session, 'received trailing data after end of', Z_STREAM_END);
    session.inflater ??= new ZlibInflateStream();
    let result;
    try {
      result = session.inflater.write(data);
    } catch (error) {
      if (!(error instanceof ZlibError)) throw error;
      this.deliverInflated(session, error.partial ?? new Uint8Array(0), false);
      session.streamFailure = zlibErrorCode(error);
      return this.reportStreamFailure(session, 'received invalid', session.streamFailure);
    }
    if (result.ended) session.streamEnded = true;
    this.deliverInflated(session, result.output, true);
    if (result.ended && result.trailingBytes > 0) return this.reportStreamFailure(session, 'received trailing data after end of', Z_STREAM_END);
    return true;
  }

  private submit(session: PtcpSession, bytes: Uint8Array, frameOversize: boolean): void {
    const settings = this.settings;
    const accepted = this.context.submitter.submit({
      raw: '',
      bytes,
      inputName: this.displayName,
      fromHost: session.host,
      fromHostIp: session.ip,
      fromHostPort: session.port,
      ruleset: this.effectiveRuleset(),
      defaultTimeZone: settings.defaultTimeZone,
      limiter: this.limiterForSubmissions(),
      flowControl: settings.flowControl ? 'light' : 'none',
      ...(session.decompressing ? { noLegacyZDecompress: true } : {}),
      frameOversize,
    });
    if (accepted) session.listener.submitted++;
  }

  private peerClosed(session: PtcpSession): void {
    if (!this.sessions.has(session)) return;
    this.noteWorkItem();
    if (this.settings.notifyOnClose) {
      this.context.runtime.error(`imptcp session ${session.descriptor} closed by remote peer ${session.host}.`, RS_RET.PEER_CLOSED_CONN);
    }
    this.closeSession(session);
  }

  private finishStream(session: PtcpSession): number {
    if (session.compression === 'never' || session.inflater === null || session.streamEnded) return RS_RET.OK_VALUE;
    if (session.streamFailure !== null) this.reportStreamFailure(session, 'received invalid', session.streamFailure);
    else this.reportStreamFailure(session, 'detected truncated', Z_BUF_ERROR);
    return RS_RET.ZLIB_ERR;
  }

  private closeSession(session: PtcpSession): void {
    if (!this.sessions.has(session)) return;
    const status = this.finishStream(session);
    this.dropSession(session);
    if (this.settings.notifyOnClose) {
      this.context.runtime.log(LOG_INFO, RS_RET.NO_ERRCODE, `imptcp: session on socket ${session.descriptor} closed with iRet ${status}.\n`);
    }
    session.listener.closed++;
  }

  private dropSession(session: PtcpSession): void {
    this.sessions.delete(session);
    runtimeOf(this.context).descriptors.delete(session.descriptor);
    session.connection.close();
  }
}

function applyParams(values: ParamValues, context: InputContext): PtcpSettings | null {
  const settings = baseSettings();
  const module = moduleConfig(context);
  const rejectMissingEndpoint = (): boolean => {
    if (settings.port !== null && settings.port.length > 0 || settings.path !== null && settings.path.length > 0) return false;
    context.runtime.error('imptcp: Must have either port or path defined', RS_RET.PARAM_ERROR);
    return true;
  };
  for (const descriptor of INPUT_PARAMS) {
    const value = values.get(descriptor.name);
    if (value === undefined) continue;
    const number = value.kind === 'N' ? value.n : 0;
    const text = value.kind === 'S' ? value.s : '';
    switch (descriptor.name) {
      case 'port': settings.port = text; break;
      case 'address': settings.address = text; break;
      case 'path': settings.path = text; break;
      case 'unlink': settings.unlink = number !== 0; break;
      case 'discardtruncatedmsg': settings.discardTruncated = number !== 0; break;
      case 'flowcontrol': settings.flowControl = number !== 0; break;
      case 'fileowner': case 'fileownernum': settings.fileOwner = number; break;
      case 'filegroup': case 'filegroupnum': settings.fileGroup = number; break;
      case 'filecreatemode': settings.fileCreateMode = number; break;
      case 'failonchownfailure': break;
      case 'name': settings.inputName = text; break;
      case 'maxframesize':
        if (number > MAX_FRAME_SIZE_LIMIT) {
          context.runtime.error(`imptcp: invalid value for 'maxFrameSize' parameter given is ${number}, max is ${MAX_FRAME_SIZE_LIMIT}`, RS_RET.PARAM_ERROR);
          return null;
        }
        settings.maxFrameSize = number;
        break;
      case 'framing.delimiter.regex': settings.startRegex = text; break;
      case 'ruleset': settings.ruleset = text; break;
      case 'supportoctetcountedframing': settings.supportOctetCounted = number !== 0; break;
      case 'framingfix.cisco.asa': settings.spFramingFix = number !== 0; break;
      case 'compression.mode': {
        const lowered = text.toLowerCase();
        if (lowered === 'stream:always') settings.compression = 'always';
        else if (lowered === 'stream:auto') settings.compression = 'auto';
        else if (lowered === 'none') settings.compression = 'never';
        else {
          context.runtime.error(`imptcp: invalid value for 'compression.mode' parameter (given is '${text}')`, RS_RET.PARAM_ERROR);
          return null;
        }
        break;
      }
      case 'maxsessions': settings.maxSessions = number; break;
      case 'keepalive': settings.keepAlive.enabled = number !== 0; break;
      case 'keepalive.probes': settings.keepAlive.probes = number; break;
      case 'keepalive.time': settings.keepAlive.time = number; break;
      case 'keepalive.interval': settings.keepAlive.interval = number; break;
      case 'addtlframedelimiter': settings.additionalDelimiter = number; break;
      case 'notifyonconnectionclose': settings.notifyOnClose = number !== 0; break;
      case 'notifyonconnectionopen': settings.notifyOnOpen = number !== 0; break;
      case 'defaulttz': settings.defaultTimeZone = text; break;
      case 'ratelimit.burst': settings.rateBurst = number; break;
      case 'ratelimit.interval': settings.rateInterval = number; break;
      case 'ratelimit.name': settings.rateName = text; break;
      case 'multiline': settings.multiLine = number !== 0; break;
      case 'listenportfilename': settings.listenPortFile = text; break;
      case 'socketbacklog': settings.socketBacklog = number; break;
      default: break;
    }
    if (rejectMissingEndpoint()) return null;
  }
  if (settings.startRegex !== null) {
    try {
      new RegExp(settings.startRegex);
    } catch (error) {
      context.runtime.error(`imptcp: error in framing.delimiter.regex expansion: ${error instanceof Error ? error.message : String(error)}`, RS_RET.ERR);
      return null;
    }
  }
  if (settings.rateName !== null) {
    if (settings.rateInterval !== -1 || settings.rateBurst !== -1) {
      context.runtime.error('imptcp: ratelimit.name is mutually exclusive with ratelimit.interval and ratelimit.burst - using named ratelimit', RS_RET.INVALID_PARAMS);
    }
  } else {
    if (settings.rateInterval === -1) settings.rateInterval = 0;
    if (settings.rateBurst === -1) settings.rateBurst = DEFAULT_RATE_BURST;
  }
  if (settings.maxSessions === -1) settings.maxSessions = module.maxSessions;
  return settings;
}

function createInstances(params: NvList, context: InputContext): InputInstance[] | null {
  const report = (message: string): void => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR);
  const values = getParams(params, INPUT_PARAMS, {
    report, uidOf: (name) => context.host.users.uidOf(name), gidOf: (name) => context.host.users.gidOf(name),
  });
  if (values === null) {
    context.runtime.error('imptcp: required parameter are missing\n', RS_RET.MISSING_CNFPARAMS);
    return null;
  }
  reportUnused(params, report);
  const settings = applyParams(values, context);
  return settings === null ? null : [new PtcpServer(settings, context)];
}

function directives(): DirectiveRegistration[] {
  const legacy = (apply: (config: PtcpLegacyConfig, value: number | string) => void) =>
    (value: number | string, context: InputContext): void => apply(legacyConfig(context), value);
  return [
    {
      name: 'inputptcpserverrun', type: 'word',
      apply: (value, context) => {
        const port = String(value);
        if (port.length === 0) {
          context.runtime.error('imptcp: port number must be specified, listener ignored', RS_RET.PARAM_ERROR);
          return;
        }
        const config = legacyConfig(context);
        const settings = baseSettings();
        settings.port = port;
        settings.address = config.listenAddress;
        settings.ruleset = config.bindRuleset;
        settings.inputName = config.inputName;
        settings.supportOctetCounted = config.supportOctetCounted;
        settings.keepAlive = { ...config.keepAlive };
        settings.notifyOnClose = config.notifyOnClose;
        settings.notifyOnOpen = config.notifyOnOpen;
        settings.additionalDelimiter = config.additionalDelimiter;
        settings.maxFrameSize = config.maxFrameSize;
        settings.maxSessions = config.maxSessions;
        settings.rateInterval = 0;
        settings.rateBurst = DEFAULT_RATE_BURST;
        context.registerInput('imptcp', new PtcpServer(settings, context));
      },
    },
    { name: 'inputptcpserverkeepalive', type: 'binary', apply: legacy((config, value) => { config.keepAlive.enabled = value === 1; }) },
    { name: 'inputptcpserverkeepalive_probes', type: 'int', apply: legacy((config, value) => { config.keepAlive.probes = Number(value); }) },
    { name: 'inputptcpserverkeepalive_time', type: 'int', apply: legacy((config, value) => { config.keepAlive.time = Number(value); }) },
    { name: 'inputptcpserverkeepalive_intvl', type: 'int', apply: legacy((config, value) => { config.keepAlive.interval = Number(value); }) },
    { name: 'inputptcpserversupportoctetcountedframing', type: 'binary', apply: legacy((config, value) => { config.supportOctetCounted = value === 1; }) },
    { name: 'inputptcpservernotifyonconnectionclose', type: 'binary', apply: legacy((config, value) => { config.notifyOnClose = value === 1; }) },
    { name: 'inputptcpserveraddtlframedelimiter', type: 'int', apply: legacy((config, value) => { config.additionalDelimiter = Number(value); }) },
    { name: 'inputptcpserverinputname', type: 'word', apply: legacy((config, value) => { config.inputName = String(value); }) },
    { name: 'inputptcpserverlistenip', type: 'word', apply: legacy((config, value) => { config.listenAddress = String(value); }) },
    { name: 'inputptcpserverbindruleset', type: 'word', apply: legacy((config, value) => { config.bindRuleset = String(value); }) },
    {
      name: 'inputptcpserverhelperthreads', type: 'int',
      apply: (value, context) => {
        if (moduleConfig(context).configuredViaModule) {
          context.runtime.error(
            "command 'inputptcpserverhelperthreads' is currently not permitted - did you already set it via a RainerScript command (v6+ config)?",
            RS_RET.PARAM_NOT_PERMITTED,
          );
          return;
        }
        legacyConfig(context).workers = Number(value);
      },
    },
  ];
}

export const imptcp: InputModule = {
  kind: 'input',
  name: 'imptcp',
  builtin: false,
  newInstances: createInstances,
  directives,
  setModuleConfig(params, context) {
    const report = (message: string): void => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR);
    const values = getParams(params, [{ name: 'load', type: 'string' }, ...MODULE_PARAMS], { report, uidOf: () => null, gidOf: () => null });
    if (values === null) {
      context.runtime.error('imptcp: error processing module config parameters [module(...)]', RS_RET.MISSING_CNFPARAMS);
      return false;
    }
    const config = moduleConfig(context);
    config.workers = numberParam(values, 'threads') ?? config.workers;
    config.maxSessions = numberParam(values, 'maxsessions') ?? config.maxSessions;
    const poller = numberParam(values, 'processonpoller');
    if (poller !== undefined) config.processOnPoller = poller !== 0;
    config.configuredViaModule = true;
    return true;
  },
  check(instanceCount, context) {
    if (instanceCount === 0) {
      context.runtime.error('imptcp: no ptcp server defined, module can not run.', RS_RET.NO_LSTN_DEFINED);
      context.runtime.log(3, RS_RET.NO_RUN, 'activation of module imptcp failed');
    }
  },
  reset(context) {
    Object.assign(legacyConfig(context), defaultLegacyConfig());
  },
};

