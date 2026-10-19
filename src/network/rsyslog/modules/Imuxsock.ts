import { formatTimestamp3164, parseTimestamp3164, parseTimestamp3339 } from '@/network/syslog/codec/SyslogTime';
import type { NvList } from '../config/Ast';
import { getParams, numberParam, reportUnused, stringParam, type ParamDescriptor } from '../config/Params';
import type { LocalSocketMessage } from '../engine/Host';
import { RS_RET } from '../engine/Log';
import type {
  DirectiveRegistration, InputContext, InputInstance, InputModule, InputSubmission, ModuleContext, ModuleRateLimiter,
} from '../engine/Modules';
import { sanitizeRawMessage } from '../MessageParser';

const UNSET = -1;
const DEFAULT_RATE_INTERVAL = 0;
const DEFAULT_RATE_BURST = 200;
const DEFAULT_RATE_SEVERITY = 1;
const MAX_DYNAMIC_RATELIMITERS = 4096;
const MAX_TAG_SIZE = 512;
const LOG_MAX_PRI = 191;
const SYSTEM_SOCKET = '/dev/log';
const SYSTEMD_SYSTEM_SOCKET = '/run/systemd/journal/syslog';
const RS_RET_ERR_CRE_AFUX = -2085;
const RS_RET_SOCKNAME_MISSING = -2092;
const LOG_INFO = 6;

const MODULE_PARAMS: readonly ParamDescriptor[] = [
  { name: 'syssock.use', type: 'binary' }, { name: 'syssock.name', type: 'word' }, { name: 'syssock.unlink', type: 'binary' },
  { name: 'syssock.ignoretimestamp', type: 'binary' }, { name: 'syssock.ignoreownmessages', type: 'binary' },
  { name: 'syssock.flowcontrol', type: 'binary' }, { name: 'syssock.usesystimestamp', type: 'binary' },
  { name: 'syssock.annotate', type: 'binary' }, { name: 'syssock.parsetrusted', type: 'binary' },
  { name: 'syssock.usespecialparser', type: 'binary' }, { name: 'syssock.parsehostname', type: 'binary' },
  { name: 'syssock.usepidfromsystem', type: 'binary' }, { name: 'syssock.ratelimit.interval', type: 'int' },
  { name: 'syssock.ratelimit.burst', type: 'int' }, { name: 'syssock.ratelimit.severity', type: 'int' },
  { name: 'syssock.ratelimit.name', type: 'string' },
];

const INPUT_PARAMS: readonly ParamDescriptor[] = [
  { name: 'socket', type: 'string' }, { name: 'unlink', type: 'binary' }, { name: 'createpath', type: 'binary' },
  { name: 'parsetrusted', type: 'binary' }, { name: 'ignoreownmessages', type: 'binary' }, { name: 'hostname', type: 'string' },
  { name: 'ignoretimestamp', type: 'binary' }, { name: 'flowcontrol', type: 'binary' }, { name: 'usesystimestamp', type: 'binary' },
  { name: 'annotate', type: 'binary' }, { name: 'usespecialparser', type: 'binary' }, { name: 'parsehostname', type: 'binary' },
  { name: 'usepidfromsystem', type: 'binary' }, { name: 'ruleset', type: 'string' }, { name: 'ratelimit.interval', type: 'int' },
  { name: 'ratelimit.burst', type: 'int' }, { name: 'ratelimit.severity', type: 'int' }, { name: 'ratelimit.name', type: 'string' },
];

interface SocketSettings {
  socketName: string;
  hostName: string | null;
  flowControl: boolean;
  ignoreTimestamp: boolean;
  writePid: boolean;
  useSystemTimestamp: boolean;
  createPath: boolean;
  rateInterval: number;
  rateBurst: number;
  rateSeverity: number;
  rateName: string | null;
  annotate: boolean;
  parseTrusted: boolean;
  discardOwnMessages: boolean;
  unlink: boolean;
  useSpecialParser: boolean;
  parseHostname: number;
  ruleset: string | null;
}

