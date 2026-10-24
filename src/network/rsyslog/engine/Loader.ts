import { NvList, type ConfigObject, type Expr, type Location, type Stmt } from '../config/Ast';
import { decodePriorityFilter, decodePropertyFilter } from '../config/Filters';
import { bindFunctionData, prepareFunctions, checkFunctionCall } from '../config/Expressions';
import { LookupRef } from './LookupTable';
import { ConfigScanner, type Diagnostic, type ScannerEnvironment } from '../config/Lexer';
import { ConfigParser, type ConfigSink } from '../config/Parser';
import {
  getParams, isDisabled, numberParam, reportDuplicates, reportUnused, stringParam, arrayParam,
  type ParamDescriptor, type ParamValues,
} from '../config/Params';
import { DEFAULT_RFC3164_SETTINGS, Rfc3164Parser, Rfc5424Parser, defaultParserChain, type Rfc3164ParserSettings } from '../MessageParser';
import { parseLegacyTemplate, standardTemplates, templateFromObject, TemplateError, type Template } from '../Template';
import type { ActionDefinition, ActionOptions, ActionRateLimit, LoadedConfig, RulesetDefinition } from './Config';
import { applyDirective } from './Directives';
import type { RsyslogHost } from './Host';
import { DiagnosticLog, RS_RET } from './Log';
import type {
  ActionModuleInstance, DirectiveRegistration, EngineModule, InputContext, InputModule, InputSubmitter, ModuleContext, ModuleRateLimiter,
  ModuleRateLimitSpec, OutputModule, RuntimeLog,
} from './Modules';
import { AllowedSenderList, parseAllowedSenderEntries, type AllowedSenderEnvironment } from './AllowedSenders';
import { LocalClock } from './LocalClock';
import { Janitor } from './Janitor';
import { RateLimiter } from './RateLimiter';
import { RateLimitRegistry, type SharedRateLimit } from './SharedRateLimit';
import { SenderResolver } from './SenderResolver';
import { DynStatsRegistry, DEFAULT_MAX_CARDINALITY, DEFAULT_UNUSED_METRIC_LIFE_SECONDS } from './DynStats';
import { PercentileStatsRegistry } from './PercentileStats';
import { Statistics } from './Statistics';
import { applyQueueParameters, correctQueueParameters, type QueueContext } from './QueueParams';
import { GLOBAL_PARAMS, applyGlobalParams, defaultGlobalSettings, defaultQueueSettings, type CompatMode, type QueueSettings, type QueueTimeouts } from './Settings';

export interface ModuleCatalog {
  find(cnfName: string): EngineModule | undefined;
  moduleDirectory(): string;
  fileExists(name: string): boolean;
}

export interface LoaderOptions {
  readonly host: RsyslogHost;
  readonly catalog: ModuleCatalog;
  readonly submitter: InputSubmitter;
  readonly partialConfig?: boolean;
}

export const QUEUE_PARAMS: readonly ParamDescriptor[] = [
  { name: 'queue.filename', type: 'string' }, { name: 'queue.size', type: 'size' }, { name: 'queue.highwatermark', type: 'int' },
  { name: 'queue.lowwatermark', type: 'int' }, { name: 'queue.discardmark', type: 'int' }, { name: 'queue.discardseverity', type: 'severity' },
  { name: 'queue.checkpointinterval', type: 'int' }, { name: 'queue.syncqueuefiles', type: 'binary' },
  { name: 'queue.type', type: 'queuetype' }, { name: 'queue.workerthreads', type: 'int' },
  { name: 'queue.timeoutshutdown', type: 'int' }, { name: 'queue.timeoutactioncompletion', type: 'int' },
  { name: 'queue.timeoutenqueue', type: 'int' }, { name: 'queue.timeoutworkerthreadshutdown', type: 'int' },
  { name: 'queue.workerthreadminimummessages', type: 'int' }, { name: 'queue.maxfilesize', type: 'size' },
  { name: 'queue.saveonshutdown', type: 'binary' }, { name: 'queue.dequeueslowdown', type: 'int' },
  { name: 'queue.dequeuetimebegin', type: 'int' }, { name: 'queue.dequeuetimeend', type: 'int' },
  { name: 'queue.dequeuebatchsize', type: 'int' }, { name: 'queue.maxdiskspace', type: 'size' },
  { name: 'queue.spooldirectory', type: 'string' }, { name: 'queue.takeflowctlfrommsg', type: 'binary' },
  { name: 'queue.samplinginterval', type: 'int' }, { name: 'queue.mindequeuebatchsize', type: 'int' },
  { name: 'queue.mindequeuebatchsize.timeout', type: 'int' }, { name: 'queue.fulldelaymark', type: 'int' },
  { name: 'queue.lightdelaymark', type: 'int' }, { name: 'queue.diskqueuetype', type: 'string' },
  { name: 'queue.diskqueueautoupgrade', type: 'binary' }, { name: 'queue.diskqueueidletimeout', type: 'int' },
  { name: 'queue.mutexcontentionstats', type: 'binary' }, { name: 'queue.oncorruption', type: 'string' },
];

const ACTION_PARAMS: readonly ParamDescriptor[] = [
  ...QUEUE_PARAMS,
  { name: 'name', type: 'word' }, { name: 'type', type: 'string', required: true }, { name: 'action.errorfile', type: 'string' },
  { name: 'action.errorfile.maxsize', type: 'int' }, { name: 'action.writeallmarkmessages', type: 'binary' },
  { name: 'action.execonlyeverynthtime', type: 'int' }, { name: 'action.execonlyeverynthtimetimeout', type: 'int' },
  { name: 'action.execonlyonceeveryinterval', type: 'int' }, { name: 'action.execonlywhenpreviousissuspended', type: 'binary' },
  { name: 'action.repeatedmsgcontainsoriginalmsg', type: 'binary' }, { name: 'action.resumeretrycount', type: 'int' },
  { name: 'action.reportsuspension', type: 'binary' }, { name: 'action.reportsuspensioncontinuation', type: 'binary' },
  { name: 'action.resumeintervalmax', type: 'positive' }, { name: 'action.resumeinterval', type: 'int' },
  { name: 'action.externalstate.file', type: 'string' }, { name: 'action.ratelimit.name', type: 'string' },
  { name: 'action.copymsg', type: 'binary' },
];

const RULESET_PARAMS: readonly ParamDescriptor[] = [
  { name: 'name', type: 'string', required: true }, { name: 'parser', type: 'array' }, ...QUEUE_PARAMS,
];

const MODULE_PARAMS: readonly ParamDescriptor[] = [
  { name: 'load', type: 'string', required: true }, { name: 'config.enabled', type: 'string' },
];

const PARSER_PARAMS: readonly ParamDescriptor[] = [
  { name: 'name', type: 'string', required: true }, { name: 'type', type: 'string', required: true },
];

const RATELIMIT_PARAMS: readonly ParamDescriptor[] = [
  { name: 'name', type: 'string', required: true }, { name: 'interval', type: 'int' }, { name: 'burst', type: 'int' },
  { name: 'severity', type: 'severity' }, { name: 'policy', type: 'string' }, { name: 'policyWatch', type: 'binary' },
  { name: 'policyWatchDebounce', type: 'string' }, { name: 'perSource', type: 'binary' }, { name: 'perSourcePolicy', type: 'string' },
  { name: 'perSourceKeyTpl', type: 'string' }, { name: 'perSourceMaxStates', type: 'int' }, { name: 'perSourceTopN', type: 'int' },
];

const LOOKUP_TABLE_PARAMS: readonly ParamDescriptor[] = [
  { name: 'name', type: 'string', required: true }, { name: 'file', type: 'string', required: true }, { name: 'reloadOnHUP', type: 'binary' },
];

const DYN_STATS_PARAMS: readonly ParamDescriptor[] = [
  { name: 'name', type: 'string', required: true }, { name: 'resettable', type: 'binary' },
  { name: 'maxCardinality', type: 'positive' }, { name: 'unusedMetricLife', type: 'positive' },
  { name: 'persistStateInterval', type: 'positive' }, { name: 'persistStateTimeInterval', type: 'positive' },
  { name: 'statefile.directory', type: 'string' },
];

const PERCENTILE_STATS_PARAMS: readonly ParamDescriptor[] = [
  { name: 'name', type: 'string', required: true }, { name: 'delimiter', type: 'string' },
  { name: 'percentiles', type: 'array' }, { name: 'windowSize', type: 'positive' },
];

const TIMEZONE_PARAMS: readonly ParamDescriptor[] = [{ name: 'id', type: 'string', required: true }, { name: 'offset', type: 'string', required: true }];

const INCLUDE_PARAMS: readonly ParamDescriptor[] = [{ name: 'file', type: 'string' }, { name: 'text', type: 'string' }, { name: 'mode', type: 'word' }];

const INPUT_PARAMS: readonly ParamDescriptor[] = [{ name: 'type', type: 'string', required: true }];

const RFC3164_PARSER_PARAMS: readonly ParamDescriptor[] = [
  { name: 'detect.yearaftertimestamp', type: 'binary' }, { name: 'permit.squarebracketsinhostname', type: 'binary' },
  { name: 'permit.slashesinhostname', type: 'binary' }, { name: 'permit.atsignsinhostname', type: 'binary' },
  { name: 'force.tagendingbycolon', type: 'binary' }, { name: 'remove.msgfirstspace', type: 'binary' },
  { name: 'detect.headerless', type: 'binary' }, { name: 'headerless.hostname', type: 'string' }, { name: 'headerless.tag', type: 'string' },
  { name: 'headerless.ruleset', type: 'string' }, { name: 'headerless.errorfile', type: 'string' }, { name: 'headerless.drop', type: 'binary' },
];

