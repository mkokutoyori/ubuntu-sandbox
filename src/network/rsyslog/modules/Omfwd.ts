import { errnoNumber, type Errno } from '@/network/core/Errno';
import { PortNumber } from '@/network/core/ports/PortNumber';
import type { NvList } from '../config/Ast';
import { arrayParam, getParams, numberParam, reportUnused, stringParam, type ParamDescriptor } from '../config/Params';
import type { RsyslogMessage } from '../Message';
import type { Resolution, SrvRecord, StreamConnection } from '../engine/Host';
import { emptyTlsExtras, readTlsExtras, resolveStreamTls, type StreamTlsExtras, type StreamTlsOptions } from '../engine/StreamDriver';
import { RS_RET } from '../engine/Log';
import type { StatsObject } from '../engine/Statistics';
import type {
  ActionArguments, ActionModuleInstance, ActionOutcome, ActionWorker, DirectiveRegistration, ModuleContext, ModuleRateLimiter,
  OutputModule, SelectorParse, TemplateRequest,
} from '../engine/Modules';
import { zlibCompress } from '../Zlib';
import { parseSelectorTemplate } from './SelectorTemplate';

const UDP_MAX_MSGSIZE = 65507;
const MIN_SIZE_FOR_COMPRESS = 60;
const DEFAULT_POOL_RESUME_INTERVAL = 30;
const DEFAULT_TEMPLATE = 'RSYSLOG_TraditionalForwardFormat';
const LOG_WARNING = 4;
const LOG_INFO = 6;
const LOG_DEBUG = 7;
const FIRST_SOCKET_DESCRIPTOR = 4;
const FIRST_THREAD_IDENTIFIER = 139_700_000_000_000;

type Protocol = 'udp' | 'tcp';
type Framing = 'octet-stuffing' | 'octet-counting';
type CompressionMode = 'never' | 'single';

interface KeepAliveSettings {
  enabled: boolean;
  probes: number;
  intervalSeconds: number;
  timeSeconds: number;
}

interface ForwardSettings {
  protocol: Protocol;
  targets: string[];
  ports: string[];
  targetSrv: string | null;
  address: string | null;
  device: string | null;
  networkNamespace: string | null;
  framing: Framing;
  framingDelimiter: number;
  compressionMode: CompressionMode;
  compressionLevel: number;
  rebindInterval: number;
  keepAlive: KeepAliveSettings;
  userTimeoutMs: number;
  connectionErrorSkip: number;
  resendLastOnReconnect: boolean;
  extendedConnectionCheck: boolean;
  sendToAll: boolean;
  udpSendDelayMicroseconds: number;
  udpSendBufferBytes: number;
  freeBind: boolean;
  poolResumeInterval: number;
  templateName: string;
  streamDriverMode: number;
  streamDriverModeSet: boolean;
  streamDriver: string | null;
  authMode: string | null;
  tls: StreamTlsExtras;
  resolvedTls: StreamTlsOptions | null;
  rateLimiter: ModuleRateLimiter | null;
}

interface OmfwdLegacyState {
  templateName: string | null;
  streamDriver: string | null;
  streamDriverMode: number;
  streamDriverModeSet: boolean;
  resendLastOnReconnect: boolean;
  streamDriverAuthMode: string | null;
  streamDriverRemoteSni: string | null;
  tcpRebindInterval: number;
  udpRebindInterval: number;
  keepAlive: KeepAliveSettings;
  connectionErrorSkip: number;
  permittedPeers: string[];
}

interface OmfwdModuleConfig {
  templateName: string | null;
  maxSendBuffer: number;
  caFile: string | null;
  crlFile: string | null;
  caExtraFiles: string | null;
  keyFile: string | null;
  certFile: string | null;
}

interface OmfwdProcessState {
  nextWorker: number;
  connectionErrorCount: number;
  activeTargets: number;
  nextSocket: number;
}

const MODULE_PARAMS: readonly ParamDescriptor[] = [
  { name: 'iobuffer.maxsize', type: 'nonneg' }, { name: 'template', type: 'word' }, { name: 'streamdriver.cafile', type: 'string' },
  { name: 'streamdriver.crlfile', type: 'string' }, { name: 'streamdriver.caextrafiles', type: 'string' },
  { name: 'streamdriver.keyfile', type: 'string' }, { name: 'streamdriver.certfile', type: 'string' },
];

const ACTION_PARAMS: readonly ParamDescriptor[] = [
  { name: 'target', type: 'array' }, { name: 'targetsrv', type: 'word' }, { name: 'address', type: 'word' }, { name: 'device', type: 'word' },
  { name: 'port', type: 'array' }, { name: 'protocol', type: 'word' }, { name: 'networknamespace', type: 'word' },
  { name: 'tcp_framing', type: 'word' }, { name: 'tcp_framedelimiter', type: 'int' }, { name: 'ziplevel', type: 'int' },
  { name: 'compression.mode', type: 'word' }, { name: 'compression.driver', type: 'word' },
  { name: 'compression.stream.flushontxend', type: 'binary' }, { name: 'ipfreebind', type: 'int' },
  { name: 'maxerrormessages', type: 'int', deprecated: true }, { name: 'rebindinterval', type: 'int' }, { name: 'keepalive', type: 'binary' },
  { name: 'keepalive.probes', type: 'nonneg' }, { name: 'keepalive.time', type: 'nonneg' }, { name: 'keepalive.interval', type: 'nonneg' },
  { name: 'tcp_user_timeout', type: 'nonneg' }, { name: 'conerrskip', type: 'nonneg' }, { name: 'gnutlsprioritystring', type: 'string' },
  { name: 'streamdriver', type: 'word' }, { name: 'streamdriver.name', type: 'word' }, { name: 'streamdrivermode', type: 'int' },
  { name: 'streamdriver.mode', type: 'int' }, { name: 'streamdriverauthmode', type: 'word' }, { name: 'streamdriver.authmode', type: 'word' },
  { name: 'streamdriverpermittedpeers', type: 'word' }, { name: 'streamdriver.permitexpiredcerts', type: 'word' },
  { name: 'streamdriverremotesni', type: 'string' }, { name: 'streamdriver.remotesni', type: 'string' },
  { name: 'streamdriver.checkextendedkeypurpose', type: 'binary' }, { name: 'streamdriver.prioritizesan', type: 'binary' },
  { name: 'streamdriver.tlsverifydepth', type: 'positive' }, { name: 'streamdriver.cafile', type: 'string' },
  { name: 'streamdriver.crlfile', type: 'string' }, { name: 'streamdriver.caextrafiles', type: 'string' },
  { name: 'streamdriver.keyfile', type: 'string' }, { name: 'streamdriver.certfile', type: 'string' },
  { name: 'resendlastmsgonreconnect', type: 'binary' }, { name: 'extendedconnectioncheck', type: 'binary' },
  { name: 'udp.sendtoall', type: 'binary' }, { name: 'udp.senddelay', type: 'int' }, { name: 'udp.sendbuf', type: 'size' },
  { name: 'template', type: 'word' }, { name: 'pool.resumeinterval', type: 'positive' }, { name: 'ratelimit.interval', type: 'int' },
  { name: 'ratelimit.burst', type: 'int' }, { name: 'ratelimit.name', type: 'string' },
];