interface ImuxsockModuleConfig {
  configuredViaModule: boolean;
  systemSocketName: string | null;
  omitLocalLogging: boolean;
  ignoreTimestamp: boolean;
  useFlowControl: boolean;
  useSystemTimestamp: boolean;
  writePid: boolean;
  annotate: boolean;
  parseTrusted: boolean;
  parseHostname: number;
  useSpecialParser: boolean;
  discardOwnMessages: boolean;
  unlink: boolean;
  rateInterval: number;
  rateBurst: number;
  rateSeverity: number;
  rateName: string | null;
}

interface ImuxsockLegacyState {
  omitLocalLogging: boolean;
  systemSocketName: string | null;
  hostName: string | null;
  useFlowControl: boolean;
  useFlowControlSystem: boolean;
  ignoreTimestamp: boolean;
  ignoreTimestampSystem: boolean;
  useSystemTimestamp: boolean;
  useSystemTimestampSystem: boolean;
  writePid: boolean;
  writePidSystem: boolean;
  annotate: boolean;
  annotateSystem: boolean;
  parseTrusted: boolean;
  createPath: boolean;
  rateInterval: number;
  rateIntervalSystem: number;
  rateBurst: number;
  rateBurstSystem: number;
  rateSeverity: number;
  rateSeveritySystem: number;
  sockets: SocketSettings[];
}

function defaultModuleConfig(context: ModuleContext): ImuxsockModuleConfig {
  return {
    configuredViaModule: false, systemSocketName: null, omitLocalLogging: false, ignoreTimestamp: true, useFlowControl: false,
    useSystemTimestamp: true, writePid: false, annotate: false, parseTrusted: false, parseHostname: UNSET, useSpecialParser: true,
    discardOwnMessages: context.settings.processInternalMessages, unlink: true, rateInterval: UNSET, rateBurst: UNSET,
    rateSeverity: DEFAULT_RATE_SEVERITY, rateName: null,
  };
}

function defaultLegacyState(): ImuxsockLegacyState {
  return {
    omitLocalLogging: false, systemSocketName: null, hostName: null, useFlowControl: false, useFlowControlSystem: false,
    ignoreTimestamp: true, ignoreTimestampSystem: true, useSystemTimestamp: true, useSystemTimestampSystem: true, writePid: false,
    writePidSystem: false, annotate: false, annotateSystem: false, parseTrusted: false, createPath: false,
    rateInterval: DEFAULT_RATE_INTERVAL, rateIntervalSystem: DEFAULT_RATE_INTERVAL, rateBurst: DEFAULT_RATE_BURST,
    rateBurstSystem: DEFAULT_RATE_BURST, rateSeverity: DEFAULT_RATE_SEVERITY, rateSeveritySystem: DEFAULT_RATE_SEVERITY, sockets: [],
  };
}

function moduleConfig(context: ModuleContext): ImuxsockModuleConfig {
  return context.moduleState('imuxsock.config', () => defaultModuleConfig(context));
}

function legacyState(context: ModuleContext): ImuxsockLegacyState {
  return context.moduleState('imuxsock.legacy', defaultLegacyState);
}

function fixPid(tag: string, pid: number): string {
  const pidText = `[${pid}]:`;
  let index = tag.length;
  while (index >= 0 && tag[index] !== '[') index--;
  if (index < 0) index = tag.length - 1;
  if (index + pidText.length > MAX_TAG_SIZE) return tag;
  return tag.slice(0, Math.max(index, 0)) + pidText;
}

function escapeQuoted(text: string): string {
  return `"${text.replace(/["\\]/g, '\\$&')}"`;
}

class UnixSocketListener implements InputInstance {
  readonly description: string;
  private binding: { close(): void } | null = null;
  private readonly pidLimiters = new Map<number, ModuleRateLimiter>();
  private defaultLimiter: ModuleRateLimiter | null | undefined;

  constructor(private readonly settings: SocketSettings, private readonly context: InputContext, private readonly isSystem: boolean) {
    this.description = `imuxsock(${settings.socketName})`;
  }

  get socketName(): string {
    return this.settings.socketName;
  }

  check(): void {
    const ruleset = this.settings.ruleset;
    if (ruleset !== null && !this.context.rulesetExists(ruleset)) {
      this.context.runtime.error(`imuxsock: ruleset '${ruleset}' for socket ${this.settings.socketName} not found - using default ruleset instead`, RS_RET.ERR);
    }
  }

