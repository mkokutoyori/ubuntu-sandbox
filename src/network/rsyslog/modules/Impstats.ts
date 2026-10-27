import { arrayParam, getParams, numberParam, stringParam, type ParamDescriptor } from '../config/Params';
import { ctime } from '../engine/ActionRuntime';
import type { FileHandle } from '../engine/Host';
import { RS_RET } from '../engine/Log';
import type { DirectiveRegistration, InputContext, InputInstance, InputModule, ModuleContext } from '../engine/Modules';
import type { StatisticsFormat, StatsObject } from '../engine/Statistics';
import { PUSH_PARAMS, StatisticsPusher, defaultPushConfig, validatePushTls, type PushConfig } from './ImpstatsPush';

const DEFAULT_STATS_PERIOD = 5 * 60;
const DEFAULT_FACILITY = 5;
const DEFAULT_SEVERITY = 6;
const STATS_FILE_MODE = 0o600;
const NOT_PERMITTED_AFTER_MODULE_PARAMS = (name: string): string =>
  `command '${name}' is currently not permitted - did you already set it via a RainerScript command (v6+ config)?`;

const MODULE_PARAMS: readonly ParamDescriptor[] = [
  { name: 'interval', type: 'int' }, { name: 'facility', type: 'int' }, { name: 'severity', type: 'int' },
  { name: 'bracketing', type: 'binary' }, { name: 'log.syslog', type: 'binary' }, { name: 'resetcounters', type: 'binary' },
  { name: 'log.file', type: 'word' }, { name: 'log.file.overwrite', type: 'binary' }, { name: 'format', type: 'word' }, { name: 'ruleset', type: 'string' },
  ...PUSH_PARAMS,
];

interface ImpstatsConfig {
  configuredViaModule: boolean;
  intervalSeconds: number;
  facility: number;
  severity: number;
  format: StatisticsFormat | 'zabbix';
  bracketing: boolean;
  logToSyslog: boolean;
  resetCounters: boolean;
  logFile: string | null;
  logOverwrite: boolean;
  ruleset: string | null;
  push: PushConfig;
  legacy: { intervalSeconds: number; facility: number; severity: number; json: boolean; cee: boolean };
}

function defaultLegacy(): ImpstatsConfig['legacy'] {
  return { intervalSeconds: DEFAULT_STATS_PERIOD, facility: DEFAULT_FACILITY, severity: DEFAULT_SEVERITY, json: false, cee: false };
}

function defaultConfig(): ImpstatsConfig {
  return {
    configuredViaModule: false, intervalSeconds: DEFAULT_STATS_PERIOD, facility: DEFAULT_FACILITY, severity: DEFAULT_SEVERITY,
    format: 'legacy', bracketing: false, logToSyslog: true, resetCounters: false, logFile: null, logOverwrite: false, ruleset: null, push: defaultPushConfig(), legacy: defaultLegacy(),
  };
}

function config(context: ModuleContext): ImpstatsConfig {
  return context.moduleState('impstats.config', defaultConfig);
}

function applyPushParams(values: Parameters<typeof numberParam>[0], push: PushConfig): void {
  push.url = stringParam(values, 'push.url') ?? push.url;
  push.labels = arrayParam(values, 'push.labels') ?? push.labels;
  push.timeoutMs = numberParam(values, 'push.timeout.ms') ?? push.timeoutMs;
  const flag = (name: string, current: boolean): boolean => {
    const value = numberParam(values, name);
    return value === undefined ? current : value !== 0;
  };
  push.labelInstance = flag('push.label.instance', push.labelInstance);
  push.labelOrigin = flag('push.label.origin', push.labelOrigin);
  push.labelName = flag('push.label.name', push.labelName);
  push.labelJob = stringParam(values, 'push.label.job') ?? push.labelJob;
  push.tlsCaFile = stringParam(values, 'push.tls.cafile') ?? push.tlsCaFile;
  push.tlsCertFile = stringParam(values, 'push.tls.certfile') ?? push.tlsCertFile;
  push.tlsKeyFile = stringParam(values, 'push.tls.keyfile') ?? push.tlsKeyFile;
  push.tlsInsecureSkipVerify = flag('push.tls.insecureSkipVerify', push.tlsInsecureSkipVerify);
  const maxBytes = numberParam(values, 'push.batch.maxBytes');
  if (maxBytes !== undefined) push.batchMaxBytes = Math.max(0, maxBytes);
  const maxSeries = numberParam(values, 'push.batch.maxSeries');
  if (maxSeries !== undefined) push.batchMaxSeries = Math.max(0, maxSeries);
}