interface LegacyActionState {
  resumeInterval: number;
  resumeRetryCount: number;
  writeAllMarkMessages: boolean;
  execOnlyWhenPreviousIsSuspended: boolean;
  execOnlyOnceEveryInterval: number;
  execOnlyEveryNthTime: number;
  execOnlyEveryNthTimeTimeout: number;
  repeatedMessageContainsOriginalMessage: boolean;
  name: string | null;
  queue: QueueSettings;
  explicitTimeouts: Set<keyof QueueTimeouts>;
}

function newLegacyActionState(): LegacyActionState {
  return {
    resumeInterval: 30, resumeRetryCount: 0, writeAllMarkMessages: true, execOnlyWhenPreviousIsSuspended: false,
    execOnlyOnceEveryInterval: 0, execOnlyEveryNthTime: 0, execOnlyEveryNthTimeTimeout: 0,
    repeatedMessageContainsOriginalMessage: false, name: null, queue: defaultQueueSettings('Direct', 1000), explicitTimeouts: new Set(),
  };
}

export class ConfigLoader implements ConfigSink {
  readonly log = new DiagnosticLog();
  readonly config: LoadedConfig;
  private readonly scanner: ConfigScanner;
  private readonly directives = new Map<string, DirectiveRegistration>();
  private readonly moduleStates = new Map<string, unknown>();
  private legacy = newLegacyActionState();
  private currentRuleset: RulesetDefinition;
  private readonly context: ModuleContext;
  private readonly inputContext: InputContext;
  private nextActionId = 1;
  private nextInputId = 1;
  private readonly loadedNames = new Set<string>();
  private readonly pendingCalls: { name: string; location: Location }[] = [];
  private currentLocation: Location = { file: '', line: 0 };
  private runtimeSink: RuntimeLog = {
    error: (text, code, errno) => this.log.error(text, code ?? RS_RET.ERR, errno),
    warning: (text, code) => this.log.warning(text, code),
    info: (text, code) => this.log.info(text, code),
    log: (severity, code, text, errno) => {
      if (severity <= 3) this.log.error(text, code, errno);
      else if (severity === 4) this.log.warning(text, code);
      else this.log.info(text, code);
    },
    internal: () => undefined,
    childExited: () => undefined,
  };

  constructor(private readonly options: LoaderOptions) {
    const settings = defaultGlobalSettings();
    const statistics = new Statistics();
    this.config = {
      settings, templates: new Map(), rulesets: new Map(), modules: new Map(), inputs: [], actions: [], parsers: new Map(),
      rateLimits: new RateLimitRegistry({
        runtime: () => this.runtimeSink, files: options.host.files, statistics, template: (name) => this.config.templates.get(name),
        schedule: (callback, delay) => options.host.schedule(callback, delay), nowMs: () => options.host.clock.wallMs(),
      }),
      lookupTables: [], statistics, janitor: new Janitor(),
      dynStats: new DynStatsRegistry(statistics, { nowMs: () => options.host.clock.wallMs(), runtime: () => this.runtimeSink, files: options.host.files, workDirectory: () => settings.workDirectory }),
      percentileStats: new PercentileStatsRegistry(statistics, { error: (text, code) => this.runtimeSink.error(text, code) }), timezones: new Map(), hadErrors: false, fatalConfigError: null, inputDeclarationFailed: false, outchannels: [],
      senderResolver: new SenderResolver(options.host, () => settings, () => this.runtimeSink),
      localClock: new LocalClock(options.host, () => this.config.timezones),
      bindRuntime: (sink) => { this.runtimeSink = sink; },
    };
    for (const template of standardTemplates()) this.config.templates.set(template.name, template);
    this.currentRuleset = this.createRuleset('RSYSLOG_DefaultRuleset');
    for (const parser of defaultParserChain()) this.config.parsers.set(parser.name, parser);
    this.context = {
      host: options.host,
      runtime: {
        error: (text, code, errno) => this.runtimeSink.error(text, code, errno),
        warning: (text, code) => this.runtimeSink.warning(text, code),
        info: (text, code) => this.runtimeSink.info(text, code),
        log: (severity, code, text, errno) => this.runtimeSink.log(severity, code, text, errno),
        internal: (severity, code, text, mark, facility) => this.runtimeSink.internal(severity, code, text, mark, facility),
        childExited: (pid, exitCode) => this.runtimeSink.childExited(pid, exitCode),
      },
      settings,
      statistics: this.config.statistics,
      janitor: this.config.janitor,
      recordSender: (sender, messages, seconds) => this.recordSender(sender, messages, seconds),
      template: (name) => this.config.templates.get(name),
      report: (message) => this.reportAt(message),
      warn: (message) => this.warnAt(message),
      loaded: (name) => this.loadedNames.has(name),
      rateLimiter: (spec) => this.createModuleRateLimiter(spec),
      netstreamDriverAvailable: (driver) => this.options.catalog.fileExists(`lmnsd_${driver}.so`),
      moduleDirectory: () => this.options.catalog.moduleDirectory(),
      moduleFileAvailable: (fileName) => this.options.catalog.fileExists(fileName),
      outchannel: (name) => this.config.outchannels.find((channel) => channel.name === name),
      moduleState: <T>(name: string, create: () => T): T => {
        if (!this.moduleStates.has(name)) this.moduleStates.set(name, create());
        return this.moduleStates.get(name) as T;
      },
    };
    this.inputContext = {
      ...this.context,
      submitter: options.submitter,
      rulesetExists: (name) => this.config.rulesets.has(name),
      instanceId: () => this.nextInputId++,
      registerInput: (moduleName, instance) => { this.config.inputs.push({ module: moduleName, instance }); },
      allowedSenders: (entries, source) => this.inputAllowedSenders(entries, source),
      resolveSender: (ip) => this.config.senderResolver.resolve(ip),
      clock: this.config.localClock,
    };
    const scannerHost: ScannerEnvironment = {
      environment: (name) => settings.environment[name] ?? options.host.environment(name),
      readFile: (path) => options.host.files.read(path),
      report: (diagnostic) => this.takeScannerDiagnostic(diagnostic),
    };
    this.scanner = new ConfigScanner(scannerHost);
    this.registerCoreDirectives();
    for (const name of ['omfile', 'ompipe', 'omshell', 'omdiscard', 'omfwd', 'omusrmsg', 'pmrfc5424', 'pmrfc3164']) this.loadBuiltin(name);
  }

  private allowedSenderEnvironment(): AllowedSenderEnvironment {
    const settings = this.config.settings;
    return {
      report: (text) => this.runtimeSink.error(text, RS_RET.NO_ERRCODE),
      disableDns: settings.disableDns,
      aclDontResolve: settings.aclDontResolve,
      aclAddHostnameOnFail: settings.aclAddHostnameOnFail,
      resolve: (name) => this.options.host.network.resolve(name),
    };
  }

  addAllowedSenders(list: AllowedSenderList, text: string, onError: (message: string) => void): boolean {
    const parsed = parseAllowedSenderEntries(text);
    for (const entry of parsed.entries) {
      const outcome = list.addAddress(entry.address, entry.bits, this.allowedSenderEnvironment());
      if (outcome === 'error') {
        onError(`Error ${RS_RET.ERR} parsing address in allowed senderlist - ignoring.`);
        return false;
      }
    }
    if (parsed.error) {
      onError('Error -3000 parsing address in allowed senderlist - ignoring.');
      return false;
    }
    return true;
  }

  private inputAllowedSenders(entries: string[], source: string): AllowedSenderList | null {
    if (entries.length === 0) {
      this.runtimeSink.error(`${source}: allowedSender array must not be empty`, RS_RET.INVALID_PARAMS);
      return null;
    }
    const list = new AllowedSenderList();
    for (const text of entries) {
      const parsed = parseAllowedSenderEntries(text);
      if (parsed.error || parsed.entries.length !== 1) {
        const message = parsed.error ? 'Invalid ip address' : `Invalid extra data after allowedSender entry '${text}'`;
        this.runtimeSink.error(message, RS_RET.INVALID_PARAMS);
        return null;
      }
      const outcome = list.addAddress(parsed.entries[0].address, parsed.entries[0].bits, this.allowedSenderEnvironment());
      if (outcome === 'error') return null;
    }
    return list;
  }

  private legacyOutchannel(rest: string): string {
    const comma = rest.indexOf(',');
    const name = (comma < 0 ? rest : rest.slice(0, comma)).trimStart();
    if (name === '') {
      this.runtimeSink.error('Invalid config line: could not extract name - line ignored', RS_RET.NOT_FOUND);
      return '';
    }
    let remaining = comma < 0 ? '' : rest.slice(comma + 1);
    const skipComma = (): void => {
      remaining = remaining.replace(/^\s+/, '');
      if (remaining.startsWith(',')) remaining = remaining.slice(1);
      remaining = remaining.replace(/^\s+/, '');
    };
    skipComma();
    const fileEnd = remaining.search(/[ ,]/);
    const fileTemplate = fileEnd < 0 ? remaining : remaining.slice(0, fileEnd);
    remaining = fileEnd < 0 ? '' : remaining.slice(fileEnd);
    let sizeLimit = 0;
    let command: string | null = null;
    if (remaining !== '') {
      skipComma();
      const digits = /^\d*/.exec(remaining)?.[0] ?? '';
      sizeLimit = digits === '' ? 0 : Number(digits);
      remaining = remaining.slice(digits.length);
    }
    if (remaining !== '') {
      skipComma();
      command = remaining;
      remaining = '';
    }
    this.config.outchannels.push({ name, fileTemplate: fileTemplate === '' ? null : fileTemplate, sizeLimit, sizeLimitCommand: command });
    return remaining;
  }