function defaultKeepAlive(): KeepAliveSettings {
  return { enabled: false, probes: 0, intervalSeconds: 0, timeSeconds: 0 };
}

function defaultLegacyState(): OmfwdLegacyState {
  return {
    templateName: null, streamDriver: null, streamDriverMode: 0, streamDriverModeSet: false, resendLastOnReconnect: false,
    streamDriverAuthMode: null, streamDriverRemoteSni: null, tcpRebindInterval: 0, udpRebindInterval: 0, keepAlive: defaultKeepAlive(),
    connectionErrorSkip: 0, permittedPeers: [],
  };
}

function defaultModuleConfig(): OmfwdModuleConfig {
  return { templateName: null, maxSendBuffer: -1, caFile: null, crlFile: null, caExtraFiles: null, keyFile: null, certFile: null };
}

function legacyState(context: ModuleContext): OmfwdLegacyState {
  return context.moduleState('omfwd.legacy', defaultLegacyState);
}

function moduleConfig(context: ModuleContext): OmfwdModuleConfig {
  return context.moduleState('omfwd.config', defaultModuleConfig);
}

function processState(context: ModuleContext): OmfwdProcessState {
  return context.moduleState('omfwd.process', () => ({
    nextWorker: 0, connectionErrorCount: 0, activeTargets: 0, nextSocket: FIRST_SOCKET_DESCRIPTOR,
  }));
}

function defaultTemplateName(context: ModuleContext): string {
  return moduleConfig(context).templateName ?? legacyState(context).templateName ?? DEFAULT_TEMPLATE;
}

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function buildFrame(payload: Uint8Array, settings: ForwardSettings): Uint8Array {
  const compressed = payload.length > 0 && payload[0] === 0x7a;
  const framing = compressed ? 'octet-counting' : settings.framing;
  if (framing === 'octet-stuffing') {
    if (payload.length > 0 && payload[payload.length - 1] === settings.framingDelimiter) return payload;
    const framed = new Uint8Array(payload.length + 1);
    framed.set(payload);
    framed[payload.length] = settings.framingDelimiter;
    return framed;
  }
  const header = encodeText(`${payload.length} `);
  const framed = new Uint8Array(header.length + payload.length);
  framed.set(header);
  framed.set(payload, header.length);
  return framed;
}

class ForwardTarget {
  connection: StreamConnection | null = null;
  connected = false;
  addresses: string[] = [];
  socket = 0;
  resumeAtSeconds: number;
  sentMessages = 0;
  connects = 0;
  previousFrame: Uint8Array | null = null;
  transmissions = 0;

  constructor(readonly name: string, readonly port: string, resumeAtSeconds: number) {
    this.resumeAtSeconds = resumeAtSeconds;
  }
}

class OmfwdWorker implements ActionWorker {
  private readonly targets: ForwardTarget[];
  private actualTarget = 0;
  private transmissions = 0;
  private pendingPause = 0;
  private readonly workerId: number;

  constructor(private readonly settings: ForwardSettings, private readonly context: ModuleContext, private readonly sent: { bytes: number }) {
    const state = processState(context);
    this.workerId = state.nextWorker++;
    const resumeAt = this.nowSeconds() - 1;
    this.targets = settings.targets.map((name, index) => new ForwardTarget(name, settings.ports[index < settings.ports.length ? index : 0], resumeAt));
  }

  private nowSeconds(): number {
    return Math.floor(this.context.host.clock.wallMs() / 1000);
  }

  private get threadIdentifier(): number {
    return FIRST_THREAD_IDENTIFIER + this.workerId * 4096;
  }

  private resolveHost(name: string): Resolution {
    const resolution = this.context.host.network.resolve(name);
    if ('error' in resolution) return resolution;
    const family = this.context.settings.ipProtocol;
    if (family === 'unspecified') return resolution;
    const addresses = resolution.addresses.filter((address) => address.includes(':') === (family === 'ipv6-only'));
    return addresses.length > 0 ? { addresses } : { error: 'No address associated with hostname' };
  }

  private servicePort(target: ForwardTarget, numericOnly: boolean): PortNumber | null {
    const numeric = PortNumber.tryParse(target.port);
    if (numeric !== null || numericOnly) return numeric;
    const named = this.context.host.network.service(target.port, 'tcp');
    return named === null ? null : PortNumber.tryParse(String(named));
  }

  private debug(text: string): void {
    this.context.runtime.log(LOG_DEBUG, RS_RET.DEBUG, text);
  }

  private activeCount(): number {
    return this.targets.filter((target) => target.connected).length;
  }

  private countActiveTargets(): number {
    const state = processState(this.context);
    const active = this.activeCount();
    if (state.activeTargets !== active) {
      this.debug(`omfwd: [wrkr ${this.workerId}] number of active targets changed from ${state.activeTargets} to ${active}`);
      state.activeTargets = active;
    }
    return active;
  }

  private destroyTarget(target: ForwardTarget, rebind: boolean): void {
    target.connection?.close();
    target.connection = null;
    target.addresses = [];
    target.socket = 0;
    target.resumeAtSeconds = rebind ? 0 : this.nowSeconds() + this.settings.poolResumeInterval;
    target.connected = false;
  }