  private get usesCredentials(): boolean {
    const settings = this.settings;
    return settings.writePid || settings.rateInterval > 0 || settings.annotate || settings.discardOwnMessages || settings.useSystemTimestamp;
  }

  start(): boolean {
    const settings = this.settings;
    if (settings.socketName === '') return false;
    const binding = this.context.host.sockets.listen(
      settings.socketName,
      { unlink: settings.unlink, createPath: settings.createPath, credentials: this.usesCredentials },
      (message) => this.receive(message),
    );
    if ('errno' in binding) {
      if (binding.errno === 'EADDRINUSE' && !settings.unlink) {
        this.context.runtime.error(
          `cannot create '${settings.socketName}': socket path already exists and Unlink="off" prevents rsyslog from replacing it; remove the stale socket or set Unlink="on" if rsyslog should manage this socket`,
          RS_RET_ERR_CRE_AFUX, binding.errno,
        );
      } else {
        this.context.runtime.error(`cannot create '${settings.socketName}'`, RS_RET_ERR_CRE_AFUX, binding.errno);
      }
      return false;
    }
    if (binding.acquiredFromSupervisor) {
      this.context.runtime.log(LOG_INFO, RS_RET.NO_ERRCODE, `imuxsock: Acquired UNIX socket '${settings.socketName}' (fd 3) from systemd.\n`);
    }
    this.binding = binding;
    return true;
  }

  stop(): void {
    this.binding?.close();
    this.binding = null;
    this.pidLimiters.clear();
  }

  private limiterFor(message: LocalSocketMessage): ModuleRateLimiter | undefined {
    const settings = this.settings;
    if (this.defaultLimiter === undefined) {
      const created = this.context.rateLimiter({
        module: 'imuxsock', interval: settings.rateInterval, burst: settings.rateBurst, configName: settings.rateName,
        forInput: true, severity: settings.rateSeverity,
      });
      this.defaultLimiter = created === null ? null : created.limiter;
    }
    const fallback = this.defaultLimiter ?? undefined;
    const pid = message.pid;
    if (pid === null || settings.rateInterval <= 0) return fallback;
    const known = this.pidLimiters.get(pid);
    if (known !== undefined) return known;
    this.prunePidLimiters();
    this.enforcePidCap();
    const details = this.context.host.sockets.processDetails(pid);
    const name = details === null || details.cmdline === '' ? `pid: ${pid}` : `pid: ${pid}, name: ${details.cmdline.split('\u0000')[0]}`;
    const created = this.context.rateLimiter({
      module: 'imuxsock', dynamicName: name, interval: settings.rateInterval, burst: settings.rateBurst, configName: null,
      forInput: true, severity: settings.rateSeverity,
    });
    if (created === null || created.limiter === null) return fallback;
    this.pidLimiters.set(pid, created.limiter);
    return created.limiter;
  }

  private prunePidLimiters(): void {
    for (const pid of [...this.pidLimiters.keys()]) {
      if (!this.context.host.sockets.isAlive(pid)) this.pidLimiters.delete(pid);
    }
  }

  private enforcePidCap(): void {
    if (this.pidLimiters.size < MAX_DYNAMIC_RATELIMITERS) return;
    const first = this.pidLimiters.keys().next();
    if (first.done !== true) this.pidLimiters.delete(first.value);
  }

  private trustedText(message: LocalSocketMessage): string {
    const details = message.pid === null ? null : this.context.host.sockets.processDetails(message.pid);
    let suffix = ` @[_PID=${message.pid} _UID=${message.uid ?? 0} _GID=${message.gid ?? 0}`;
    if (details !== null) {
      if (details.comm !== '') suffix += ` _COMM=${details.comm}`;
      if (details.exe !== '') suffix += ` _EXE=${details.exe}`;
      if (details.cmdline !== '') suffix += ` _CMDLINE=${escapeQuoted(details.cmdline.replace(/\u0000/g, ' ').replace(/[\x00-\x1f\x7f]/g, ' ').trimEnd())}`;
    }
    return `${message.text}${suffix}]`;
  }