  private legacyAllowedSender(rest: string): string {
    const comma = rest.indexOf(',');
    const protocol = (comma < 0 ? rest : rest.slice(0, comma)).trim();
    const entries = comma < 0 ? '' : rest.slice(comma + 1);
    const settings = this.config.settings;
    const lowered = protocol.toLowerCase();
    if (lowered !== 'udp' && lowered !== 'tcp') {
      this.runtimeSink.error(`Invalid protocol '${protocol}' in allowed sender list, line ignored`, RS_RET.ERR);
      return '';
    }
    this.addAllowedSenders(lowered === 'udp' ? settings.allowedSenders.udp : settings.allowedSenders.tcp, entries, (message) => this.runtimeSink.error(message, RS_RET.ERR));
    return '';
  }

  private recordSender(sender: string, messages: number, seconds: number): void {
    if (!this.config.settings.senders.keepTrack) return;
    this.config.statistics.senders.record(sender, messages, seconds, () => {
      if (this.config.settings.senders.reportNew) this.runtimeSink.info(`new sender '${sender}'`, RS_RET.SENDER_APPEARED);
    });
  }

  private createModuleRateLimiter(spec: ModuleRateLimitSpec): { readonly limiter: ModuleRateLimiter | null } | null {
    let interval = spec.interval;
    let burst = spec.burst;
    const severity = spec.severity ?? 0;
    let shared: SharedRateLimit | undefined;
    if (spec.configName !== null) {
      shared = this.config.rateLimits.find(spec.configName);
      if (shared === undefined) {
        this.runtimeSink.error(`ratelimit config '${spec.configName}' not found`, RS_RET.NOT_FOUND);
        return null;
      }
      if (shared.scope !== 'input') {
        this.runtimeSink.error(`ratelimit config '${spec.configName}' has incompatible scope for ${spec.module}`, RS_RET.CONFIG_ERROR);
        return null;
      }
      interval = shared.interval;
      burst = shared.burst;
    } else if (interval <= 0 && spec.forInput !== true) {
      return { limiter: null };
    }
    const host = this.options.host;
    return {
      limiter: new RateLimiter({
        name: spec.dynamicName === undefined ? spec.module : `${spec.module}[${spec.dynamicName}]`, interval, burst, severityThreshold: severity, reduceRepeated: spec.forInput === true && this.config.settings.repeatedMessageReduction,
        internal: (level, code, text) => this.runtimeSink.internal(level, code, text),
        nowSeconds: () => Math.floor(host.clock.wallMs() / 1000),
        shared, registry: this.config.rateLimits,
      }),
    };
  }

  private createOutputRateLimiter(configName: string, actionName: string, direct: boolean): ActionRateLimit | null {
    const shared = this.config.rateLimits.find(configName);
    if (shared === undefined) {
      this.runtimeSink.error(`ratelimit config '${configName}' not found`, RS_RET.NOT_FOUND);
      return null;
    }
    if (shared.scope !== 'output') {
      this.runtimeSink.error(`ratelimit config '${configName}' has incompatible scope for action`, RS_RET.CONFIG_ERROR);
      return null;
    }
    const host = this.options.host;
    const limiter = new RateLimiter({
      name: `action[${actionName}]`, interval: shared.interval, burst: shared.burst, severityThreshold: 0, reduceRepeated: false,
      internal: (level, code, text) => this.runtimeSink.internal(level, code, text),
      nowSeconds: () => Math.floor(host.clock.wallMs() / 1000), shared, registry: this.config.rateLimits, noTimeCache: true,
    });
    if (direct) shared.outputPaceForbidden = true;
    if (shared.outputMode === 'pace' && direct) {
      this.runtimeSink.error(`action '${actionName}': action.ratelimit.name='${configName}' uses pace mode, which requires a non-direct action queue`, RS_RET.CONFIG_ERROR);
      return null;
    }
    return { limiter, shared };
  }

  private takeScannerDiagnostic(diagnostic: Diagnostic): void {
    this.currentLocation = { file: diagnostic.file, line: diagnostic.line };
    if (diagnostic.severity === 'error') this.reportAt(diagnostic.message, diagnostic);
    else this.warnAt(diagnostic.message, diagnostic);
  }

  private where(location: Location | Diagnostic = this.currentLocation): string {
    return location.file === '' ? '' : `error during parsing file ${location.file}, on or before line ${location.line}: `;
  }

  reportAt(message: string, location: Location | Diagnostic = this.currentLocation): void {
    this.config.hadErrors = true;
    if (location.file === '') this.log.error(`error during config processing: ${message}`, RS_RET.CONF_PARSE_ERROR);
    else this.log.error(`${this.where(location)}${message}`, RS_RET.CONF_PARSE_ERROR);
  }

  warnAt(message: string, location: Location | Diagnostic = this.currentLocation): void {
    this.log.warning(`warning during parsing file ${location.file}, on or before line ${location.line}: ${message}`, RS_RET.CONF_PARSE_WARNING);
  }

  private paramEnvironment(): { report(message: string): void; uidOf(name: string): number | null; gidOf(name: string): number | null } {
    return {
      report: (message) => this.reportAt(message),
      uidOf: (name) => this.options.host.users.uidOf(name),
      gidOf: (name) => this.options.host.users.gidOf(name),
    };
  }

  private createRuleset(name: string): RulesetDefinition {
    const ruleset: RulesetDefinition = { name, statements: [], parserNames: null, queue: null };
    this.config.rulesets.set(name, ruleset);
    return ruleset;
  }

  private registerDirective(registration: DirectiveRegistration): void {
    this.directives.set(registration.name.toLowerCase(), registration);
  }