  private emitConnectionError(target: ForwardTarget, code: number): void {
    const settings = this.settings;
    const state = processState(this.context);
    const reason = code === RS_RET.PEER_CLOSED_CONN
      ? 'remote server closed connection. '
      : 'we had a generic or IO error with the remote server. The actual error message should already have been provided. ';
    const advice = 'This can be caused by the remote server or an interim system like a load balancer or firewall. Rsyslog will re-open the connection if configured to do so.';
    if (code === RS_RET.IO_ERROR || code === RS_RET.PEER_CLOSED_CONN) {
      const skip = settings.connectionErrorSkip;
      if (skip <= 1) {
        this.context.runtime.error(
          `omfwd: [wrkr ${this.workerId}/${this.threadIdentifier}] ${reason}Server is ${target.name}:${target.port}. ${advice}`, code,
        );
      } else if (state.connectionErrorCount++ % skip === 0) {
        this.context.runtime.error(
          `omfwd: [wrkr ${this.workerId}] ${reason}Server is ${target.name}:${target.port}. ${advice} Note that the next ${skip - 1} connection error messages will be skipped.`,
          code,
        );
      }
    } else {
      this.context.runtime.error(`omfwd: TCPSendBuf error ${code}, destruct TCP Connection to ${target.name}:${target.port}`, code);
    }
  }

  private checkConnection(target: ForwardTarget): 'ok' | 'suspended' {
    if (this.settings.protocol !== 'tcp' || !this.settings.extendedConnectionCheck || target.connection === null) return 'ok';
    if (!target.connection.closedByPeer) return 'ok';
    this.context.runtime.log(LOG_INFO, RS_RET.IO_ERROR, 'ptcp network driver: CheckConnection detected that peer closed connection.');
    target.connection = null;
    this.emitConnectionError(target, RS_RET.PEER_CLOSED_CONN);
    this.destroyTarget(target, false);
    return 'suspended';
  }

  private connectTcp(target: ForwardTarget): boolean {
    if (target.connection !== null) return true;
    const settings = this.settings;
    const network = this.context.host.network;
    const resolution = this.resolveHost(target.name);
    const port = this.servicePort(target, false);
    if ('error' in resolution || port === null) {
      const reason = 'error' in resolution ? resolution.error : 'Servname not supported for ai_socktype';
      this.context.runtime.error(`cannot resolve hostname '${target.name}': ${reason}`, RS_RET.IO_ERROR);
      this.destroyTarget(target, false);
      return false;
    }
    const clock = this.context.host.clock;
    const startedAt = clock.monotonicMs();
    let lastError: Errno = 'ECONNREFUSED';
    let connection: StreamConnection | null = null;
    for (const address of resolution.addresses) {
      const attempt = network.connectStream(address, port.value, {
        device: settings.device ?? undefined,
        networkNamespace: settings.networkNamespace ?? undefined,
        tls: settings.resolvedTls === null ? undefined : { ...settings.resolvedTls, connectHost: target.name },
        userTimeoutMs: settings.userTimeoutMs > 0 ? settings.userTimeoutMs : undefined,
        keepAlive: settings.keepAlive.enabled
          ? { probes: settings.keepAlive.probes, timeSeconds: settings.keepAlive.timeSeconds, intervalSeconds: settings.keepAlive.intervalSeconds }
          : undefined,
      });
      if ('errno' in attempt) {
        lastError = attempt.errno;
        continue;
      }
      connection = attempt;
      break;
    }
    if (connection === null) {
      const elapsedMs = Math.max(0, clock.monotonicMs() - startedAt);
      const seconds = Math.floor(elapsedMs / 1000);
      const hundredths = Math.floor((elapsedMs % 1000) / 10);
      this.context.runtime.error(
        `cannot connect to ${target.name}:${target.port} (took ${seconds}.${String(hundredths).padStart(2, '0')} seconds)`, RS_RET.IO_ERROR, lastError,
      );
      this.destroyTarget(target, false);
      return false;
    }
    target.connection = connection;
    target.connects++;
    this.debug(`omfwd: [wrkr ${this.workerId}] TCPSendInitTarget established connection to ${target.name}:${target.port}`);
    return true;
  }

  private resumeTarget(target: ForwardTarget): 'ok' | 'suspended' {
    if (target.connected) return 'ok';
    if (target.resumeAtSeconds > 0 && this.activeCount() > 0 && this.nowSeconds() < target.resumeAtSeconds) return 'suspended';
    const settings = this.settings;
    if (settings.protocol === 'udp') {
      const resolution = this.resolveHost(target.name);
      if ('error' in resolution || this.servicePort(target, true) === null) {
        const reason = 'error' in resolution ? resolution.error : 'Servname not supported for ai_socktype';
        this.context.runtime.error(`omfwd: could not get addrinfo for hostname '${target.name}':'${target.port}': ${reason}`, RS_RET.SUSPENDED);
        this.destroyTarget(target, false);
        return 'suspended';
      }
      if (settings.address !== null) {
        const bind = this.resolveHost(settings.address);
        if ('error' in bind) {
          this.context.runtime.error(`omfwd: cannot use bind address '${settings.address}' for host '${target.name}': ${bind.error}`, RS_RET.SUSPENDED);
          this.destroyTarget(target, false);
          return 'suspended';
        }
      }
      target.addresses = resolution.addresses;
      if (target.socket === 0) target.socket = processState(this.context).nextSocket++;
      target.connected = true;
      return 'ok';
    }
    if (!this.connectTcp(target)) return 'suspended';
    target.connected = true;
    return 'ok';
  }

  private poolResume(): 'ok' | 'suspended' {
    let anyOk = false;
    for (const target of this.targets) {
      if (target.connected) {
        if (this.checkConnection(target) === 'ok') anyOk = true;
      } else if (this.resumeTarget(target) === 'ok') {
        anyOk = true;
      }
    }
    return anyOk ? 'ok' : 'suspended';
  }