  private trustedJson(message: LocalSocketMessage): { [key: string]: string | number } {
    const details = message.pid === null ? null : this.context.host.sockets.processDetails(message.pid);
    const json: { [key: string]: string | number } = { pid: message.pid ?? 0, uid: message.uid ?? 0, gid: message.gid ?? 0 };
    if (details !== null) {
      if (details.comm !== '') json.appname = details.comm;
      if (details.exe !== '') json.exe = details.exe;
      if (details.cmdline !== '') json.cmd = details.cmdline.replace(/\u0000/g, ' ').replace(/[\x00-\x1f\x7f]/g, ' ').trimEnd();
    }
    return json;
  }

  private receive(message: LocalSocketMessage): void {
    const settings = this.settings;
    const credentials = this.usesCredentials && message.pid !== null;
    if (settings.discardOwnMessages && credentials && message.pid === this.context.host.sockets.ownPid()) return;
    const receivedAtMs = settings.useSystemTimestamp && credentials && message.receivedAtMs !== null ? message.receivedAtMs : null;
    let raw = message.text;
    let cee: { [key: string]: string | number } | undefined;
    if (credentials && settings.annotate) {
      if (settings.parseTrusted) cee = this.trustedJson(message);
      else raw = this.trustedText(message);
    }
    const limiter = this.limiterFor(message);
    const submission = settings.useSpecialParser
      ? this.specialSubmission(raw, receivedAtMs, credentials ? message.pid : null)
      : { ...this.baseSubmission(raw, receivedAtMs), ignoreDate: settings.ignoreTimestamp, parseHostname: settings.parseHostname !== 0 };
    this.context.submitter.submit({ ...submission, limiter, cee });
  }

  private effectiveRuleset(): string | null {
    const ruleset = this.settings.ruleset;
    return ruleset !== null && this.context.rulesetExists(ruleset) ? ruleset : null;
  }

  private specialSubmission(text: string, receivedAtMs: number | null, pid: number | null): InputSubmission {
    const settings = this.settings;
    let raw = sanitizeRawMessage(text, this.context.settings.parser);
    let offset = 1;
    let priority = 0;
    let digits = 0;
    while (offset < raw.length && raw[offset] >= '0' && raw[offset] <= '9') {
      priority = priority * 10 + raw.charCodeAt(offset) - 48;
      offset++;
      digits++;
    }
    const valid = raw.length >= 3 && raw[0] === '<' && digits >= 1 && digits <= 3 && offset < raw.length && raw[offset] === '>' && priority <= LOG_MAX_PRI;
    let cursor = offset + 1;
    const clock = this.context.clock;
    const now = receivedAtMs === null ? clock.now() : clock.at(receivedAtMs);
    let timestamp = now;
    const found = parseTimestamp3339(raw.slice(cursor)) ?? parseTimestamp3164(raw.slice(cursor), now, { parseTimeZone: false });
    if (receivedAtMs === null) {
      if (found !== null) {
        cursor += found.consumed;
        if (!settings.ignoreTimestamp) timestamp = found.time;
      }
    } else if (found !== null) {
      raw = `${raw.slice(0, cursor)}${formatTimestamp3164(now)} ${raw.slice(cursor + 16)}`;
      cursor += 16;
    }
    let tagEnd = cursor;
    while (tagEnd < raw.length && raw[tagEnd] !== ' ' && tagEnd - cursor < MAX_TAG_SIZE - 1) tagEnd++;
    let tag = raw.slice(cursor, tagEnd);
    if (settings.writePid && pid !== null) tag = fixPid(tag, pid);
    return {
      ...this.baseSubmission(raw, receivedAtMs),
      preparsed: {
        priority: valid ? priority : null, offsetAfterPriority: valid ? offset + 1 : 0, tag, msg: raw.slice(tagEnd), timestamp,
        parseHostname: settings.parseHostname !== 0,
      },
    };
  }

  private baseSubmission(raw: string, receivedAtMs: number | null): InputSubmission {
    return {
      raw, inputName: 'imuxsock', fromHost: this.settings.hostName, fromHostIp: '127.0.0.1', fromHostPort: null, ruleset: this.effectiveRuleset(),
      localOrigin: true, receivedAtMs: receivedAtMs ?? undefined,
    };
  }
}