  private registerCoreDirectives(): void {
    const settings = this.config.settings;
    const flag = (name: string, apply: (on: boolean) => void): void =>
      this.registerDirective({ name, type: 'binary', apply: (value) => apply(value === 1) });
    const word = (name: string, apply: (value: string) => void): void =>
      this.registerDirective({ name, type: 'word', apply: (value) => apply(String(value)) });
    const integer = (name: string, apply: (value: number) => void, type: DirectiveRegistration['type'] = 'int'): void =>
      this.registerDirective({ name, type, apply: (value) => apply(Number(value)) });
    this.registerDirective({ name: 'sleep', type: 'goneaway', apply: () => undefined });
    flag('logrsyslogstatusmessages', (on) => { settings.logStatusMessages = on; });
    flag('errormessagestostderr', () => undefined);
    flag('abortonuncleanconfig', (on) => { settings.abortOnUncleanConfig = on; });
    flag('repeatedmsgreduction', (on) => { settings.repeatedMessageReduction = on; });
    flag('debugprinttemplatelist', () => undefined);
    flag('debugprintmodulelist', () => undefined);
    flag('debugprintcfsyslinehandlerlist', () => undefined);
    this.registerDirective({ name: 'privdroptouser', type: 'uid', apply: (value) => { settings.privDrop.uid = Number(value); } });
    integer('privdroptouserid', (value) => { settings.privDrop.uid = value; });
    this.registerDirective({ name: 'privdroptogroup', type: 'gid', apply: (value) => { settings.privDrop.gid = Number(value); } });
    integer('privdroptogroupid', (value) => { settings.privDrop.gid = value; });
    word('generateconfiggraph', () => undefined);
    this.registerDirective({ name: 'umask', type: 'filemode', apply: (value) => { settings.umask = Number(value); } });
    integer('maxopenfiles', (value) => { settings.maxOpenFiles = value; });
    integer('actionresumeinterval', (value) => { this.legacy.resumeInterval = value; });
    this.registerDirective({ name: 'modload', type: 'custom', apply: () => undefined, custom: (rest) => this.legacyModLoad(rest) });
    word('defaultruleset', (value) => { settings.defaultRuleset = value; });
    word('ruleset', (value) => this.setCurrentRuleset(value));
    this.registerDirective({ name: 'template', type: 'custom', apply: () => undefined, custom: (rest) => this.legacyTemplate(rest) });
    this.registerDirective({ name: 'outchannel', type: 'custom', apply: () => undefined, custom: (rest) => this.legacyOutchannel(rest) });
    this.registerDirective({ name: 'allowedsender', type: 'custom', apply: () => undefined, custom: (rest) => this.legacyAllowedSender(rest) });
    word('workdirectory', (value) => { settings.workDirectory = value; });
    word('localhostname', (value) => { settings.localHostNameOverride = value; });
    flag('preservefqdn', (on) => { settings.preserveFqdn = on; });
    this.registerDirective({ name: 'maxmessagesize', type: 'size', apply: (value) => { settings.parser.maxLine = Math.max(128, Math.min(2147483647, Number(value))); } });
    this.registerDirective({ name: 'controlcharacterescapeprefix', type: 'char', apply: (value) => { settings.parser.controlCharacterEscapePrefix = String(value); } });
    flag('droptrailinglfonreception', (on) => { settings.parser.dropTrailingLFOnReception = on; });
    flag('droptrailingcronreception', (on) => { settings.parser.dropTrailingCROnReception = on; });
    flag('escapecontrolcharactersonreceive', (on) => { settings.parser.escapeControlCharactersOnReceive = on; });
    flag('spacelfonreceive', (on) => { settings.parser.spaceLFOnReceive = on; });
    flag('escape8bitcharactersonreceive', (on) => { settings.parser.escape8BitCharactersOnReceive = on; });
    flag('escapecontrolcharactertab', (on) => { settings.parser.escapeControlCharacterTab = on; });
    word('defaultnetstreamdriver', (value) => { settings.defaultNetstreamDriver = value; });
    word('defaultopensslengine', (value) => { settings.defaultOpensslEngine = value; });
    word('defaultnetstreamdrivercafile', (value) => { settings.defaultNetstreamDriverCaFile = value; });
    word('defaultnetstreamdrivercertfile', (value) => { settings.defaultNetstreamDriverCertFile = value; });
    word('defaultnetstreamdriverkeyfile', (value) => { settings.defaultNetstreamDriverKeyFile = value; });
    word('defaultnetstreamdrivercrlfile', (value) => { settings.defaultNetstreamDriverCrlFile = value; });
    flag('dropmsgswithmaliciousdnsptrrecords', (on) => { settings.dropMessagesWithMaliciousDnsPtrRecords = on; });
    const main = settings.mainQueue;
    word('mainmsgqueuefilename', (value) => { main.fileName = value; });
    integer('mainmsgqueuesize', (value) => { main.size = value; });
    integer('mainmsgqueuehighwatermark', (value) => { main.highWatermark = value; });
    integer('mainmsgqueuelowwatermark', (value) => { main.lowWatermark = value; });
    integer('mainmsgqueuediscardmark', (value) => { main.discardMark = value; });
    this.registerDirective({ name: 'mainmsgqueuediscardseverity', type: 'severity', apply: (value) => { main.discardSeverity = Number(value); } });
    integer('mainmsgqueuecheckpointinterval', (value) => { main.checkpointInterval = value; });
    flag('mainmsgqueuesyncqueuefiles', (on) => { main.syncQueueFiles = on; });
    word('mainmsgqueuetype', (value) => { main.type = queueTypeName(value) ?? main.type; });
    integer('mainmsgqueueworkerthreads', (value) => { main.workerThreads = value; }, 'positive');
    integer('mainmsgqueuetimeoutshutdown', (value) => { main.timeoutShutdown = value; });
    integer('mainmsgqueuetimeoutactioncompletion', (value) => { main.timeoutActionCompletion = value; });
    integer('mainmsgqueuetimeoutenqueue', (value) => { main.timeoutEnqueue = value; });
    integer('mainmsgqueueworkertimeoutthreadshutdown', (value) => { main.workerTimeoutThreadShutdown = value; });
    integer('mainmsgqueuedequeueslowdown', (value) => { main.dequeueSlowdown = value; });
    integer('mainmsgqueueworkerthreadminimummessages', (value) => { main.workerThreadMinimumMessages = value; });
    this.registerDirective({ name: 'mainmsgqueuemaxfilesize', type: 'size', apply: (value) => { main.maxFileSize = Number(value); } });
    this.registerDirective({ name: 'mainmsgqueuedequeuebatchsize', type: 'size', apply: (value) => { main.dequeueBatchSize = Number(value); } });
    this.registerDirective({ name: 'mainmsgqueuemaxdiskspace', type: 'size', apply: (value) => { main.maxDiskSpace = Number(value); } });
    flag('mainmsgqueuesaveonshutdown', (on) => { main.saveOnShutdown = on; });
    integer('mainmsgqueuedequeuetimebegin', (value) => { main.dequeueTimeBegin = value; });
    integer('mainmsgqueuedequeuetimeend', (value) => { main.dequeueTimeEnd = value; });
    word('moddir', () => undefined);
    this.registerDirective({ name: 'resetconfigvariables', type: 'custom', apply: () => undefined, custom: (rest) => { this.resetConfigVariables(); return rest; } });
    this.registerDirective({ name: 'rulesetparser', type: 'word', apply: (value) => this.addRulesetParser(String(value)) });
    flag('rulesetcreatemainqueue', (on) => {
      if (!on) return;
      const queue = { ...this.config.settings.mainQueue };
      correctQueueParameters(queue, this.queueContext(`ruleset ${this.currentRuleset.name} queue`));
      this.currentRuleset.queue = queue;
    });

    const legacy = (): LegacyActionState => this.legacy;
    word('actionname', (value) => { legacy().name = value; });
    flag('actionwriteallmarkmessages', (on) => { legacy().writeAllMarkMessages = on; });
    integer('actionexeconlyeverynthtime', (value) => { legacy().execOnlyEveryNthTime = value; });
    integer('actionexeconlyeverynthtimetimeout', (value) => { legacy().execOnlyEveryNthTimeTimeout = value; });
    integer('actionexeconlyonceeveryinterval', (value) => { legacy().execOnlyOnceEveryInterval = value; });
    flag('repeatedmsgcontainsoriginalmsg', (on) => { legacy().repeatedMessageContainsOriginalMessage = on; });
    flag('actionexeconlywhenpreviousissuspended', (on) => { legacy().execOnlyWhenPreviousIsSuspended = on; });
    integer('actionresumeretrycount', (value) => { legacy().resumeRetryCount = value; });
    const queue = (): QueueSettings => legacy().queue;
    word('actionqueuefilename', (value) => { queue().fileName = value; });
    integer('actionqueuesize', (value) => { queue().size = value; });
    integer('actionqueuedequeuebatchsize', (value) => { queue().dequeueBatchSize = value; });
    this.registerDirective({ name: 'actionqueuemaxdiskspace', type: 'size', apply: (value) => { queue().maxDiskSpace = Number(value); } });
    integer('actionqueuehighwatermark', (value) => { queue().highWatermark = value; });
    integer('actionqueuelowwatermark', (value) => { queue().lowWatermark = value; });
    integer('actionqueuediscardmark', (value) => { queue().discardMark = value; });
    integer('actionqueuediscardseverity', (value) => { queue().discardSeverity = value; });
    integer('actionqueuecheckpointinterval', (value) => { queue().checkpointInterval = value; });
    flag('actionqueuesyncqueuefiles', (on) => { queue().syncQueueFiles = on; });
    word('actionqueuetype', (value) => { queue().type = queueTypeName(value) ?? queue().type; });
    integer('actionqueueworkerthreads', (value) => { queue().workerThreads = value; }, 'positive');
    integer('actionqueuetimeoutshutdown', (value) => { queue().timeoutShutdown = value; legacy().explicitTimeouts.add('timeoutShutdown'); });
    integer('actionqueuetimeoutactioncompletion', (value) => { queue().timeoutActionCompletion = value; legacy().explicitTimeouts.add('timeoutActionCompletion'); });
    integer('actionqueuetimeoutenqueue', (value) => { queue().timeoutEnqueue = value; legacy().explicitTimeouts.add('timeoutEnqueue'); });
    integer('actionqueueworkertimeoutthreadshutdown', (value) => { queue().workerTimeoutThreadShutdown = value; legacy().explicitTimeouts.add('workerTimeoutThreadShutdown'); });
    integer('actionqueueworkerthreadminimummessages', (value) => { queue().workerThreadMinimumMessages = value; });
    this.registerDirective({ name: 'actionqueuemaxfilesize', type: 'size', apply: (value) => { queue().maxFileSize = Number(value); } });
    flag('actionqueuesaveonshutdown', (on) => { queue().saveOnShutdown = on; });
    integer('actionqueuedequeueslowdown', (value) => { queue().dequeueSlowdown = value; });
    integer('actionqueuedequeuetimebegin', (value) => { queue().dequeueTimeBegin = value; });
    integer('actionqueuedequeuetimeend', (value) => { queue().dequeueTimeEnd = value; });
  }

  private readonly queueFiles = new Set<string>();

  private queueContext(name: string): QueueContext {
    return {
      name,
      usedFiles: this.queueFiles,
      workDirectory: this.config.settings.workDirectory,
      diagnostics: {
        parserError: (text) => this.reportAt(text),
        parserWarning: (text) => this.warnAt(text),
        warning: (text, code) => this.log.warning(text, code),
        error: (text, code) => this.log.error(text, code),
      },
    };
  }

  private legacyQueueWithDefaults(): QueueSettings {
    const queue = { ...this.legacy.queue };
    const defaults = this.config.settings.queueTimeouts.action;
    for (const field of ['timeoutShutdown', 'timeoutActionCompletion', 'timeoutEnqueue', 'workerTimeoutThreadShutdown'] as const) {
      if (!this.legacy.explicitTimeouts.has(field)) queue[field] = defaults[field];
    }
    return queue;
  }

  private resetConfigVariables(): void {
    this.legacy.execOnlyOnceEveryInterval = 0;
    this.legacy.execOnlyWhenPreviousIsSuspended = false;
    const settings = this.config.settings;
    settings.defaultNetstreamDriver = null;
    settings.defaultOpensslEngine = null;
    settings.defaultNetstreamDriverCaFile = null;
    settings.defaultNetstreamDriverCertFile = null;
    settings.defaultNetstreamDriverKeyFile = null;
    settings.defaultNetstreamDriverCrlFile = null;
    settings.localHostNameOverride = null;
    settings.workDirectory = null;
    settings.preserveFqdn = false;
    settings.parser = { ...settings.parser, controlCharacterEscapePrefix: '#', dropTrailingLFOnReception: true, dropTrailingCROnReception: false, escapeControlCharactersOnReceive: true, spaceLFOnReceive: false, escape8BitCharactersOnReceive: false, escapeControlCharacterTab: true, escapeControlCharactersCStyle: false, maxLine: 8192 };
    for (const module of this.config.modules.values()) if (module.kind !== 'parser') module.reset?.(this.context);
  }