  private sendUdp(payload: Uint8Array): 'ok' | 'suspended' {
    const settings = this.settings;
    const target = this.targets[0];
    if (settings.rebindInterval > 0 && target.transmissions++ % settings.rebindInterval === 0) {
      target.transmissions = 1;
      this.destroyTarget(target, true);
    }
    if (target.socket === 0 && this.resumeTarget(target) !== 'ok') return 'suspended';
    const port = this.servicePort(target, true) as PortNumber;
    let length = payload.length;
    if (length > UDP_MAX_MSGSIZE) {
      this.context.runtime.error(
        `omfwd/udp: message is ${length} bytes long, but UDP can send at most ${UDP_MAX_MSGSIZE} bytes (by RFC limit) - truncating message`,
        RS_RET.UDP_MSGSIZE_TOO_LARGE,
      );
      length = UDP_MAX_MSGSIZE;
    }
    let success = false;
    let reinitialize = false;
    let lastError: Errno = 'ENOENT';
    let lastSocket = -1;
    let lastSent = false;
    for (const address of target.addresses) {
      let attemptLength = length;
      lastSent = false;
      for (;;) {
        const failure = this.context.host.network.sendDatagram(address, port.value, payload.subarray(0, attemptLength), {
          sourceAddress: settings.address ?? undefined,
          device: settings.device ?? undefined,
          sendBufferBytes: settings.udpSendBufferBytes > 0 ? settings.udpSendBufferBytes : undefined,
          freeBind: settings.freeBind,
        });
        if (failure === null) {
          success = true;
          lastSent = attemptLength === length;
          this.sent.bytes += attemptLength;
          break;
        }
        if (failure === 'EMSGSIZE') {
          const shorter = attemptLength > 1024 ? attemptLength - 1024 : 512;
          this.context.runtime.error(
            `omfwd/udp: send failed due to message being too large for this system. Message size was ${attemptLength} bytes. Truncating to ${shorter} bytes and retrying.`,
            RS_RET.UDP_MSGSIZE_TOO_LARGE,
          );
          attemptLength = shorter;
          continue;
        }
        reinitialize = true;
        lastError = failure;
        lastSocket = target.socket;
        this.context.runtime.error(`omfwd/udp: socket ${target.socket}: sendto() error`, RS_RET.ERR_UDPSEND, failure);
        break;
      }
      if (lastSent && !settings.sendToAll) break;
    }
    if (reinitialize) this.destroyTarget(target, false);
    if (success) {
      if (settings.udpSendDelayMicroseconds > 0) this.pendingPause = Math.max(1, Math.ceil(settings.udpSendDelayMicroseconds / 1000));
      return 'ok';
    }
    this.context.runtime.error(`omfwd: socket ${lastSocket}: error ${errnoNumber(lastError)} sending via udp`, RS_RET.ERR_UDPSEND, lastError);
    return 'suspended';
  }

  private writeFrame(target: ForwardTarget, frame: Uint8Array): 'ok' | 'suspended' {
    const settings = this.settings;
    if (settings.extendedConnectionCheck && target.connection !== null && target.connection.closedByPeer) {
      this.context.runtime.log(LOG_INFO, RS_RET.IO_ERROR, 'ptcp network driver: CheckConnection detected that peer closed connection.');
      target.connection = null;
      this.emitConnectionError(target, RS_RET.PEER_CLOSED_CONN);
      this.destroyTarget(target, false);
      return 'suspended';
    }
    const failure = target.connection === null ? 'EPIPE' : target.connection.write(frame);
    if (failure !== null) {
      this.emitConnectionError(target, RS_RET.IO_ERROR);
      this.destroyTarget(target, false);
      return 'suspended';
    }
    this.sent.bytes += frame.length;
    return 'ok';
  }

  private sendTcp(target: ForwardTarget, payload: Uint8Array): 'ok' | 'suspended' | 'failed' {
    const frame = buildFrame(payload, this.settings);
    let retried = false;
    for (;;) {
      if (!this.connectTcp(target)) return 'failed';
      const outcome = this.writeFrame(target, frame);
      if (outcome === 'ok') {
        if (this.settings.resendLastOnReconnect) target.previousFrame = frame.slice();
        return 'ok';
      }
      if (retried) return outcome;
      retried = true;
      this.destroyTarget(target, false);
      if (target.previousFrame !== null) {
        if (!this.connectTcp(target)) return 'failed';
        const resent = this.writeFrame(target, target.previousFrame);
        if (resent !== 'ok') return 'failed';
      }
    }
  }

  private processMessage(target: ForwardTarget, text: string): 'ok' | 'suspended' {
    const settings = this.settings;
    const maxLine = this.context.settings.parser.maxLine;
    let payload = encodeText(text);
    if (payload.length > maxLine) payload = payload.subarray(0, maxLine);
    if (settings.compressionMode === 'single' && payload.length > MIN_SIZE_FOR_COMPRESS) {
      const deflated = zlibCompress(payload, settings.compressionLevel);
      if (deflated.length + 1 < payload.length) {
        const marked = new Uint8Array(deflated.length + 1);
        marked[0] = 0x7a;
        marked.set(deflated, 1);
        payload = marked;
      }
    }
    let outcome: 'ok' | 'suspended';
    if (settings.protocol === 'udp') {
      outcome = this.sendUdp(payload);
    } else {
      const sent = this.sendTcp(target, payload);
      if (sent === 'ok') {
        outcome = 'ok';
      } else {
        this.context.runtime.error(`omfwd: error forwarding via tcp to ${target.name}:${target.port}, suspending target`, RS_RET.SUSPENDED);
        this.destroyTarget(target, false);
        outcome = 'suspended';
      }
    }
    if (outcome === 'ok') target.sentMessages++;
    return outcome;
  }

  doAction(args: ActionArguments, _message: RsyslogMessage): ActionOutcome {
    const settings = this.settings;
    const text = args.strings[0] ?? '';
    let outcome: ActionOutcome = 'ok';
    if (settings.rebindInterval > 0 && this.transmissions++ >= settings.rebindInterval) {
      this.transmissions = 0;
      for (const target of this.targets) this.destroyTarget(target, true);
      this.context.runtime.log(LOG_WARNING, RS_RET.PARAM_ERROR, 'omfwd: dropped connections due to configured rebind interval');
    }
    if (this.poolResume() === 'suspended') {
      outcome = 'suspended';
    } else {
      this.countActiveTargets();
      const source = `${settings.protocol}:[${settings.targets[0]}]:${settings.ports[0]}`;
      if (settings.rateLimiter === null || settings.rateLimiter.admit(source)) {
        let delivered = false;
        for (let attempt = 0; !delivered && attempt < this.targets.length; attempt++) {
          const target = this.targets[this.actualTarget++ % this.targets.length];
          if (target.connected && this.processMessage(target, text) === 'ok') delivered = true;
        }
        if (!delivered) {
          this.context.runtime.log(
            LOG_INFO, RS_RET.SUSPENDED, `omfwd: [wrkr ${this.workerId}] found no working target server when trying to send messages (main loop)`,
          );
          outcome = 'suspended';
        } else {
          this.transmissions++;
        }
      }
    }
    if (this.countActiveTargets() === 0) outcome = 'suspended';
    if (outcome === 'suspended') {
      this.context.runtime.log(
        LOG_WARNING, RS_RET.SUSPENDED,
        `omfwd: [wrkr ${this.workerId}/${this.threadIdentifier}] no working target servers in pool available, suspending action`,
      );
    }
    return outcome;
  }