function systemSocketName(context: ModuleContext, configured: string | null): string {
  if (configured !== null) return configured;
  const sockets = context.host.sockets;
  if (sockets.systemdBooted() && sockets.isSocket(SYSTEMD_SYSTEM_SOCKET)) return SYSTEMD_SYSTEM_SOCKET;
  return SYSTEM_SOCKET;
}

function instanceFromParams(params: NvList, context: InputContext): UnixSocketListener | null {
  const report = (message: string): void => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR);
  const values = getParams(params, INPUT_PARAMS, { report, uidOf: () => null, gidOf: () => null });
  if (values === null) {
    context.runtime.error('imuxsock: required parameter are missing\n', RS_RET.MISSING_CNFPARAMS);
    return null;
  }
  reportUnused(params, report);
  const socket = stringParam(values, 'socket');
  if (socket === undefined) {
    context.runtime.error(
      'imuxsock: input(type="imuxsock") defines an additional UNIX socket; set Socket="..." for that input, or configure the system log socket with module-level SysSock.* parameters',
      RS_RET.MISSING_CNFPARAMS,
    );
    return null;
  }
  const flag = (key: string, fallback: boolean): boolean => {
    const value = numberParam(values, key);
    return value === undefined ? fallback : value !== 0;
  };
  const rateName = stringParam(values, 'ratelimit.name') ?? null;
  let rateInterval = numberParam(values, 'ratelimit.interval') ?? UNSET;
  let rateBurst = numberParam(values, 'ratelimit.burst') ?? UNSET;
  if (rateName !== null) {
    if (rateInterval !== UNSET || rateBurst !== UNSET) {
      context.runtime.error('imuxsock: ratelimit.name is mutually exclusive with ratelimit.interval and ratelimit.burst - using ratelimit.name', RS_RET.INVALID_PARAMS);
    }
  } else {
    if (rateInterval === UNSET) rateInterval = DEFAULT_RATE_INTERVAL;
    if (rateBurst === UNSET) rateBurst = DEFAULT_RATE_BURST;
  }
  const settings: SocketSettings = {
    socketName: socket, hostName: stringParam(values, 'hostname') ?? null, flowControl: flag('flowcontrol', false),
    ignoreTimestamp: flag('ignoretimestamp', true), writePid: flag('usepidfromsystem', false), useSystemTimestamp: flag('usesystimestamp', true),
    createPath: flag('createpath', false), rateInterval, rateBurst, rateSeverity: numberParam(values, 'ratelimit.severity') ?? DEFAULT_RATE_SEVERITY,
    rateName, annotate: flag('annotate', false), parseTrusted: flag('parsetrusted', false), discardOwnMessages: flag('ignoreownmessages', true),
    unlink: flag('unlink', true), useSpecialParser: flag('usespecialparser', true), parseHostname: numberParam(values, 'parsehostname') ?? UNSET,
    ruleset: stringParam(values, 'ruleset') ?? null,
  };
  if (settings.createPath && !settings.unlink) {
    context.runtime.error(
      `imuxsock: CreatePath="on" cannot be combined with Unlink="off" for socket '${settings.socketName}'; use Unlink="on" when rsyslog creates/manages the socket path`,
      RS_RET.PARAM_ERROR,
    );
    return null;
  }
  if (settings.parseHostname === UNSET) settings.parseHostname = settings.socketName.startsWith(':') ? 1 : 0;
  return new UnixSocketListener(settings, context, false);
}