  private legacyTemplate(rest: string): string | null {
    const comma = rest.indexOf(',');
    if (comma < 0) {
      this.reportAt('Invalid config line: could not extract name - line ignored', this.currentLocation);
      return null;
    }
    const name = rest.slice(0, comma).trim();
    const template = parseLegacyTemplate(name, rest.slice(comma + 1), (message) => this.reportAt(message));
    if (template !== null) this.config.templates.set(name, template);
    return '';
  }

  private legacyModLoad(rest: string): string | null {
    const trimmed = rest.trimStart();
    const end = trimmed.search(/\s/);
    const name = end < 0 ? trimmed : trimmed.slice(0, end);
    if (name === '') {
      this.reportAt('could not extract module name');
      return null;
    }
    this.loadModule(name === 'MySQL' ? 'ommysql.so' : name, null);
    return end < 0 ? '' : trimmed.slice(end);
  }

  private setCurrentRuleset(name: string): void {
    const existing = this.config.rulesets.get(name);
    this.currentRuleset = existing ?? this.createRuleset(name);
  }

  private addRulesetParser(name: string): void {
    this.currentRuleset.parserNames = [...(this.currentRuleset.parserNames ?? []), name];
  }

  private moduleFileName(name: string): string {
    return /\.[a-z]+$/.test(name) ? name : `${name}.so`;
  }

  private cnfName(name: string): string {
    return name.replace(/^builtin:/, '').replace(/\.so$/, '');
  }

  private loadBuiltin(name: string): void {
    const module = this.options.catalog.find(name);
    if (module === undefined) return;
    this.config.modules.set(name, module);
    this.loadedNames.add(name);
    if (module.kind !== 'parser') for (const directive of module.directives?.() ?? []) this.registerDirective(directive);
  }

  private loadModule(name: string, params: NvList | null): boolean {
    const cnf = this.cnfName(name);
    const existing = this.config.modules.get(cnf);
    if (existing !== undefined) {
      if (existing.kind !== 'parser' && params !== null) existing.setModuleConfig?.(params, this.context);
      return true;
    }
    const module = this.options.catalog.find(cnf);
    const directory = this.options.catalog.moduleDirectory();
    const fileName = this.moduleFileName(name);
    const path = fileName.startsWith('/') || fileName.startsWith('.') ? fileName : `${directory.replace(/\/?$/, '/')}${fileName}`;
    if (module === undefined || !this.options.catalog.fileExists(fileName)) {
      this.log.error(
        `could not load module '${name}', errors: trying to load module ${path}: ${path}: cannot open shared object file: No such file or directory`,
        RS_RET.MODULE_LOAD_ERR_DLOPEN,
      );
      this.config.hadErrors = true;
      return false;
    }
    this.config.modules.set(cnf, module);
    this.loadedNames.add(cnf);
    if (module.kind === 'parser') return true;
    for (const directive of module.directives?.() ?? []) this.registerDirective(directive);
    if (params !== null && module.setModuleConfig !== undefined && !module.setModuleConfig(params, this.context)) {
      this.log.error(`module '${path}', failed processing config parameters`, RS_RET.ERR);
      return false;
    }
    return true;
  }

  object(object: ConfigObject): void {
    this.currentLocation = object.location;
    reportDuplicates(object.params, (message) => this.reportAt(message, object.location));
    if (isDisabled(object.params)) return;
    switch (object.type) {
      case 'global': this.processGlobal(object); break;
      case 'timezone': this.processTimezone(object); break;
      case 'main_queue': this.processMainQueue(object); break;
      case 'module': this.processModule(object); break;
      case 'input': this.processInput(object); break;
      case 'template': this.processTemplate(object); return;
      case 'ruleset': this.processRuleset(object); break;
      case 'parser': this.processParser(object); break;
      case 'ratelimit': this.processRateLimit(object); break;
      case 'lookup_table': this.processLookupTable(object); break;
      case 'dyn_stats': this.processDynStats(object); break;
      case 'percentile_stats': this.processPercentileStats(object); break;
      default: return;
    }
    reportUnused(object.params, (message) => this.reportAt(message, object.location));
  }

  private processGlobal(object: ConfigObject): void {
    const values = getParams(object.params, GLOBAL_PARAMS, this.paramEnvironment());
    if (values === null) return;
    applyGlobalParams(this.config.settings, values, (message) => this.reportAt(message));
  }

  private processTimezone(object: ConfigObject): void {
    const values = getParams(object.params, TIMEZONE_PARAMS, this.paramEnvironment());
    if (values === null) return;
    const id = stringParam(values, 'id') ?? '';
    const offset = stringParam(values, 'offset') ?? '';
    const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
    if (match === null) {
      this.reportAt(`timezone offset has invalid format. Must be +/-hh:mm, e.g. "-07:00". Offset: ${offset}`);
      return;
    }
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    this.config.timezones.set(id, { offsetMinutes: match[1] === '-' ? -minutes : minutes });
  }

  private processMainQueue(object: ConfigObject): void {
    const values = getParams(object.params, QUEUE_PARAMS, this.paramEnvironment());
    if (values === null) return;
    const settings = this.config.settings;
    Object.assign(settings.mainQueue, defaultQueueSettings('FixedArray', 50000, 'ruleset', { ...settings.queueTimeouts.ruleset }));
    applyQueueParameters(settings.mainQueue, values, this.queueContext('main Q'));
  }

  private processModule(object: ConfigObject): void {
    const values = getParams(object.params, MODULE_PARAMS, this.paramEnvironment());
    if (values === null) {
      this.config.inputDeclarationFailed = true;
      return;
    }
    const name = stringParam(values, 'load');
    if (name === undefined) {
      this.log.error('module type missing', RS_RET.CONF_RQRD_PARAM_MISSING);
      this.config.inputDeclarationFailed = true;
      return;
    }
    if (!this.loadModule(name, object.params)) this.config.inputDeclarationFailed = true;
  }

  private processInput(object: ConfigObject): void {
    const values = getParams(object.params, INPUT_PARAMS, this.paramEnvironment());
    if (values === null) {
      this.config.inputDeclarationFailed = true;
      return;
    }
    const type = stringParam(values, 'type') ?? '';
    const module = this.config.modules.get(type);
    if (module === undefined || module.kind !== 'input') {
      this.log.error(`input module name '${type}' is unknown`, RS_RET.MOD_UNKNOWN);
      this.config.hadErrors = true;
      this.config.inputDeclarationFailed = true;
      return;
    }
    const instances = (module as InputModule).newInstances(object.params, this.inputContext);
    if (instances === null) {
      this.config.hadErrors = true;
      this.config.inputDeclarationFailed = true;
      return;
    }
    for (const instance of instances) this.config.inputs.push({ module: type, instance });
  }

  private processTemplate(object: ConfigObject): void {
    try {
      const template = templateFromObject(
        {
          params: Object.fromEntries(object.params.entries.filter((entry) => !Array.isArray(entry.value)).map((entry) => [entry.name, entry.value as string])),
          entries: (object.subObjects ?? []).map((sub) => ({
            kind: sub.type === 'property' ? 'property' : 'constant',
            params: Object.fromEntries(sub.params.entries.filter((entry) => !Array.isArray(entry.value)).map((entry) => [entry.name, entry.value as string])),
          })),
        },
        (message) => this.reportAt(message, object.location),
      );
      object.params.entries.forEach((entry) => { entry.used = true; });
      for (const sub of object.subObjects ?? []) {
        sub.params.entries.forEach((entry) => { entry.used = true; });
      }
      this.config.templates.set(template.name, template);
    } catch (error) {
      object.params.entries.forEach((entry) => { entry.used = true; });
      const message = error instanceof TemplateError ? error.message : String(error);
      this.log.error(message, RS_RET.ERR);
      this.reportAt('error processing template object', object.location);
    }
  }

  private processRuleset(object: ConfigObject): void {
    const values = getParams(object.params, RULESET_PARAMS, this.paramEnvironment());
    if (values === null) return;
    const name = stringParam(values, 'name') ?? '';
    if (this.config.rulesets.has(name)) {
      this.log.error(`error: ruleset '${name}' specified more than once`, RS_RET.RULESET_EXISTS);
      return;
    }
    const ruleset = this.createRuleset(name);
    ruleset.statements = object.script ?? [];
    const parsers = arrayParam(values, 'parser');
    if (parsers !== undefined) ruleset.parserNames = [...parsers];
    if ([...values.keys()].some((key) => key.startsWith('queue.'))) {
      const queue = defaultQueueSettings('FixedArray', 50000, 'ruleset', { ...this.config.settings.queueTimeouts.ruleset });
      const context = this.queueContext(`ruleset ${name} queue`);
      applyQueueParameters(queue, values, context);
      correctQueueParameters(queue, context);
      ruleset.queue = queue;
    }
  }