  tryResume(): ActionOutcome {
    const outcome = this.poolResume();
    const active = this.countActiveTargets();
    this.debug(`omfwd: [wrkr ${this.workerId}/${this.threadIdentifier}] tryResume was called by rsyslog core: active targets: ${active}, overall return state ${outcome === 'ok' ? 0 : RS_RET.SUSPENDED}`);
    return outcome;
  }

  pauseAfterAction(): number {
    const pause = this.pendingPause;
    this.pendingPause = 0;
    return pause;
  }

  close(): void {
    for (const target of this.targets) this.destroyTarget(target, true);
  }
}

class OmfwdInstance implements ActionModuleInstance {
  readonly moduleName = 'omfwd';
  readonly templates: TemplateRequest[];
  readonly description: string;

  private readonly sent = { bytes: 0 };
  private readonly statistics: StatsObject;

  constructor(private readonly settings: ForwardSettings, private readonly context: ModuleContext) {
    this.templates = [{ name: settings.templateName }];
    this.description = `${settings.protocol === 'udp' ? '@' : '@@'}${settings.targets[0]}:${settings.ports[0]}`;
    this.statistics = context.statistics.create(`${settings.protocol === 'tcp' ? 'TCP' : 'UDP'}-${settings.targets[0]}-${settings.ports[0]}`, { origin: 'omfwd' });
    this.statistics.addCounter({ name: 'bytes.sent', read: () => this.sent.bytes, reset: () => { this.sent.bytes = 0; } });
  }

  createWorker(): ActionWorker {
    return new OmfwdWorker(this.settings, this.context, this.sent);
  }

  teardown(): void {
    this.context.statistics.remove(this.statistics);
  }
}

function moduleTlsExtras(context: ModuleContext): StreamTlsExtras {
  const config = moduleConfig(context);
  return { ...emptyTlsExtras(), caFile: config.caFile, crlFile: config.crlFile, caExtraFiles: config.caExtraFiles, keyFile: config.keyFile, certFile: config.certFile };
}

function baseSettings(context: ModuleContext, protocol: Protocol): ForwardSettings {
  const legacy = legacyState(context);
  return {
    protocol, targets: [], ports: [], targetSrv: null, address: null, device: null, networkNamespace: null, framing: 'octet-stuffing',
    framingDelimiter: 0x0a, compressionMode: 'never', compressionLevel: 9, udpSendDelayMicroseconds: 0, udpSendBufferBytes: 0, freeBind: true,
    userTimeoutMs: 0, extendedConnectionCheck: true, sendToAll: false, poolResumeInterval: DEFAULT_POOL_RESUME_INTERVAL,
    templateName: defaultTemplateName(context), rateLimiter: null, rebindInterval: 0, keepAlive: defaultKeepAlive(), connectionErrorSkip: 0,
    resendLastOnReconnect: false, streamDriverMode: 0, streamDriverModeSet: legacy.streamDriverModeSet, streamDriver: legacy.streamDriver,
    authMode: legacy.streamDriverAuthMode, tls: moduleTlsExtras(context), resolvedTls: null,
  };
}

function applyLegacySelectorDefaults(settings: ForwardSettings, context: ModuleContext): void {
  const legacy = legacyState(context);
  settings.rebindInterval = settings.protocol === 'tcp' ? legacy.tcpRebindInterval : legacy.udpRebindInterval;
  settings.keepAlive = { ...legacy.keepAlive };
  settings.connectionErrorSkip = legacy.connectionErrorSkip;
  if (settings.protocol === 'tcp') {
    settings.resendLastOnReconnect = legacy.resendLastOnReconnect;
    settings.streamDriverMode = legacy.streamDriverMode;
    settings.tls.permittedPeers = [...legacy.permittedPeers];
    settings.tls.remoteSni = legacy.streamDriverRemoteSni;
    legacy.permittedPeers = [];
  }
}

const TLS_CAPABLE_DRIVERS = ['ossl', 'gtls', 'mbedtls'];

function effectiveDriver(settings: ForwardSettings, context: ModuleContext): string {
  return settings.streamDriver ?? context.settings.defaultNetstreamDriver ?? 'ptcp';
}

function isTlsCapable(driver: string): boolean {
  return TLS_CAPABLE_DRIVERS.includes(driver.toLowerCase());
}

function applySecureDefaults(settings: ForwardSettings, context: ModuleContext): boolean {
  if (settings.protocol !== 'tcp') return true;
  const driver = effectiveDriver(settings, context);
  if (isTlsCapable(driver) && settings.streamDriverMode === 0 && context.settings.compatDefaultsSecure === 'strict') {
    if (settings.streamDriverModeSet) {
      context.runtime.error(
        `omfwd: compatibility.defaults.secure="strict" rejects explicit streamdriver.mode="0" with TLS-capable stream driver "${driver}"; use streamdriver.mode="1" to enable TLS or select ptcp/plain TCP intentionally`,
        RS_RET.PARAM_ERROR,
      );
      return false;
    }
    settings.streamDriverMode = 1;
  }
  return true;
}

function resolveTransport(settings: ForwardSettings, context: ModuleContext): boolean {
  if (settings.protocol !== 'tcp') return false;
  const resolved = resolveStreamTls(
    { mode: settings.streamDriverMode, driver: settings.streamDriver, authMode: settings.authMode }, settings.tls, context, 'omfwd', 'client',
  );
  if (resolved === false) return true;
  settings.resolvedTls = resolved;
  return false;
}