function directives(): DirectiveRegistration[] {
  const legacy = (apply: (state: ImuxsockLegacyState, value: number | string) => void, name: string, gated: boolean) =>
    (value: number | string, context: InputContext): void => {
      if (gated && moduleConfig(context).configuredViaModule) {
        context.runtime.error(`$${name} not permitted after module(...) parameters were given`, RS_RET.ERR);
        return;
      }
      apply(legacyState(context), value);
    };
  const flag = (name: string, apply: (state: ImuxsockLegacyState, on: boolean) => void, gated = false): DirectiveRegistration => ({
    name, type: 'binary', apply: legacy((state, value) => apply(state, value === 1), name, gated),
  });
  const integer = (name: string, apply: (state: ImuxsockLegacyState, value: number) => void, gated = false): DirectiveRegistration => ({
    name, type: 'int', apply: legacy((state, value) => apply(state, Number(value)), name, gated),
  });
  return [
    flag('omitlocallogging', (state, on) => { state.omitLocalLogging = on; }, true),
    { name: 'systemlogsocketname', type: 'word', apply: legacy((state, value) => { state.systemSocketName = String(value); }, 'systemlogsocketname', true) },
    flag('systemlogsocketignoremsgtimestamp', (state, on) => { state.ignoreTimestampSystem = on; }, true),
    flag('systemlogsocketflowcontrol', (state, on) => { state.useFlowControlSystem = on; }, true),
    flag('systemlogusesystimestamp', (state, on) => { state.useSystemTimestampSystem = on; }, true),
    flag('systemlogsocketannotate', (state, on) => { state.annotateSystem = on; }, true),
    flag('systemlogparsetrusted', (state, on) => { state.parseTrusted = on; }, true),
    flag('systemlogusepidfromsystem', (state, on) => { state.writePidSystem = on; }, true),
    integer('systemlogratelimitinterval', (state, value) => { state.rateIntervalSystem = value; }, true),
    integer('systemlogratelimitburst', (state, value) => { state.rateBurstSystem = value; }, true),
    integer('systemlogratelimitseverity', (state, value) => { state.rateSeveritySystem = value; }, true),
    flag('inputunixlistensocketignoremsgtimestamp', (state, on) => { state.ignoreTimestamp = on; }),
    { name: 'inputunixlistensockethostname', type: 'word', apply: (value, context) => { legacyState(context).hostName = String(value); } },
    flag('inputunixlistensocketflowcontrol', (state, on) => { state.useFlowControl = on; }),
    flag('inputunixlistensocketannotate', (state, on) => { state.annotate = on; }),
    flag('inputunixlistensocketcreatepath', (state, on) => { state.createPath = on; }),
    flag('inputunixlistensocketusesystimestamp', (state, on) => { state.useSystemTimestamp = on; }),
    flag('inputunixlistensocketusepidfromsystem', (state, on) => { state.writePid = on; }),
    integer('imuxsockratelimitinterval', (state, value) => { state.rateInterval = value; }),
    integer('imuxsockratelimitburst', (state, value) => { state.rateBurst = value; }),
    integer('imuxsockratelimitseverity', (state, value) => { state.rateSeverity = value; }),
    {
      name: 'addunixlistensocket', type: 'word',
      apply: (value, context) => {
        const name = String(value);
        if (name === '') {
          context.runtime.error('imuxsock: socket name must be specified, but is not - listener not created\n', RS_RET_SOCKNAME_MISSING);
          return;
        }
        const state = legacyState(context);
        const settings: SocketSettings = {
          socketName: name, hostName: state.hostName, flowControl: state.useFlowControl, ignoreTimestamp: state.ignoreTimestamp, writePid: state.writePid,
          useSystemTimestamp: state.useSystemTimestamp, createPath: state.createPath, rateInterval: state.rateInterval, rateBurst: state.rateBurst,
          rateSeverity: state.rateSeverity, rateName: null, annotate: state.annotate, parseTrusted: state.parseTrusted, discardOwnMessages: true,
          unlink: true, useSpecialParser: true, parseHostname: name.startsWith(':') ? 1 : 0, ruleset: null,
        };
        state.hostName = null;
        context.registerInput('imuxsock', new UnixSocketListener(settings, context, false));
      },
    },
  ];
}