  private processParser(object: ConfigObject): void {
    const values = getParams(object.params, [...PARSER_PARAMS, ...RFC3164_PARSER_PARAMS], this.paramEnvironment());
    if (values === null) return;
    const name = stringParam(values, 'name') ?? '';
    const type = stringParam(values, 'type') ?? '';
    if (this.config.parsers.has(name)) {
      this.log.error(`parser module name '${name}' already exists`, RS_RET.ERR);
      return;
    }
    const module = this.config.modules.get(type);
    if (module === undefined || module.kind !== 'parser') {
      this.log.error(`parser module name '${type}' is unknown`, RS_RET.MOD_UNKNOWN);
      return;
    }
    if (type === 'pmrfc3164') {
      const flag = (key: string, fallback: boolean): boolean => {
        const value = values.get(key);
        return value?.kind === 'N' ? value.n !== 0 : fallback;
      };
      const settings: Rfc3164ParserSettings = {
        ...DEFAULT_RFC3164_SETTINGS,
        detectYearAfterTimestamp: flag('detect.yearaftertimestamp', false),
        permitSquareBracketsInHostname: flag('permit.squarebracketsinhostname', false),
        permitSlashesInHostname: flag('permit.slashesinhostname', false),
        permitAtSignsInHostname: flag('permit.atsignsinhostname', false),
        forceTagEndingByColon: flag('force.tagendingbycolon', false),
        removeMsgFirstSpace: flag('remove.msgfirstspace', false),
        detectHeaderless: flag('detect.headerless', false),
        headerlessHostname: stringParam(values, 'headerless.hostname') ?? null,
        headerlessTag: stringParam(values, 'headerless.tag') ?? null,
        dropHeaderless: flag('headerless.drop', false),
        parseHostnameAndTag: this.config.settings.parseHostnameAndTag,
        headerlessRuleset: stringParam(values, 'headerless.ruleset') ?? null,
      };
      this.config.parsers.set(name, new Rfc3164Parser(name, settings));
    } else if (type === 'pmrfc5424') {
      this.config.parsers.set(name, new Rfc5424Parser());
    }
  }

  private findLookupTable(name: string): LookupRef | undefined {
    return this.config.lookupTables.find((table) => table.name === name);
  }

  private processLookupTable(object: ConfigObject): void {
    const values = getParams(object.params, LOOKUP_TABLE_PARAMS, this.paramEnvironment());
    if (values === null) return;
    const name = stringParam(values, 'name');
    const file = stringParam(values, 'file');
    if (name === undefined || file === undefined) return;
    if (this.findLookupTable(name) !== undefined) {
      this.log.error(`lookup_table: duplicate name '${name}' in current config set`, RS_RET.CONFIG_ERROR);
      return;
    }
    const table = new LookupRef(
      name, file, this.options.host.files,
      { error: (text, code, errno) => this.runtimeSink.error(text, code, errno), info: (text) => this.runtimeSink.info(text) },
      { schedule: (callback, delay) => this.options.host.schedule(callback, delay) },
    );
    const reloadOnHup = numberParam(values, 'reloadOnHUP');
    if (reloadOnHup !== undefined) table.reloadOnHup = reloadOnHup !== 0;
    this.config.lookupTables.push(table);
    table.load();
  }

  private processDynStats(object: ConfigObject): void {
    const values = getParams(object.params, DYN_STATS_PARAMS, this.paramEnvironment());
    if (values === null) return;
    const name = stringParam(values, 'name');
    if (name === undefined) return;
    const resettable = numberParam(values, 'resettable');
    this.config.dynStats.create({
      name,
      resettable: resettable === undefined ? true : resettable !== 0,
      maxCardinality: numberParam(values, 'maxCardinality') ?? DEFAULT_MAX_CARDINALITY,
      unusedMetricLifeSeconds: numberParam(values, 'unusedMetricLife') ?? DEFAULT_UNUSED_METRIC_LIFE_SECONDS,
      persistUpdates: numberParam(values, 'persistStateInterval') ?? 0,
      persistSeconds: numberParam(values, 'persistStateTimeInterval') ?? 0,
      stateDirectory: stringParam(values, 'statefile.directory') ?? null,
    });
  }

  private processPercentileStats(object: ConfigObject): void {
    const values = getParams(object.params, PERCENTILE_STATS_PARAMS, this.paramEnvironment());
    if (values === null) return;
    const name = stringParam(values, 'name');
    const requested = arrayParam(values, 'percentiles');
    if (name === undefined || requested === undefined || requested.length === 0) return;
    const percentiles: number[] = [];
    for (const text of requested) {
      const parsed = /^\s*[+-]?\d+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
      if (!(parsed >= 0 && parsed <= 100)) {
        this.log.error(`perctile: percentile value '${text}' is invalid - must be an integer between 0 and 100`, RS_RET.PARAM_ERROR);
        return;
      }
      percentiles.push(parsed);
    }
    const windowSize = numberParam(values, 'windowSize') ?? 0;
    if (windowSize < 2) {
      this.log.error(`percentile_stats: bucket '${name}' needs a windowsize of at least 2 - bucket not created`, RS_RET.CONFIG_ERROR);
      return;
    }
    this.config.percentileStats.create({
      name,
      delimiter: stringParam(values, 'delimiter') ?? '.',
      percentiles,
      windowSize,
    });
  }

  private processRateLimit(object: ConfigObject): void {
    const values = getParams(object.params, RATELIMIT_PARAMS, this.paramEnvironment());
    if (values === null) return;
    const name = stringParam(values, 'name') ?? '';
    const interval = numberParam(values, 'interval');
    const burst = numberParam(values, 'burst');
    const severity = numberParam(values, 'severity');
    const maxStates = numberParam(values, 'perSourceMaxStates');
    const topN = numberParam(values, 'perSourceTopN');
    const perSource = numberParam(values, 'perSource');
    const perSourcePolicy = stringParam(values, 'perSourcePolicy') ?? null;
    const perSourceKeyTemplate = stringParam(values, 'perSourceKeyTpl') ?? null;
    const legacyPerSource = [perSource, perSourcePolicy, perSourceKeyTemplate, maxStates, topN].some((value) => value !== undefined && value !== null);
    if ((maxStates ?? 0) < 0 || (topN ?? 0) < 0) {
      this.log.error(`ratelimit: perSourceMaxStates/perSourceTopN must be >= 0 for '${name}'`, RS_RET.CONFIG_ERROR);
      return;
    }
    if ((interval ?? 0) < 0) {
      this.log.error(`ratelimit: interval must be >= 0 for '${name}'`, RS_RET.CONFIG_ERROR);
      return;
    }
    if ((burst ?? 10000) < 0) {
      this.log.error(`ratelimit: burst must be >= 0 for '${name}'`, RS_RET.CONFIG_ERROR);
      return;
    }
    this.config.rateLimits.add({
      name, interval: interval ?? 0, burst: burst ?? 10000, severity: severity ?? -1, policyFile: stringParam(values, 'policy') ?? null,
      policyWatch: (numberParam(values, 'policyWatch') ?? 0) !== 0, policyWatchDebounce: stringParam(values, 'policyWatchDebounce') ?? null,
      perSource: (perSource ?? 0) !== 0 || perSourcePolicy !== null, perSourcePolicyFile: perSourcePolicy, perSourceKeyTemplate,
      perSourceMaxStates: maxStates ?? 0, perSourceTopN: topN ?? 0,
      hasInlinePolicyParams: [interval, burst, severity].some((value) => value !== undefined && value !== null), hasLegacyPerSourceParams: legacyPerSource,
    });
  }

  script(statements: Stmt[]): void {
    for (const statement of statements) this.currentRuleset.statements.push(statement);
  }

  cfsysline(line: string): void {
    if (!this.permitCompatSyntax(this.config.settings.compatConfigFormat.legacy, '$-directive', line, 'compatibility.configformat.legacy')) return;
    this.runDirective(line.slice(1));
  }

  private permitCompatSyntax(mode: CompatMode, kind: string, text: string, option: string): boolean {
    if (mode === 'warn') this.warnAt(`obsolete ${kind} syntax encountered: '${text}'`);
    else if (mode === 'disable') {
      this.reportAt(`obsolete ${kind} syntax disabled: '${text}'; use global(${option}="enable") to enable it`);
      return false;
    }
    return true;
  }

  legacyRuleset(line: string): void {
    this.runDirective(line.slice(1));
  }

  private runDirective(text: string): void {
    const match = /^(\S+)\s*(.*)$/s.exec(text);
    if (match === null) {
      this.reportAt('Invalid $-configline - could not extract command - line ignored\n');
      return;
    }
    const name = match[1].toLowerCase();
    const registration = this.directives.get(name);
    if (registration === undefined) {
      this.log.error(`invalid or yet-unknown config file command '${match[1]}' - have you forgotten to load a module?`, RS_RET.NOT_FOUND);
      this.config.hadErrors = true;
      return;
    }
    const rest = applyDirective(registration, match[2], {
      context: this.inputContext,
      report: (message) => { this.log.error(message, RS_RET.ERR); this.config.hadErrors = true; },
      warn: (message) => this.warnAt(message),
      uidOf: (user) => this.options.host.users.uidOf(user),
      gidOf: (group) => this.options.host.users.gidOf(group),
      unresolvedId: (message) => {
        if (this.config.settings.abortOnIdResolutionFail) {
          this.config.fatalConfigError ??= message;
          return;
        }
        this.log.error(message, RS_RET.NOT_FOUND);
        this.config.hadErrors = true;
      },
    });
    if (rest === null) return;
    const remainder = rest.trim();
    if (remainder !== '' && !remainder.startsWith('#')) this.log.error(`error: extra characters in config line ignored: '${remainder}'`, RS_RET.NO_ERRCODE);
  }