function warnInsecureDefaults(settings: ForwardSettings, context: ModuleContext): void {
  if (context.settings.compatDefaultsSecure !== 'warn') return;
  const warn = (detail: string): void => context.warn(
    `backward-compatible insecure default in use: ${detail}; use global(compatibility.defaults.secure="strict") to enable the secure default`,
  );
  const faq = 'https://docs.rsyslog.com/doc/faq/tls_mode0_disables_tls.html';
  if (settings.protocol === 'udp') {
    warn(`omfwd action uses protocol="udp" (without TLS); see ${faq}`);
    return;
  }
  if (settings.streamDriverMode === 0) {
    const hints = settings.authMode !== null || isTlsCapable(effectiveDriver(settings, context));
    if (hints) warn(`omfwd has TLS-related settings but streamdriver.mode="0"; mode 0 uses plain TCP so TLS is not active (see ${faq})`);
    else warn(`omfwd action uses protocol="tcp" with streamdriver.mode="0" (plain TCP without TLS); see ${faq}`);
  } else if (settings.authMode !== null && settings.authMode.toLowerCase() === 'anon') {
    warn('omfwd uses streamdriver.authmode="anon"; server identity is not authenticated, so MITM is possible (see https://docs.rsyslog.com/doc/faq/tls_anon_auth_mitm.html)');
  }
}

function orderedSrvTargets(records: SrvRecord[], random: () => number): SrvRecord[] {
  const sorted = [...records].sort((left, right) => left.priority - right.priority);
  const ordered: SrvRecord[] = [];
  for (let start = 0; start < sorted.length;) {
    let end = start;
    while (end < sorted.length && sorted[end].priority === sorted[start].priority) end++;
    const group = sorted.slice(start, end);
    let totalWeight = group.reduce((sum, record) => sum + record.weight, 0);
    const used = new Array<boolean>(group.length).fill(false);
    let remaining = group.length;
    while (remaining > 0) {
      let selected = 0;
      if (totalWeight === 0) {
        const pick = Math.floor(random() * 0x7fffffff) % remaining;
        let seen = 0;
        for (let index = 0; index < group.length; index++) {
          if (used[index]) continue;
          if (seen === pick) {
            selected = index;
            break;
          }
          seen++;
        }
      } else {
        const pick = Math.floor(random() * 0x7fffffff) % totalWeight;
        let running = 0;
        for (let index = 0; index < group.length; index++) {
          if (used[index]) continue;
          running += group[index].weight;
          if (pick < running) {
            selected = index;
            break;
          }
        }
      }
      ordered.push(group[selected]);
      used[selected] = true;
      if (totalWeight > 0) totalWeight = group[selected].weight >= totalWeight ? 0 : totalWeight - group[selected].weight;
      remaining--;
    }
    start = end;
  }
  return ordered;
}

function resolveSrvTargets(settings: ForwardSettings, context: ModuleContext): boolean {
  const name = `_syslog._${settings.protocol}.${settings.targetSrv}`;
  const answer = context.host.network.resolveSrv(name);
  if ('error' in answer) {
    context.runtime.error(`omfwd: failed to resolve SRV records for '${name}': ${answer.error}`, RS_RET.PARAM_ERROR);
    return false;
  }
  const usable = answer.map((record) => ({ ...record, host: record.host.replace(/\.$/, '') }));
  if (usable.length === 0) {
    context.runtime.error(`omfwd: no usable SRV records found for '${name}'`, RS_RET.NOT_FOUND);
    return false;
  }
  const ordered = orderedSrvTargets(usable, () => context.host.random());
  settings.targets = ordered.map((record) => record.host);
  settings.ports = ordered.map((record) => String(record.port));
  return true;
}