function systemSettings(context: ModuleContext): SocketSettings | null {
  const config = moduleConfig(context);
  const legacy = legacyState(context);
  const viaModule = config.configuredViaModule;
  if (viaModule ? config.omitLocalLogging : legacy.omitLocalLogging) return null;
  const rateName = viaModule ? config.rateName : null;
  let rateInterval = viaModule ? config.rateInterval : legacy.rateIntervalSystem;
  let rateBurst = viaModule ? config.rateBurst : legacy.rateBurstSystem;
  if (viaModule && rateName === null) {
    if (rateInterval === UNSET) rateInterval = DEFAULT_RATE_INTERVAL;
    if (rateBurst === UNSET) rateBurst = DEFAULT_RATE_BURST;
  }
  return {
    socketName: systemSocketName(context, viaModule ? config.systemSocketName : legacy.systemSocketName), hostName: null,
    flowControl: viaModule ? config.useFlowControl : legacy.useFlowControlSystem,
    ignoreTimestamp: viaModule ? config.ignoreTimestamp : legacy.ignoreTimestampSystem,
    writePid: viaModule ? config.writePid : legacy.writePidSystem,
    useSystemTimestamp: viaModule ? config.useSystemTimestamp : legacy.useSystemTimestampSystem, createPath: false,
    rateInterval, rateBurst, rateSeverity: viaModule ? config.rateSeverity : legacy.rateSeveritySystem, rateName,
    annotate: viaModule ? config.annotate : legacy.annotateSystem, parseTrusted: viaModule ? config.parseTrusted : legacy.parseTrusted,
    discardOwnMessages: viaModule ? config.discardOwnMessages : context.settings.processInternalMessages,
    unlink: viaModule ? config.unlink : true, useSpecialParser: viaModule ? config.useSpecialParser : true,
    parseHostname: viaModule ? (config.parseHostname === UNSET ? 1 : config.parseHostname) : 1, ruleset: null,
  };
}

export const imuxsock: InputModule = {
  kind: 'input',
  name: 'imuxsock',
  builtin: false,
  newInstances(params, context) {
    const instance = instanceFromParams(params, context);
    return instance === null ? null : [instance];
  },
  directives,
  setModuleConfig(params, context) {
    const report = (message: string): void => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR);
    const values = getParams(params, [{ name: 'load', type: 'string' }, ...MODULE_PARAMS], { report, uidOf: () => null, gidOf: () => null });
    if (values === null) {
      context.runtime.error('error processing module config parameters [module(...)]', RS_RET.MISSING_CNFPARAMS);
      return false;
    }
    const config = moduleConfig(context);
    const flag = (key: string): boolean | undefined => {
      const value = numberParam(values, key);
      return value === undefined ? undefined : value !== 0;
    };
    const use = flag('syssock.use');
    if (use !== undefined) config.omitLocalLogging = !use;
    config.systemSocketName = stringParam(values, 'syssock.name') ?? config.systemSocketName;
    config.ignoreTimestamp = flag('syssock.ignoretimestamp') ?? config.ignoreTimestamp;
    config.discardOwnMessages = flag('syssock.ignoreownmessages') ?? config.discardOwnMessages;
    config.unlink = flag('syssock.unlink') ?? config.unlink;
    config.useFlowControl = flag('syssock.flowcontrol') ?? config.useFlowControl;
    config.useSystemTimestamp = flag('syssock.usesystimestamp') ?? config.useSystemTimestamp;
    config.annotate = flag('syssock.annotate') ?? config.annotate;
    config.parseTrusted = flag('syssock.parsetrusted') ?? config.parseTrusted;
    const parseHost = flag('syssock.parsehostname');
    if (parseHost !== undefined) config.parseHostname = parseHost ? 1 : 0;
    config.useSpecialParser = flag('syssock.usespecialparser') ?? config.useSpecialParser;
    config.writePid = flag('syssock.usepidfromsystem') ?? config.writePid;
    config.rateInterval = numberParam(values, 'syssock.ratelimit.interval') ?? config.rateInterval;
    config.rateBurst = numberParam(values, 'syssock.ratelimit.burst') ?? config.rateBurst;
    config.rateSeverity = numberParam(values, 'syssock.ratelimit.severity') ?? config.rateSeverity;
    config.rateName = stringParam(values, 'syssock.ratelimit.name') ?? config.rateName;
    if (config.rateName !== null && (config.rateInterval !== UNSET || config.rateBurst !== UNSET)) {
      context.runtime.error(
        'imuxsock: syssock.ratelimit.name is mutually exclusive with syssock.ratelimit.interval and syssock.ratelimit.burst - using syssock.ratelimit.name',
        RS_RET.INVALID_PARAMS,
      );
    }
    config.configuredViaModule = true;
    for (const entry of params.entries) entry.used = true;
    return true;
  },
  implicitInstances(context) {
    const settings = systemSettings(context);
    return settings === null ? [] : [new UnixSocketListener(settings, context, true)];
  },
  reset(context) {
    Object.assign(legacyState(context), defaultLegacyState());
  },
};