  bsdTag(line: string): void {
    this.bsdBlock(line);
  }

  bsdHost(line: string): void {
    this.bsdBlock(line);
  }

  private bsdBlock(line: string): void {
    this.log.error(
      `BSD-style blocks are no longer supported in rsyslog, see https://www.rsyslog.com/g/BSD for details and a solution (Block '${line}')`,
      -2262,
    );
    this.config.hadErrors = true;
  }

  includeConfig(path: string): void {
    this.includePath(path, false);
  }

  include(params: NvList): void {
    const values = getParams(params, INCLUDE_PARAMS, this.paramEnvironment());
    if (values === null) return;
    reportUnused(params, (message) => this.reportAt(message));
    const file = stringParam(values, 'file');
    const text = stringParam(values, 'text');
    const mode = stringParam(values, 'mode');
    const optional = mode === 'optional';
    if (mode !== undefined && !['abort-if-missing', 'required', 'optional'].includes(mode)) this.reportAt(`invalid 'mode' parameter: '${mode}' - ignored`);
    if (file !== undefined && text !== undefined) {
      this.reportAt("include() must have either 'file' or 'text' parameter, but both are set - ignored");
      return;
    }
    if (file !== undefined) {
      const failed = this.includePath(file, optional);
      if (failed && mode === 'abort-if-missing') {
        this.log.error(`include file '${file}' mode is set to abort-if-missing and the file is indeed missing - thus aborting rsyslog`, RS_RET.NO_ERRCODE);
        this.config.hadErrors = true;
      }
    } else if (text !== undefined) {
      this.scanner.pushText(text, 'text');
    } else this.reportAt("include must have either 'file' or 'text' parameter - ignored");
  }