function formatOf(name: string): ImpstatsConfig['format'] | null {
  switch (name.toLowerCase()) {
    case 'json': return 'json';
    case 'json-elasticsearch': return 'json-elasticsearch';
    case 'cee': return 'cee';
    case 'legacy': return 'legacy';
    case 'prometheus': return 'prometheus';
    case 'zabbix': return 'zabbix';
    default: return null;
  }
}

class StatisticsReporter implements InputInstance {
  readonly description = 'impstats';
  private cancel: (() => void) | null = null;
  private logHandle: FileHandle | null = null;
  private ruleset: string | null = null;
  private intervalSeconds: number;
  private resourceObject: StatsObject | null = null;
  private pusher: StatisticsPusher | null = null;
  private pendingFile: string | null = null;
  private readonly resource = { utime: 0, stime: 0, maxrss: 0, minflt: 0, majflt: 0, inblock: 0, oublock: 0, nvcsw: 0, nivcsw: 0, openfiles: 0 };

  constructor(private readonly context: InputContext, private readonly settings: ImpstatsConfig) {
    this.intervalSeconds = settings.intervalSeconds;
  }

  check(): void {
    if (this.intervalSeconds === 0) {
      this.context.runtime.error(`impstats: stats interval zero not permitted, using default of ${DEFAULT_STATS_PERIOD} seconds`, RS_RET.NO_ERRCODE);
      this.intervalSeconds = DEFAULT_STATS_PERIOD;
    }
    const name = this.settings.ruleset;
    if (name === null) return;
    if (this.context.rulesetExists(name)) this.ruleset = name;
    else this.context.runtime.error(`impstats: ruleset '${name}' not found - using default ruleset instead`, RS_RET.NO_ERRCODE);
  }

  start(): boolean {
    this.activatePush();
    this.context.statistics.enabled = true;
    this.registerResourceUsage();
    this.cancel = this.context.host.scheduleEvery(() => this.report(), this.intervalSeconds * 1000);
    return true;
  }

  private activatePush(): void {
    const push = this.settings.push;
    if (push.url === null) return;
    if (!validatePushTls(push, this.context)) {
      this.context.runtime.error('impstats: disabling push due to TLS configuration error', RS_RET.PARAM_ERROR);
      return;
    }
    this.pusher = new StatisticsPusher(push, push.labelInstance ? this.context.localHostName() : '', this.context.host, this.context);
  }

  stop(): void {
    if (this.cancel === null) return;
    this.cancel();
    this.cancel = null;
    this.report();
    this.logHandle?.close();
    this.logHandle = null;
    if (this.resourceObject !== null) this.context.statistics.remove(this.resourceObject);
    this.resourceObject = null;
  }

  hup(): void {
    this.logHandle?.close();
    this.logHandle = null;
  }

  private registerResourceUsage(): void {
    const resource = this.resource;
    const object = this.context.statistics.create('resource-usage', { origin: 'impstats' });
    for (const name of Object.keys(resource) as Array<keyof typeof resource>) object.addCounter({ name, read: () => resource[name] });
    this.resourceObject = object;
  }

