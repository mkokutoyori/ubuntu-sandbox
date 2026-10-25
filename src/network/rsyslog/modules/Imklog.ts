import { getParams, numberParam, stringParam, type ParamDescriptor } from '../config/Params';
import { RS_RET } from '../engine/Log';
import type { DirectiveRegistration, InputContext, InputInstance, InputModule, ModuleContext, ModuleRateLimiter } from '../engine/Modules';

const KLOG_PATH = '/proc/kmsg';
const LOG_MAX_PRI = 191;
const LOG_KERN = 0;
const LOG_SYSLOG = 5;
const LOG_INFO = 6;
const LOG_ERR = 3;
const LOG_WARNING = 4;

const MODULE_PARAMS: readonly ParamDescriptor[] = [
  { name: 'ruleset', type: 'string' }, { name: 'logpath', type: 'word' }, { name: 'permitnonkernelfacility', type: 'binary' },
  { name: 'consoleloglevel', type: 'int' }, { name: 'parsekerneltimestamp', type: 'binary' }, { name: 'keepkerneltimestamp', type: 'binary' },
  { name: 'internalmsgfacility', type: 'facility' }, { name: 'ratelimitinterval', type: 'int' }, { name: 'ratelimitburst', type: 'int' },
  { name: 'ratelimit.name', type: 'string' },
];

interface ImklogConfig {
  configuredViaModule: boolean;
  path: string | null;
  permitNonKernel: boolean;
  parseKernelStamp: boolean;
  keepKernelStamp: boolean;
  consoleLogLevel: number;
  internalMessageFacility: number;
  rateInterval: number;
  rateBurst: number;
  rateName: string | null;
  ruleset: string | null;
}

function defaultConfig(): ImklogConfig {
  return {
    configuredViaModule: false, path: null, permitNonKernel: false, parseKernelStamp: false, keepKernelStamp: false, consoleLogLevel: -1,
    internalMessageFacility: LOG_SYSLOG, rateInterval: -1, rateBurst: -1, rateName: null, ruleset: null,
  };
}

function config(context: ModuleContext): ImklogConfig {
  return context.moduleState('imklog.config', defaultConfig);
}

function parsePriority(text: string): { priority: number; rest: string } | null {
  if (text[0] !== '<' || !(text[1] >= '0' && text[1] <= '9')) return null;
  let index = 1;
  let value = 0;
  while (text[index] >= '0' && text[index] <= '9' && value <= LOG_MAX_PRI) {
    value = value * 10 + text.charCodeAt(index) - 48;
    index++;
  }
  if (text[index] !== '>' || value > LOG_MAX_PRI) return null;
  return { priority: value, rest: text.slice(index + 1) };
}

class KernelLogReader implements InputInstance {
  readonly description = 'imklog';
  private handle: { close(): void } | null = null;
  private pending = '';
  private limiter: ModuleRateLimiter | null | undefined;

  constructor(private readonly context: InputContext, private readonly settings: ImklogConfig) {}

  private get path(): string {
    return this.settings.path ?? KLOG_PATH;
  }

  check(): void {
    const ruleset = this.settings.ruleset;
    if (ruleset !== null && !this.context.rulesetExists(ruleset)) {
      this.context.runtime.error(`imklog: ruleset '${ruleset}' not found - using default ruleset instead`, RS_RET.NO_ERRCODE);
    }
  }

  private internalMessage(severity: number, text: string): void {
    this.context.runtime.internal(severity, RS_RET.NO_ERRCODE, text, false, LOG_KERN);
  }

  private ensureLimiter(): void {
    if (this.limiter !== undefined) return;
    const settings = this.settings;
    const created = this.context.rateLimiter({
      module: 'imklog', interval: settings.rateInterval, burst: settings.rateBurst, configName: settings.rateName, forInput: true,
    });
    this.limiter = created === null ? null : created.limiter;
  }

