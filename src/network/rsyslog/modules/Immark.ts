import { getParams, numberParam, stringParam, type ParamDescriptor } from '../config/Params';
import { RS_RET } from '../engine/Log';
import type { DirectiveRegistration, InputContext, InputInstance, InputModule, ModuleContext } from '../engine/Modules';

const DEFAULT_MARK_PERIOD = 20 * 60;
const LOG_SYSLOG = 5;
const LOG_INFO = 6;

const MODULE_PARAMS: readonly ParamDescriptor[] = [
  { name: 'ruleset', type: 'string' }, { name: 'markmessagetext', type: 'string' }, { name: 'use.syslogcall', type: 'binary' },
  { name: 'use.markflag', type: 'binary' }, { name: 'interval', type: 'int' },
];

interface ImmarkConfig {
  configuredViaModule: boolean;
  intervalSeconds: number;
  legacyIntervalSeconds: number;
  markText: string | null;
  useSyslogCall: boolean;
  useMarkFlag: boolean;
  ruleset: string | null;
}

function defaultConfig(): ImmarkConfig {
  return {
    configuredViaModule: false, intervalSeconds: DEFAULT_MARK_PERIOD, legacyIntervalSeconds: DEFAULT_MARK_PERIOD, markText: null,
    useSyslogCall: true, useMarkFlag: true, ruleset: null,
  };
}

function config(context: ModuleContext): ImmarkConfig {
  return context.moduleState('immark.config', defaultConfig);
}

class MarkEmitter implements InputInstance {
  readonly description = 'immark';
  private cancel: (() => void) | null = null;

  constructor(private readonly context: InputContext, private readonly settings: ImmarkConfig, private readonly useSyslogCall: boolean) {}

  check(): void {
    const ruleset = this.settings.ruleset;
    if (ruleset !== null && !this.context.rulesetExists(ruleset)) {
      this.context.runtime.error(`immark: ruleset '${ruleset}' not found - using default ruleset instead`, RS_RET.NO_ERRCODE);
    }
  }

  start(): boolean {
    const seconds = this.settings.configuredViaModule ? this.settings.intervalSeconds : this.settings.legacyIntervalSeconds;
    this.context.settings.markIntervalSeconds = seconds;
    this.cancel = this.context.host.scheduleEvery(() => this.emit(), seconds * 1000);
    return true;
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  private emit(): void {
    const text = this.settings.markText ?? '-- MARK --';
    const mark = this.settings.useMarkFlag;
    if (this.useSyslogCall) {
      this.context.runtime.internal(LOG_INFO, RS_RET.NO_ERRCODE, text, mark);
      return;
    }
    const ruleset = this.settings.ruleset !== null && this.context.rulesetExists(this.settings.ruleset) ? this.settings.ruleset : null;
    this.context.submitter.submit({
      raw: text, inputName: 'immark', fromHost: null, fromHostIp: '127.0.0.1', fromHostPort: null, ruleset, localOrigin: true, mark,
      preparsed: { priority: LOG_SYSLOG * 8 + LOG_INFO, offsetAfterPriority: 0, tag: 'rsyslogd:', msg: text, timestamp: null, parseHostname: false },
    });
  }
}

function directives(): DirectiveRegistration[] {
  return [
    {
      name: 'markmessageperiod', type: 'int',
      apply: (value, context) => {
        if (config(context).configuredViaModule) context.runtime.error('$markmessageperiod not permitted after module(...) parameters were given', RS_RET.ERR);
        else config(context).legacyIntervalSeconds = Number(value);
      },
    },
  ];
}

export const immark: InputModule = {
  kind: 'input',
  name: 'immark',
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
    const syslogCall = numberParam(values, 'use.syslogcall');
    if (syslogCall !== undefined) settings.useSyslogCall = syslogCall !== 0;
    const markFlag = numberParam(values, 'use.markflag');
    if (markFlag !== undefined) settings.useMarkFlag = markFlag !== 0;
    settings.ruleset = stringParam(values, 'ruleset') ?? settings.ruleset;
    settings.markText = stringParam(values, 'markmessagetext') ?? settings.markText;
    settings.configuredViaModule = true;
    for (const entry of params.entries) entry.used = true;
    return true;
  },
  implicitInstances(context) {
    const settings = config(context);
    let useSyslogCall = settings.useSyslogCall;
    if (settings.ruleset !== null && useSyslogCall) {
      context.runtime.error('immark: ruleset specified, but configured to log via syslog call - switching to rsyslog-internal logging', RS_RET.NO_ERRCODE);
      useSyslogCall = false;
    }
    const seconds = settings.configuredViaModule ? settings.intervalSeconds : settings.legacyIntervalSeconds;
    if (seconds === 0) {
      context.runtime.error('immark: mark message period must not be 0, can not run', RS_RET.NO_ERRCODE);
      return [];
    }
    return [new MarkEmitter(context, settings, useSyslogCall)];
  },
  reset(context) {
    config(context).legacyIntervalSeconds = DEFAULT_MARK_PERIOD;
  },
};