function parseSelector(line: string, context: ModuleContext): SelectorParse {
  if (!line.startsWith('@')) return { status: 'unprocessed' };
  let rest = line.slice(1);
  let protocol: Protocol = 'udp';
  if (rest.startsWith('@')) {
    protocol = 'tcp';
    rest = rest.slice(1);
  }
  const settings = baseSettings(context, protocol);
  if (rest.startsWith('(')) {
    let index = 0;
    do {
      index++;
      const option = rest[index];
      if (option === 'z') {
        index++;
        if (index < rest.length && rest[index] >= '0' && rest[index] <= '9') {
          settings.compressionLevel = rest.charCodeAt(index) - 48;
          settings.compressionMode = 'single';
          index++;
        } else {
          context.runtime.error(`Invalid compression level '${rest[index] ?? ''}' specified in forwarding action - NOT turning on compression.`, -1);
        }
      } else if (option === 'o') {
        index++;
        settings.framing = 'octet-counting';
      } else {
        context.runtime.error(`Invalid option ${option ?? ''} in forwarding action - ignoring.`, -1);
        index++;
      }
      while (index < rest.length && rest[index] !== ')' && rest[index] !== ',') index++;
    } while (index < rest.length && rest[index] === ',');
    if (rest[index] === ')') index++;
    else context.runtime.error('Option block not terminated in forwarding action.', -1);
    rest = rest.slice(index);
  }
  let host: string;
  let remainder: string;
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    host = close < 0 ? rest.slice(1) : rest.slice(1, close);
    remainder = close < 0 ? '' : rest.slice(close + 1);
  } else {
    const stop = rest.search(/[;:#]/);
    host = stop < 0 ? rest : rest.slice(0, stop);
    remainder = stop < 0 ? '' : rest.slice(stop);
  }
  let port = '514';
  if (remainder.startsWith(':')) {
    port = /^:(\d*)/.exec(remainder)?.[1] ?? '';
    remainder = remainder.slice(1 + port.length);
  }
  remainder = remainder.slice(/^[^;#\s]*/.exec(remainder)?.[0].length ?? 0);
  settings.targets = [host];
  settings.ports = [port];
  applyLegacySelectorDefaults(settings, context);
  const template = parseSelectorTemplate(remainder, defaultTemplateName(context), context.runtime);
  if (template === null) return { status: 'error' };
  settings.templateName = template;
  if (!applySecureDefaults(settings, context)) return { status: 'error' };
  warnInsecureDefaults(settings, context);
  if (resolveTransport(settings, context)) return { status: 'error' };
  return { status: 'ok', instance: new OmfwdInstance(settings, context), rest: '' };
}

function newActionInstance(params: NvList, context: ModuleContext): ActionModuleInstance | null {
  const report = (message: string): void => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR);
  const values = getParams(params, ACTION_PARAMS, { report, uidOf: () => null, gidOf: () => null });
  if (values === null) return null;
  reportUnused(params, report);
  const fail = (message: string, code: number): null => {
    context.runtime.error(message, code);
    return null;
  };
  const protocolName = stringParam(values, 'protocol');
  let protocol: Protocol = 'udp';
  if (protocolName !== undefined) {
    if (protocolName.toLowerCase().startsWith('udp') && protocolName.length >= 3) protocol = 'udp';
    else if (protocolName.toLowerCase().startsWith('tcp') && protocolName.length >= 3) protocol = 'tcp';
    else return fail(`omfwd: invalid protocol "${protocolName}"`, RS_RET.INVLD_PROTOCOL);
  }
  const settings = baseSettings(context, protocol);
  const targetList = arrayParam(values, 'target');
  const portList = arrayParam(values, 'port');
  const targetSrv = stringParam(values, 'targetsrv');
  settings.address = stringParam(values, 'address') ?? null;
  settings.device = stringParam(values, 'device') ?? null;
  settings.networkNamespace = stringParam(values, 'networknamespace') ?? null;
  const framingName = stringParam(values, 'tcp_framing');
  if (framingName !== undefined) {
    if (framingName.toLowerCase().startsWith('traditional')) settings.framing = 'octet-stuffing';
    else if (framingName.toLowerCase().startsWith('octet-counted')) settings.framing = 'octet-counting';
    else return fail(`omfwd: invalid framing "${framingName}"`, RS_RET.CNF_INVLD_FRAMING);
  }
  settings.rebindInterval = numberParam(values, 'rebindinterval') ?? 0;
  const keepAlive = settings.keepAlive;
  keepAlive.enabled = (numberParam(values, 'keepalive') ?? 0) !== 0;
  keepAlive.probes = numberParam(values, 'keepalive.probes') ?? keepAlive.probes;
  keepAlive.intervalSeconds = numberParam(values, 'keepalive.interval') ?? keepAlive.intervalSeconds;
  keepAlive.timeSeconds = numberParam(values, 'keepalive.time') ?? keepAlive.timeSeconds;
  settings.userTimeoutMs = numberParam(values, 'tcp_user_timeout') ?? 0;
  settings.connectionErrorSkip = numberParam(values, 'conerrskip') ?? 0;
  const driverMode = numberParam(values, 'streamdrivermode') ?? numberParam(values, 'streamdriver.mode');
  if (driverMode !== undefined) {
    settings.streamDriverMode = driverMode;
    settings.streamDriverModeSet = true;
  }
  settings.streamDriver = stringParam(values, 'streamdriver') ?? stringParam(values, 'streamdriver.name') ?? settings.streamDriver;
  settings.authMode = stringParam(values, 'streamdriverauthmode') ?? stringParam(values, 'streamdriver.authmode') ?? settings.authMode;
  readTlsExtras(settings.tls, values);
  const zipLevel = numberParam(values, 'ziplevel');
  if (zipLevel !== undefined) {
    if (zipLevel >= 0 && zipLevel <= 10) {
      settings.compressionLevel = zipLevel;
      settings.compressionMode = 'single';
    } else {
      context.runtime.error(`Invalid ziplevel ${zipLevel} specified in forwarding action - NOT turning on compression.`, RS_RET.ERR);
    }
  }
  const delimiter = numberParam(values, 'tcp_framedelimiter');
  if (delimiter !== undefined) {
    if (delimiter > 255) return fail(`tcp_frameDelimiter must be below 255 but is ${delimiter}`, RS_RET.PARAM_ERROR);
    settings.framingDelimiter = delimiter;
  }
  settings.resendLastOnReconnect = (numberParam(values, 'resendlastmsgonreconnect') ?? 0) !== 0;
  settings.extendedConnectionCheck = (numberParam(values, 'extendedconnectioncheck') ?? 1) !== 0;
  const sendToAll = numberParam(values, 'udp.sendtoall');
  settings.udpSendDelayMicroseconds = numberParam(values, 'udp.senddelay') ?? 0;
  settings.udpSendBufferBytes = numberParam(values, 'udp.sendbuf') ?? 0;
  settings.templateName = stringParam(values, 'template') ?? settings.templateName;
  settings.freeBind = (numberParam(values, 'ipfreebind') ?? 2) !== 0;
  settings.poolResumeInterval = numberParam(values, 'pool.resumeinterval') ?? DEFAULT_POOL_RESUME_INTERVAL;
  const compressionMode = stringParam(values, 'compression.mode');
  if (compressionMode !== undefined) {
    const lowered = compressionMode.toLowerCase();
    if (lowered === 'none') settings.compressionMode = 'never';
    else if (lowered === 'single') settings.compressionMode = 'single';
    else if (lowered === 'stream:always') return fail('omfwd: compression.mode="stream:always" requires a streaming deflate driver, which this rsyslogd build cannot provide', RS_RET.PARAM_ERROR);
    else return fail(`omfwd: invalid value for 'compression.mode' parameter (given is '${compressionMode}')`, RS_RET.PARAM_ERROR);
  }
  const compressionDriver = stringParam(values, 'compression.driver');
  if (compressionDriver !== undefined) {
    const lowered = compressionDriver.toLowerCase();
    if (lowered === 'zstd') return fail('omfwd: compression.driver="zstd" requires rsyslog to be built with libzstd support', RS_RET.PARAM_ERROR);
    if (lowered !== 'zlib') return fail(`omfwd: invalid value for 'compression.driver' parameter (given is '${compressionDriver}')`, RS_RET.PARAM_ERROR);
  }
  const rateName = stringParam(values, 'ratelimit.name');
  let rateInterval = numberParam(values, 'ratelimit.interval') ?? -1;
  let rateBurst = numberParam(values, 'ratelimit.burst') ?? -1;
  if (rateName !== undefined) {
    if (rateInterval !== -1 || rateBurst !== -1) {
      context.runtime.error('omfwd: ratelimit.name is mutually exclusive with ratelimit.interval and ratelimit.burst - using ratelimit.name', RS_RET.INVALID_PARAMS);
    }
    rateInterval = 0;
    rateBurst = 0;
  } else {
    if (rateInterval === -1) rateInterval = 0;
    if (rateBurst === -1) rateBurst = 200;
  }
  if (targetSrv !== undefined && targetList !== undefined) return fail('omfwd: target and targetSrv are mutually exclusive', RS_RET.PARAM_ERROR);
  if (targetSrv === undefined && targetList === undefined) return fail('omfwd: either target or targetSrv must be specified', RS_RET.PARAM_ERROR);
  if (targetSrv !== undefined) {
    settings.targetSrv = targetSrv;
    if (portList !== undefined) context.warn('omfwd: targetSrv was set, ignoring explicit port list');
    if (protocol === 'tcp' && settings.streamDriverMode !== 0 && stringParam(values, 'streamdriverpermittedpeers') === undefined) {
      if (settings.authMode === null || settings.authMode.toLowerCase() === 'x509/name') {
        return fail(
          'omfwd: targetSrv with TLS requires streamdriverpermittedpeers when using streamdriverauthmode "x509/name" or the default auth mode (explicitly set permitted peers or use static target)',
          RS_RET.PARAM_ERROR,
        );
      }
    }
    if (!resolveSrvTargets(settings, context)) return null;
  } else {
    settings.targets = targetList ?? [];
    settings.ports = portList ?? [];
    if (protocol === 'udp' && settings.targets.length > 1) {
      context.warn(`you have defined ${settings.targets.length} targets. Multiple targets are ONLY supported in TCP mode ignoring all but the first target in UDP mode`);
    }
    if (settings.ports.length === 0) settings.ports = ['514'];
    if (settings.ports.length > settings.targets.length) {
      context.warn(`defined ${settings.ports.length} ports, but only ${settings.targets.length} targets - ignoring extra ports`);
    }
    if (settings.ports.length < settings.targets.length) {
      context.warn(`defined ${settings.ports.length} ports, but ${settings.targets.length} targets - using port ${settings.ports[0]} as default for the additional targets`);
    }
  }
  if (sendToAll !== undefined && protocol === 'tcp') context.runtime.error('omfwd: parameter udp.sendToAll cannot be used with tcp transport -- ignored', RS_RET.PARAM_ERROR);
  else settings.sendToAll = sendToAll === 1;
  if (settings.address !== null && protocol === 'tcp') context.runtime.error('omfwd: parameter "address" not supported for tcp -- ignored', RS_RET.PARAM_ERROR);
  const limiter = context.rateLimiter({ module: 'omfwd', interval: rateInterval, burst: rateBurst, configName: rateName ?? null });
  if (limiter === null) return null;
  settings.rateLimiter = limiter.limiter;
  if (!applySecureDefaults(settings, context)) return null;
  warnInsecureDefaults(settings, context);
  if (resolveTransport(settings, context)) return null;
  return new OmfwdInstance(settings, context);
}

function directives(): DirectiveRegistration[] {
  const set = (apply: (state: OmfwdLegacyState, value: number | string, context: ModuleContext) => void) =>
    (value: number | string, context: ModuleContext): void => apply(legacyState(context), value, context);
  return [
    {
      name: 'actionforwarddefaulttemplate', type: 'word',
      apply: set((state, value, context) => {
        if (moduleConfig(context).templateName !== null) {
          context.runtime.error('omfwd default template already set via module global parameter - can no longer be changed', RS_RET.ERR);
          return;
        }
        state.templateName = String(value);
      }),
    },
    { name: 'actionsendtcprebindinterval', type: 'int', apply: set((state, value) => { state.tcpRebindInterval = Number(value); }) },
    { name: 'actionsendudprebindinterval', type: 'int', apply: set((state, value) => { state.udpRebindInterval = Number(value); }) },
    { name: 'actionsendtcpkeepalive', type: 'binary', apply: set((state, value) => { state.keepAlive.enabled = value === 1; }) },
    { name: 'actionsendtcpkeepalive_probes', type: 'int', apply: set((state, value) => { state.keepAlive.probes = Number(value); }) },
    { name: 'actionsendtcpkeepalive_intvl', type: 'int', apply: set((state, value) => { state.keepAlive.intervalSeconds = Number(value); }) },
    { name: 'actionsendtcpkeepalive_time', type: 'int', apply: set((state, value) => { state.keepAlive.timeSeconds = Number(value); }) },
    { name: 'actionsendstreamdriver', type: 'word', apply: set((state, value) => { state.streamDriver = String(value); }) },
    { name: 'actionsendstreamdrivermode', type: 'int', apply: set((state, value) => { state.streamDriverMode = Number(value); state.streamDriverModeSet = true; }) },
    { name: 'actionsendstreamdriverauthmode', type: 'word', apply: set((state, value) => { state.streamDriverAuthMode = String(value); }) },
    { name: 'actionsendstreamdriverremotesni', type: 'word', apply: set((state, value) => { state.streamDriverRemoteSni = String(value); }) },
    { name: 'actionsendstreamdriverpermittedpeer', type: 'word', apply: set((state, value) => { state.permittedPeers.push(String(value)); }) },
    { name: 'actionsendresendlastmsgonreconnect', type: 'binary', apply: set((state, value) => { state.resendLastOnReconnect = value === 1; }) },
  ];
}

export const omfwd: OutputModule = {
  kind: 'output',
  name: 'omfwd',
  builtin: true,
  parseSelector,
  newActionInstance,
  directives,
  moduleParams: MODULE_PARAMS,
  setModuleConfig(params, context) {
    const values = getParams(params, [{ name: 'load', type: 'string' }, ...MODULE_PARAMS], {
      report: (message) => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR),
      uidOf: () => null,
      gidOf: () => null,
    });
    if (values === null) return false;
    const config = moduleConfig(context);
    const template = stringParam(values, 'template');
    if (template !== undefined) {
      config.templateName = template;
      if (legacyState(context).templateName !== null) {
        context.runtime.error('omfwd: warning: default template was already set via legacy directive - may lead to inconsistent results.', RS_RET.DUP_PARAM);
      }
    }
    const bufferSize = numberParam(values, 'iobuffer.maxsize');
    if (bufferSize !== undefined) {
      if (bufferSize > 16 * 1024) {
        context.runtime.log(LOG_WARNING, RS_RET.PARAM_ERROR, 'omfwd: module parameter "iobuffer.maxsize" specified larger than actual buffer size (16384 bytes) - ignored');
      } else if (bufferSize > 0) {
        config.maxSendBuffer = bufferSize;
      }
    }
    config.caFile = stringParam(values, 'streamdriver.cafile') ?? config.caFile;
    config.crlFile = stringParam(values, 'streamdriver.crlfile') ?? config.crlFile;
    config.caExtraFiles = stringParam(values, 'streamdriver.caextrafiles') ?? config.caExtraFiles;
    config.keyFile = stringParam(values, 'streamdriver.keyfile') ?? config.keyFile;
    config.certFile = stringParam(values, 'streamdriver.certfile') ?? config.certFile;
    return true;
  },
  reset(context) {
    Object.assign(legacyState(context), defaultLegacyState());
  },
};
