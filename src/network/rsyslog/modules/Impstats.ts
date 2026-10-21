import { getParams, numberParam, stringParam, type ParamDescriptor } from '../config/Params';
import { ctime } from '../engine/ActionRuntime';
import type { FileHandle } from '../engine/Host';
import { RS_RET } from '../engine/Log';
import type { DirectiveRegistration, InputContext, InputInstance, InputModule, ModuleContext } from '../engine/Modules';
import type { StatisticsFormat, StatsObject } from '../engine/Statistics';

const DEFAULT_STATS_PERIOD = 5 * 60;
const DEFAULT_FACILITY = 5;
const DEFAULT_SEVERITY = 6;
const STATS_FILE_MODE = 0o600;
const NOT_PERMITTED_AFTER_MODULE_PARAMS = (name: string): string =>
  `command '${name}' is currently not permitted - did you already set it via a RainerScript command (v6+ config)?`;

const MODULE_PARAMS: readonly ParamDescriptor[] = [
  { name: 'interval', type: 'int' }, { name: 'facility', type: 'int' }, { name: 'severity', type: 'int' },
  { name: 'bracketing', type: 'binary' }, { name: 'log.syslog', type: 'binary' }, { name: 'resetcounters', type: 'binary' },
  { name: 'log.file', type: 'word' }, { name: 'format', type: 'word' }, { name: 'ruleset', type: 'string' },
];

interface ImpstatsConfig {
  configuredViaModule: boolean;
  intervalSeconds: number;
  facility: number;
  severity: number;
  format: StatisticsFormat;
  bracketing: boolean;
  logToSyslog: boolean;
  resetCounters: boolean;
  logFile: string | null;
  ruleset: string | null;
  legacy: { intervalSeconds: number; facility: number; severity: number; json: boolean; cee: boolean };
}

function defaultLegacy(): ImpstatsConfig['legacy'] {
  return { intervalSeconds: DEFAULT_STATS_PERIOD, facility: DEFAULT_FACILITY, severity: DEFAULT_SEVERITY, json: false, cee: false };
}

function defaultConfig(): ImpstatsConfig {
  return {
    configuredViaModule: false, intervalSeconds: DEFAULT_STATS_PERIOD, facility: DEFAULT_FACILITY, severity: DEFAULT_SEVERITY,
    format: 'legacy', bracketing: false, logToSyslog: true, resetCounters: false, logFile: null, ruleset: null, legacy: defaultLegacy(),
  };
}

function config(context: ModuleContext): ImpstatsConfig {
  return context.moduleState('impstats.config', defaultConfig);
}

function formatOf(name: string): StatisticsFormat | null {
  switch (name.toLowerCase()) {
    case 'json': return 'json';
    case 'json-elasticsearch': return 'json-elasticsearch';
    case 'cee': return 'cee';
    case 'legacy': return 'legacy';
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
    this.context.statistics.enabled = true;
    this.registerResourceUsage();
    this.cancel = this.context.host.scheduleEvery(() => this.report(), this.intervalSeconds * 1000);
    return true;
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
    if (settings.bracketing) this.submitLine('BEGIN');
    this.sampleResourceUsage();
    for (const line of this.context.statistics.lines(settings.format, settings.resetCounters)) this.submitLine(line);
    if (settings.bracketing) this.submitLine('END');
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
    if (this.logHandle === null) {
      const opened = this.context.host.files.open(path, {
        mode: STATS_FILE_MODE, directoryMode: 0o700, uid: null, gid: null, directoryUid: null, directoryGid: null,
        createDirectories: false, failOnChownFailure: false,
      });
      if ('error' in opened) return;
      this.logHandle = opened.handle;
    }
    const now = this.context.clock.now();
    const offset = (now.offsetMode === '-' ? -1 : 1) * (now.offsetHour * 60 + now.offsetMinute);
    this.logHandle.write(`${ctime(this.context.host.clock.wallMs(), offset)}: ${line}\n`);
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
    settings.ruleset = stringParam(values, 'ruleset') ?? settings.ruleset;
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
    settings.configuredViaModule = true;
    for (const entry of params.entries) entry.used = true;
    return true;
  },
  implicitInstances(context) {
    return [new StatisticsReporter(context, effectiveConfig(config(context)))];
  },
  reset(context) {
    config(context).legacy = defaultLegacy();
  },
};