  private sampleResourceUsage(): void {
    const usage = this.context.host.resourceUsage?.();
    const resource = this.resource;
    resource.utime = usage?.userMicroseconds ?? 0;
    resource.stime = usage?.systemMicroseconds ?? 0;
    resource.maxrss = usage?.maxResidentKilobytes ?? 0;
    resource.minflt = usage?.minorFaults ?? 0;
    resource.majflt = usage?.majorFaults ?? 0;
    resource.inblock = usage?.blocksRead ?? 0;
    resource.oublock = usage?.blocksWritten ?? 0;
    resource.nvcsw = usage?.voluntaryContextSwitches ?? 0;
    resource.nivcsw = usage?.involuntaryContextSwitches ?? 0;
    resource.openfiles = usage?.openFiles ?? 0;
  }

  private report(): void {
    const settings = this.settings;
    const overwrite = settings.logOverwrite && settings.logFile !== null;
    if (overwrite) this.pendingFile = '';
    if (settings.bracketing) this.submitLine('BEGIN');
    this.sampleResourceUsage();
    this.pusher?.push(this.context.statistics);
    if (settings.format === 'zabbix') this.submitLine(this.context.statistics.zabbixLine(this.timedate(), settings.resetCounters));
    else for (const line of this.context.statistics.lines(settings.format, settings.resetCounters)) this.submitLine(line);
    if (settings.bracketing) this.submitLine('END');
    if (overwrite) this.replaceFile();
  }

  private timedate(): string {
    const now = this.context.clock.now();
    const offset = (now.offsetMode === '-' ? -1 : 1) * (now.offsetHour * 60 + now.offsetMinute);
    return ctime(this.context.host.clock.wallMs(), offset).replace(/^(\w{3} \w{3}) (\d) /, '$1 0$2 ');
  }

  private replaceFile(): void {
    const path = this.settings.logFile as string;
    const text = this.pendingFile ?? '';
    this.pendingFile = null;
    const files = this.context.host.files;
    const temporary = `${path}.tmp.${this.temporarySuffix()}`;
    if (!files.write(temporary, text)) {
      this.context.runtime.error(`impstats: error creating temp stats file ${temporary}`, RS_RET.ERR);
      return;
    }
    if (files.rename(temporary, path)) return;
    this.context.runtime.error(`impstats: error renaming temp stats file ${temporary} to ${path}`, RS_RET.ERR);
    files.remove(temporary);
  }

  private temporarySuffix(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let suffix = '';
    for (let index = 0; index < 6; index++) suffix += alphabet[Math.floor(this.context.host.random() * alphabet.length)];
    return suffix;
  }

  private submitLine(line: string): void {
    if (this.settings.logToSyslog) this.submitMessage(line);
    if (this.settings.logFile !== null) this.appendToFile(line);
  }

  private submitMessage(line: string): void {
    this.context.submitter.submit({
      raw: line, inputName: 'impstats', fromHost: null, fromHostIp: '127.0.0.1', fromHostPort: null, ruleset: this.ruleset,
      localOrigin: true,
      preparsed: {
        priority: this.settings.facility * 8 + this.settings.severity, offsetAfterPriority: 0, tag: 'rsyslogd-pstats:', msg: line,
        timestamp: null, parseHostname: false,
      },
    });
  }

  private appendToFile(line: string): void {
    const path = this.settings.logFile as string;
    if (line.length === 0) return;
    if (this.settings.logOverwrite) {
      if (this.pendingFile !== null) this.pendingFile += `${this.stamped(line)}\n`;
      return;
    }
    if (this.logHandle === null) {
      const opened = this.context.host.files.open(path, {
        mode: STATS_FILE_MODE, directoryMode: 0o700, uid: null, gid: null, directoryUid: null, directoryGid: null,
        createDirectories: false, failOnChownFailure: false,
      });
      if ('error' in opened) return;
      this.logHandle = opened.handle;
    }
    this.logHandle.write(`${this.stamped(line)}\n`);
  }

  private stamped(line: string): string {
    const now = this.context.clock.now();
    const offset = (now.offsetMode === '-' ? -1 : 1) * (now.offsetHour * 60 + now.offsetMinute);
    return `${ctime(this.context.host.clock.wallMs(), offset)}: ${line}`;
  }
}