  private includePath(name: string, optional: boolean): boolean {
    const files = this.options.host.files;
    let target = name;
    if (files.isDirectory(name)) target = name.endsWith('/') ? `${name}*` : `${name}*`;
    const hasWildcard = /[*?[]/.test(target);
    const matches = files.glob(target);
    if (matches.length === 0) {
      if (hasWildcard) return false;
      if (!optional) {
        this.reportAt(`error accessing config file or directory '${target}' [cwd:/]: No such file or directory`);
        return true;
      }
      return false;
    }
    for (const path of [...matches].reverse()) {
      if (files.isDirectory(path)) {
        this.includePath(path, optional);
        continue;
      }
      if (this.scanner.isOpen(path)) {
        this.reportAt(`trying to include file '${path}', which is already included - ignored`);
        continue;
      }
      const text = files.read(path);
      if (text === null) {
        if (!optional) {
          this.reportAt(`error accessing config file or directory '${path}' [cwd: /]: Permission denied`);
          return true;
        }
        continue;
      }
      this.scanner.pushText(text, path);
    }
    return false;
  }

  private actionOptions(values: ParamValues | null): ActionOptions {
    const legacy = this.legacy;
    const options: ActionOptions = {
      name: legacy.name,
      resumeInterval: legacy.resumeInterval,
      resumeIntervalMax: 1800,
      resumeRetryCount: legacy.resumeRetryCount,
      writeAllMarkMessages: legacy.writeAllMarkMessages,
      execOnlyWhenPreviousIsSuspended: legacy.execOnlyWhenPreviousIsSuspended,
      execOnlyOnceEveryInterval: legacy.execOnlyOnceEveryInterval,
      execOnlyEveryNthTime: legacy.execOnlyEveryNthTime,
      execOnlyEveryNthTimeTimeout: legacy.execOnlyEveryNthTimeTimeout,
      repeatedMessageContainsOriginalMessage: legacy.repeatedMessageContainsOriginalMessage,
      reportSuspension: this.config.settings.actionReportSuspension,
      reportSuspensionContinuation: this.config.settings.actionReportSuspensionContinuation,
      copyMessage: false,
      errorFile: null,
      errorFileMaxSize: 0,
      externalStateFile: null,
      rateLimitName: null,
      queue: values === null ? this.legacyQueueWithDefaults() : defaultQueueSettings('Direct', 1000, 'action', { ...this.config.settings.queueTimeouts.action }),
    };
    if (values === null) {
      legacy.execOnlyEveryNthTime = 0;
      legacy.execOnlyEveryNthTimeTimeout = 0;
      legacy.writeAllMarkMessages = true;
      legacy.name = null;
      legacy.queue = defaultQueueSettings('Direct', 1000);
      legacy.explicitTimeouts = new Set();
      return options;
    }
    const flag = (key: string): boolean | undefined => {
      const value = values.get(key);
      return value?.kind === 'N' ? value.n !== 0 : undefined;
    };
    options.name = stringParam(values, 'name') ?? null;
    options.errorFile = stringParam(values, 'action.errorfile') ?? null;
    options.errorFileMaxSize = numberParam(values, 'action.errorfile.maxsize') ?? 0;
    options.writeAllMarkMessages = flag('action.writeallmarkmessages') ?? true;
    options.execOnlyEveryNthTime = numberParam(values, 'action.execonlyeverynthtime') ?? 0;
    options.execOnlyEveryNthTimeTimeout = numberParam(values, 'action.execonlyeverynthtimetimeout') ?? 0;
    options.execOnlyOnceEveryInterval = numberParam(values, 'action.execonlyonceeveryinterval') ?? 0;
    options.execOnlyWhenPreviousIsSuspended = flag('action.execonlywhenpreviousissuspended') ?? false;
    options.repeatedMessageContainsOriginalMessage = flag('action.repeatedmsgcontainsoriginalmsg') ?? false;
    options.resumeRetryCount = numberParam(values, 'action.resumeretrycount') ?? options.resumeRetryCount;
    options.reportSuspension = flag('action.reportsuspension') ?? options.reportSuspension;
    options.reportSuspensionContinuation = flag('action.reportsuspensioncontinuation') ?? options.reportSuspensionContinuation;
    options.resumeIntervalMax = numberParam(values, 'action.resumeintervalmax') ?? options.resumeIntervalMax;
    options.resumeInterval = numberParam(values, 'action.resumeinterval') ?? options.resumeInterval;
    options.externalStateFile = stringParam(values, 'action.externalstate.file') ?? null;
    options.rateLimitName = stringParam(values, 'action.ratelimit.name') ?? null;
    options.copyMessage = flag('action.copymsg') ?? false;
    return options;
  }

  private bindAction(instance: ActionModuleInstance, options: ActionOptions, module: OutputModule, values: ParamValues | null = null): ActionDefinition | null {
    const templates = [];
    for (const [index, request] of instance.templates.entries()) {
      if (request.asMessage === true) {
        templates.push({ request, template: null });
        continue;
      }
      const template = this.config.templates.get(request.name);
      if (template === undefined) {
        this.log.error(` Could not find template ${index} '${request.name}' - action disabled`, RS_RET.NOT_FOUND);
        this.config.hadErrors = true;
        return null;
      }
      if (request.requireSql === true && template.escape === 'none') {
        this.log.error('Action disabled. To use this action, you have to specify the SQL or stdSQL option in your template!\n', -2008);
        this.config.hadErrors = true;
        return null;
      }
      templates.push({ request, template });
    }
    const moduleDisplayName = module.builtin ? `builtin:${module.name}` : module.name;
    const queueContext = this.queueContext(`${options.name ?? `action-${this.nextActionId}-${moduleDisplayName}`} queue`);
    if (values !== null) {
      options.queue = defaultQueueSettings('Direct', 1000, 'action', { ...this.config.settings.queueTimeouts.action });
      applyQueueParameters(options.queue, new Map([...values].filter(([key]) => key.startsWith('queue.'))), queueContext);
    }
    correctQueueParameters(options.queue, queueContext);
    let outputLimiter: ActionRateLimit | null = null;
    if (options.rateLimitName !== null) {
      outputLimiter = this.createOutputRateLimiter(options.rateLimitName, options.name ?? `action-${this.nextActionId - 1}-${moduleDisplayName}`, options.queue.type === 'Direct');
      if (outputLimiter === null) {
        this.config.hadErrors = true;
        return null;
      }
    }
    const definition: ActionDefinition = { id: this.nextActionId++, instance, templates, options, moduleDisplayName, outputLimiter };
    this.config.actions.push(definition);
    return definition;
  }

  newAction(params: NvList, location: Location): Stmt {
    this.currentLocation = location;
    reportDuplicates(params, (message) => this.reportAt(message, location));
    if (isDisabled(params)) return { k: 'nop' };
    const values = getParams(params, ACTION_PARAMS, this.paramEnvironment());
    if (values === null) {
      this.reportAt(`errors occurred in file '${location.file}' around line ${location.line}`, location);
      return { k: 'nop' };
    }
    const type = stringParam(values, 'type') ?? '';
    const module = this.config.modules.get(type);
    if (module === undefined || module.kind !== 'output') {
      this.log.error(`module name '${type}' is unknown`, RS_RET.MOD_UNKNOWN);
      this.config.hadErrors = true;
      this.reportAt(`errors occurred in file '${location.file}' around line ${location.line}`, location);
      return { k: 'nop' };
    }
    const options = this.actionOptions(values);
    const instance = (module as OutputModule).newActionInstance(params, this.context);
    if (instance === null) {
      this.reportAt(`errors occurred in file '${location.file}' around line ${location.line}`, location);
      return { k: 'nop' };
    }
    const definition = this.bindAction(instance, options, module as OutputModule, values);
    if (definition === null) {
      this.reportAt(`errors occurred in file '${location.file}' around line ${location.line}`, location);
      return { k: 'nop' };
    }
    reportUnused(params, (message) => this.reportAt(message, location));
    return { k: 'act', action: definition, printable: `action(type="${type}" ...)` };
  }

  newLegacyAction(line: string, location: Location): Stmt {
    this.currentLocation = location;
    for (const module of this.config.modules.values()) {
      if (module.kind !== 'output' || module.parseSelector === undefined) continue;
      const parsed = module.parseSelector(line, this.context);
      if (parsed.status === 'unprocessed') continue;
      if (parsed.status === 'error') {
        this.reportAt(`errors occurred in file '${location.file}' around line ${location.line}`, location);
        return { k: 'nop' };
      }
      const definition = this.bindAction(parsed.instance, this.actionOptions(null), module);
      if (definition === null) {
        this.reportAt(`errors occurred in file '${location.file}' around line ${location.line}`, location);
        return { k: 'nop' };
      }
      if (parsed.warning !== undefined) this.warnAt(parsed.warning, location);
      return { k: 'act', action: definition, printable: line };
    }
    this.reportAt(`errors occurred in file '${location.file}' around line ${location.line}`, location);
    return { k: 'nop' };
  }

  newPriorityFilter(text: string, then: Stmt[], location: Location): Stmt {
    this.currentLocation = location;
    if (!this.permitCompatSyntax(this.config.settings.compatConfigFormat.syslogd, 'classic syslogd filter', text, 'compatibility.configformat.syslogd')) return { k: 'nop' };
    const mask = decodePriorityFilter(text, (message) => this.log.error(message, RS_RET.ERR));
    if (mask === null) {
      this.config.hadErrors = true;
      return { k: 'nop' };
    }
    return { k: 'prifilt', printable: text, mask, then };
  }

  newPropertyFilter(text: string, then: Stmt[], location: Location): Stmt {
    this.currentLocation = location;
    if (!this.permitCompatSyntax(this.config.settings.compatConfigFormat.property, 'classic property-based filter', text, 'compatibility.configformat.property')) return { k: 'nop' };
    const decoded = decodePropertyFilter(text, (message) => this.reportAt(message, location));
    if (decoded === null) return { k: 'nop' };
    return { k: 'propfilt', printable: text, prop: decoded.prop, operation: decoded.operation, negated: decoded.negated, value: decoded.value, then };
  }

  newCall(name: string): Stmt {
    this.pendingCalls.push({ name, location: this.currentLocation });
    return { k: 'call', name };
  }

  checkFunction(name: string, argumentCount: number, location: Location, expression: Expr): void {
    const problem = checkFunctionCall(name, argumentCount);
    if (problem !== null) {
      this.reportAt(problem, location);
      return;
    }
    if (name === 'lookup' && expression.k === 'func') this.resolveLookupFunction(expression, location);
    if (name === 'dyn_inc' && expression.k === 'func') this.resolveDynStatsFunction(expression, location);
    if (name === 'percentile_observe' && expression.k === 'func') this.resolvePercentileFunction(expression, location);
  }

  private resolvePercentileFunction(expression: Extract<Expr, { k: 'func' }>, location: Location): void {
    const first = expression.args[0];
    if (first.k !== 'str') {
      this.reportAt('percentile-stats bucket-name (param 1) of perctile-stats manipulating functions like percentile_observe must be a constant string', location);
      return;
    }
    const bucket = this.config.percentileStats.find(first.value);
    if (bucket === undefined) {
      this.reportAt(`perctile-stats bucket '${first.value}' not found`, location);
      return;
    }
    bindFunctionData(expression, bucket);
  }

  private resolveDynStatsFunction(expression: Extract<Expr, { k: 'func' }>, location: Location): void {
    const first = expression.args[0];
    if (first.k !== 'str') {
      this.reportAt('dyn-stats bucket-name (param 1) of dyn-stats manipulating functions like dyn_inc must be a constant string', location);
      return;
    }
    const bucket = this.config.dynStats.find(first.value);
    if (bucket === undefined) {
      this.reportAt(`dyn-stats bucket '${first.value}' not found`, location);
      return;
    }
    bindFunctionData(expression, bucket);
  }

  private resolveLookupFunction(expression: Extract<Expr, { k: 'func' }>, location: Location): void {
    const first = expression.args[0];
    if (first.k !== 'str') {
      this.reportAt('table name (param 1) of lookup() must be a constant string', location);
      return;
    }
    const table = this.findLookupTable(first.value);
    if (table === undefined) {
      this.reportAt(`lookup table '${first.value}' not found (used in function: lookup)`, location);
      return;
    }
    bindFunctionData(expression, table);
  }

  private checkReloadLookupStatement(statement: Extract<Stmt, { k: 'reloadLookupTable' }>): Stmt | null {
    const usage = 'statement ignored: reload_lookup_table(table_name, optional:stub_value_in_case_reload_fails) ';
    const args = statement.args;
    if (args.length !== 1 && args.length !== 2) {
      this.reportAt(`${usage}expected 1 or 2 arguments, but found '${args.length}'\n`);
      return null;
    }
    let failed = false;
    let stub: string | null = null;
    if (args.length === 2) {
      if (args[1].k !== 'str') {
        this.reportAt(`${usage}expects a litteral string for second argument\n`);
        failed = true;
      } else stub = args[1].value;
    }
    if (args[0].k !== 'str') {
      this.reportAt(`${usage}expects a litteral string for first argument\n`);
      failed = true;
    }
    if (failed || args[0].k !== 'str') return null;
    if (this.findLookupTable(args[0].value) === undefined) this.reportAt(`lookup table '${args[0].value}' not found\n`);
    return { k: 'reloadLookupTable', args, table: args[0].value, stub };
  }

  report(diagnostic: Diagnostic): void {
    this.takeScannerDiagnostic(diagnostic);
  }

  private prepareStatements(statements: Stmt[]): Stmt[] {
    const result: Stmt[] = [];
    for (const statement of statements) {
      switch (statement.k) {
        case 'nop': break;
        case 'reloadLookupTable': {
          const checked = this.checkReloadLookupStatement(statement);
          if (checked !== null) result.push(checked);
          break;
        }
        case 'if': {
          prepareFunctions(statement.expr, (message) => this.reportAt(message));
          result.push({ ...statement, then: this.prepareStatements(statement.then), else: statement.else === null ? null : this.prepareStatements(statement.else) });
          break;
        }
        case 'foreach':
          prepareFunctions(statement.collection, (message) => this.reportAt(message));
          result.push({ ...statement, body: this.prepareStatements(statement.body) });
          break;
        case 'set':
          prepareFunctions(statement.expr, (message) => this.reportAt(message));
          result.push(statement);
          break;
        case 'callIndirect':
          prepareFunctions(statement.expr, (message) => this.reportAt(message));
          result.push(statement);
          break;
        case 'prifilt':
        case 'propfilt':
          result.push({ ...statement, then: this.prepareStatements(statement.then) });
          break;
        case 'call':
          if (!this.config.rulesets.has(statement.name)) {
            this.reportAt(`ruleset '${statement.name}' cannot be found\n`);
            break;
          }
          result.push(statement);
          break;
        case 'act':
          result.push((statement.action as ActionDefinition).instance.moduleName === 'omdiscard' ? { k: 'stop' } : statement);
          break;
        case 'stop':
          result.push(statement);
          if (statements.indexOf(statement) < statements.length - 1) this.warnAt('STOP is followed by unreachable statements!\n');
          break;
        default: result.push(statement);
      }
    }
    return result;
  }

  loadFile(path: string): LoadedConfig {
    const text = this.options.host.files.read(path);
    if (text === null) {
      this.log.error(`could not open config file '${path}': No such file or directory`, RS_RET.CONF_FILE_NOT_FOUND);
      this.config.hadErrors = true;
      return this.config;
    }
    this.scanner.pushText(text, path);
    const parser = new ConfigParser(this.scanner, this);
    const ok = parser.parse();
    for (const ruleset of this.config.rulesets.values()) ruleset.statements = this.prepareStatements(ruleset.statements);
    for (const [name, module] of this.config.modules) {
      if (module.kind !== 'input') continue;
      for (const instance of module.implicitInstances?.(this.inputContext) ?? []) this.config.inputs.push({ module: name, instance });
    }
    for (const record of this.config.inputs) record.instance.check?.();
    for (const [name, module] of this.config.modules) {
      if (module.kind === 'input') module.check?.(this.config.inputs.filter((record) => record.module === name).length, this.context);
    }
    if (!ok) {
      this.log.error(`could not interpret master config file '${path}'.`, RS_RET.CONF_PARSE_ERROR);
      this.config.hadErrors = true;
    } else if (this.config.actions.length === 0 && this.options.partialConfig !== true) {
      this.log.error('there are no active actions configured. Inputs would run, but no output whatsoever were created.', RS_RET.NO_ACTIONS);
      this.config.hadErrors = true;
    }
    return this.config;
  }
}

function queueTypeName(value: string): string | undefined {
  const map: Record<string, string> = { fixedarray: 'FixedArray', linkedlist: 'LinkedList', disk: 'Disk', direct: 'Direct', segmenteddisk: 'SegmentedDisk' };
  return map[value.toLowerCase()];
}

export type { Template };