  start(): boolean {
    if (this.settings.rateName !== null) {
      this.ensureLimiter();
      if (this.limiter === null) return false;
    }
    const log = this.context.host.kernelLog;
    if (log === undefined) {
      this.internalMessage(LOG_ERR, `imklog: cannot open kernel log (${this.path}): No such file or directory.`);
      return false;
    }
    const opened = log.open(this.path, (chunk) => this.read(chunk));
    if ('errno' in opened) {
      this.internalMessage(LOG_ERR, `imklog: cannot open kernel log (${this.path}): ${describe(opened.errno)}.`);
      return false;
    }
    if (this.settings.consoleLogLevel !== -1) {
      const failure = log.setConsoleLogLevel(this.settings.consoleLogLevel);
      if (failure !== null) {
        this.internalMessage(LOG_WARNING, `imklog: cannot set console log level: ${describe(failure)}`);
        this.settings.consoleLogLevel = -1;
      }
    }
    this.handle = opened;
    return true;
  }

  stop(): void {
    this.handle?.close();
    this.handle = null;
    if (this.settings.consoleLogLevel !== -1) this.context.host.kernelLog?.restoreConsoleLogLevel();
  }

  private read(chunk: string): void {
    const maxLine = this.context.settings.parser.maxLine;
    this.pending += chunk;
    let newline = this.pending.indexOf('\n');
    while (newline >= 0) {
      this.submitLine(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf('\n');
    }
    if (this.pending.length >= maxLine - 1) {
      this.submitLine(this.pending);
      this.pending = '';
    }
  }

  private submitLine(line: string): void {
    const settings = this.settings;
    let text = line;
    let timestampMs: number | null = null;
    const endPriority = text.indexOf('>');
    if (endPriority >= 1 && endPriority <= 4 && text[endPriority + 1] === '[') {
      const stamp = /^\[\s*(\d+)\.(\d*)\]/.exec(text.slice(endPriority + 1));
      if (stamp !== null) {
        if (!settings.keepKernelStamp) text = text.slice(0, endPriority + 1) + text.slice(endPriority + 1 + stamp[0].length);
        if (settings.parseKernelStamp) {
          const offsetMs = this.context.host.clock.wallMs() - this.context.host.clock.monotonicMs();
          timestampMs = Math.floor(Number(stamp[1]) * 1000 + Number(`0.${stamp[2] === '' ? '0' : stamp[2]}`) * 1000) + offsetMs;
        }
      }
    }
    let priority = LOG_INFO;
    let body = text;
    let prioritySet = false;
    const second = text[3] === '<' ? 3 : text[3] === ' ' && text[4] === '<' ? 4 : -1;
    if (second >= 0) {
      const inner = parsePriority(text.slice(second));
      if (inner !== null && inner.priority >= 8 && inner.priority <= LOG_MAX_PRI) {
        priority = inner.priority;
        body = inner.rest;
        prioritySet = true;
      }
    }
    if (!prioritySet) {
      const parsed = parsePriority(text);
      if (parsed !== null) {
        priority = parsed.priority;
        body = parsed.rest;
      }
    }
    if (!settings.permitNonKernel && (priority >> 3) !== LOG_KERN) return;
    this.ensureLimiter();
    const ruleset = settings.ruleset !== null && this.context.rulesetExists(settings.ruleset) ? settings.ruleset : null;
    this.context.submitter.submit({
      raw: body, inputName: 'imklog', fromHost: null, fromHostIp: '127.0.0.1', fromHostPort: null, ruleset, localOrigin: true, flowControl: 'light',
      receivedAtMs: timestampMs ?? undefined, limiter: this.limiter ?? undefined,
      preparsed: { priority, offsetAfterPriority: 0, tag: 'kernel:', msg: body, timestamp: null, parseHostname: false },
    });
  }
}

function describe(errno: string): string {
  const texts: Record<string, string> = { ENOENT: 'No such file or directory', EACCES: 'Permission denied', EPERM: 'Operation not permitted' };
  return texts[errno] ?? errno;
}

function directives(): DirectiveRegistration[] {
  const gated = (name: string, type: DirectiveRegistration['type'], apply: (state: ImklogConfig, value: number | string) => void): DirectiveRegistration => ({
    name, type,
    apply: (value, context) => {
      if (config(context).configuredViaModule) context.runtime.error(`$${name} not permitted after module(...) parameters were given`, RS_RET.ERR);
      else apply(config(context), value);
    },
  });
  const goneAway = (name: string): DirectiveRegistration => ({
    name, type: 'goneaway', apply: () => undefined,
  });
  return [
    goneAway('klogLocalipif'.toLowerCase()), goneAway('debugprintkernelsymbols'), goneAway('klogsymbollookup'), goneAway('klogsymbolstwice'),
    goneAway('klogusesyscallinterface'),
    gated('klogpath', 'word', (state, value) => { state.path = String(value); }),
    gated('klogpermitnonkernelfacility', 'binary', (state, value) => { state.permitNonKernel = value === 1; }),
    gated('klogconsoleloglevel', 'int', (state, value) => { state.consoleLogLevel = Number(value); }),
    gated('kloginternalmsgfacility', 'facility', (state, value) => { state.internalMessageFacility = Number(value); }),
    gated('klogparsekerneltimestamp', 'binary', (state, value) => { state.parseKernelStamp = value === 1; }),
    gated('klogkeepkerneltimestamp', 'binary', (state, value) => { state.keepKernelStamp = value === 1; }),
  ];
}

export const imklog: InputModule = {
  kind: 'input',
  name: 'imklog',
  builtin: false,
  newInstances: () => [],
  directives,
  setModuleConfig(params, context) {
    const report = (message: string): void => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR);
    const values = getParams(params, [{ name: 'load', type: 'string' }, ...MODULE_PARAMS], { report, uidOf: () => null, gidOf: () => null });
    if (values === null) {
      context.runtime.error('error processing module config parameters [module(...)]', RS_RET.MISSING_CNFPARAMS);
      return false;
    }
    const settings = config(context);
    const flag = (key: string, fallback: boolean): boolean => {
      const value = numberParam(values, key);
      return value === undefined ? fallback : value !== 0;
    };
    settings.path = stringParam(values, 'logpath') ?? settings.path;
    settings.permitNonKernel = flag('permitnonkernelfacility', settings.permitNonKernel);
    settings.parseKernelStamp = flag('parsekerneltimestamp', settings.parseKernelStamp);
    settings.keepKernelStamp = flag('keepkerneltimestamp', settings.keepKernelStamp);
    settings.consoleLogLevel = numberParam(values, 'consoleloglevel') ?? settings.consoleLogLevel;
    settings.internalMessageFacility = numberParam(values, 'internalmsgfacility') ?? settings.internalMessageFacility;
    settings.rateBurst = numberParam(values, 'ratelimitburst') ?? settings.rateBurst;
    settings.rateInterval = numberParam(values, 'ratelimitinterval') ?? settings.rateInterval;
    settings.rateName = stringParam(values, 'ratelimit.name') ?? settings.rateName;
    settings.ruleset = stringParam(values, 'ruleset') ?? settings.ruleset;
    if (settings.rateName !== null) {
      if (settings.rateInterval !== -1 || settings.rateBurst !== -1) {
        context.runtime.error('imklog: ratelimit.name is mutually exclusive with ratelimitinterval and ratelimitburst - using ratelimit.name', RS_RET.INVALID_PARAMS);
      }
    } else {
      if (settings.rateInterval === -1) settings.rateInterval = 0;
      if (settings.rateBurst === -1) settings.rateBurst = 10000;
    }
    settings.configuredViaModule = true;
    return true;
  },
  implicitInstances(context) {
    const settings = config(context);
    if (!settings.configuredViaModule) {
      if (settings.rateInterval === -1) settings.rateInterval = 0;
      if (settings.rateBurst === -1) settings.rateBurst = 10000;
    }
    return [new KernelLogReader(context, settings)];
  },
  reset(context) {
    const settings = config(context);
    Object.assign(settings, { path: null, permitNonKernel: false, parseKernelStamp: false, keepKernelStamp: false, internalMessageFacility: LOG_SYSLOG });
  },
};