function directives(): DirectiveRegistration[] {
  const legacy = (name: string, type: DirectiveRegistration['type'], apply: (settings: ImpstatsConfig['legacy'], value: string | number) => void): DirectiveRegistration => ({
    name, type,
    apply: (value, context) => {
      const settings = config(context);
      if (settings.configuredViaModule) {
        context.runtime.error(NOT_PERMITTED_AFTER_MODULE_PARAMS(name), RS_RET.PARAM_NOT_PERMITTED);
        return;
      }
      apply(settings.legacy, value);
    },
  });
  return [
    legacy('pstatsinterval', 'int', (settings, value) => { settings.intervalSeconds = Number(value); }),
    legacy('pstatinterval', 'int', (settings, value) => { settings.intervalSeconds = Number(value); }),
    legacy('pstatfacility', 'int', (settings, value) => { settings.facility = Number(value); }),
    legacy('pstatseverity', 'int', (settings, value) => { settings.severity = Number(value); }),
    legacy('pstatjson', 'binary', (settings, value) => { settings.json = value === 1; }),
    legacy('pstatcee', 'binary', (settings, value) => { settings.cee = value === 1; }),
  ];
}

function effectiveConfig(settings: ImpstatsConfig): ImpstatsConfig {
  if (settings.configuredViaModule) return settings;
  const { legacy } = settings;
  return {
    ...settings, intervalSeconds: legacy.intervalSeconds, facility: legacy.facility, severity: legacy.severity,
    format: legacy.cee ? 'cee' : legacy.json ? 'json' : 'legacy',
  };
}

export const impstats: InputModule = {
  kind: 'input',
  name: 'impstats',
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
    settings.intervalSeconds = numberParam(values, 'interval') ?? settings.intervalSeconds;
    settings.facility = numberParam(values, 'facility') ?? settings.facility;
    settings.severity = numberParam(values, 'severity') ?? settings.severity;
    const bracketing = numberParam(values, 'bracketing');
    if (bracketing !== undefined) settings.bracketing = bracketing !== 0;
    const logToSyslog = numberParam(values, 'log.syslog');
    if (logToSyslog !== undefined) settings.logToSyslog = logToSyslog !== 0;
    const resetCounters = numberParam(values, 'resetcounters');
    if (resetCounters !== undefined) settings.resetCounters = resetCounters !== 0;
    settings.logFile = stringParam(values, 'log.file') ?? settings.logFile;
    const logOverwrite = numberParam(values, 'log.file.overwrite');
    if (logOverwrite !== undefined) settings.logOverwrite = logOverwrite !== 0;
    settings.ruleset = stringParam(values, 'ruleset') ?? settings.ruleset;
    applyPushParams(values, settings.push);
    const formatName = stringParam(values, 'format');
    if (formatName !== undefined) {
      const format = formatOf(formatName);
      if (format === null) context.runtime.error(`impstats: invalid format ${formatName}`, RS_RET.ERR);
      else settings.format = format;
    }
    if (settings.ruleset !== null && !settings.logToSyslog) {
      context.warn('impstats: log.syslog set to "off" but ruleset specified - with these settings, the ruleset will never be used, because regular syslog processing is turned off - ruleset parameter is ignored');
      settings.ruleset = null;
    }
    if (settings.logToSyslog && settings.format === 'zabbix' && settings.logFile === null) {
      context.warn('impstats: log.syslog set to "on" and format set to "zabbix" without log.file set. This is not recommended due to potential for pstats msg truncation leading to malformed JSON. Ensure "$MaxMessageSize" at the top of rsyslog.conf to a sufficient size or ensure log.file is specified. Increasing $MaxMessageSize may have other adverse side effect.');
    }
    settings.configuredViaModule = true;
    return true;
  },
  implicitInstances(context) {
    return [new StatisticsReporter(context, effectiveConfig(config(context)))];
  },
  reset(context) {
    config(context).legacy = defaultLegacy();
  },
};
