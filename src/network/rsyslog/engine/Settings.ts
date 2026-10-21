import { AllowedSenderList } from './AllowedSenders';
import { DEFAULT_PARSER_GLOBALS, type ParserGlobals } from '../MessageParser';
import type { ParamDescriptor, ParamValue, ParamValues } from '../config/Params';

export interface QueueSettings {
  type: string;
  size: number;
  fileName: string | null;
  highWatermark: number | null;
  lowWatermark: number | null;
  discardMark: number | null;
  discardSeverity: number;
  checkpointInterval: number;
  syncQueueFiles: boolean;
  workerThreads: number;
  timeoutShutdown: number;
  timeoutActionCompletion: number;
  timeoutEnqueue: number;
  workerTimeoutThreadShutdown: number;
  dequeueSlowdown: number;
  workerThreadMinimumMessages: number | null;
  maxFileSize: number;
  dequeueBatchSize: number;
  maxDiskSpace: number;
  saveOnShutdown: boolean;
  dequeueTimeBegin: number;
  dequeueTimeEnd: number;
}

export function defaultQueueSettings(type: string, size: number): QueueSettings {
  return {
    type, size, fileName: null, highWatermark: null, lowWatermark: null, discardMark: null, discardSeverity: 8,
    checkpointInterval: 0, syncQueueFiles: false, workerThreads: 1, timeoutShutdown: 1500, timeoutActionCompletion: 1000,
    timeoutEnqueue: 2000, workerTimeoutThreadShutdown: 60000, dequeueSlowdown: 0, workerThreadMinimumMessages: null,
    maxFileSize: 1024 * 1024, dequeueBatchSize: type === 'Direct' ? 1 : 128, maxDiskSpace: 0, saveOnShutdown: true,
    dequeueTimeBegin: 0, dequeueTimeEnd: 25,
  };
}

export interface GlobalSettings {
  parser: ParserGlobals;
  parseHostnameAndTag: boolean;
  workDirectory: string | null;
  localHostNameOverride: string | null;
  preserveFqdn: boolean;
  umask: number | null;
  repeatedMessageReduction: boolean;
  variablesCaseSensitive: boolean;
  actionReportSuspension: boolean;
  actionReportSuspensionContinuation: boolean;
  processInternalMessages: boolean;
  logStatusMessages: boolean;
  environment: Record<string, string>;
  defaultNetstreamDriver: string | null;
  defaultNetstreamDriverCaFile: string | null;
  defaultNetstreamDriverCertFile: string | null;
  defaultNetstreamDriverKeyFile: string | null;
  defaultNetstreamDriverCrlFile: string | null;
  netstreamDriverCaExtraFiles: string | null;
  dropMessagesWithMaliciousDnsPtrRecords: boolean;
  abortOnUncleanConfig: boolean;
  compatDefaultsSecure: 'backward-compatible' | 'strict' | 'warn';
  ipProtocol: 'unspecified' | 'ipv4-only' | 'ipv6-only';
  supportCompressionExtension: boolean;
  markIntervalSeconds: number;
  internalMessages: { severityFilter: number; rateInterval: number; rateBurst: number };
  disableDns: boolean;
  dnsCache: { enableTtl: boolean; defaultTtlSeconds: number };
  aclDontResolve: boolean;
  aclAddHostnameOnFail: boolean;
  allowedSenders: { udp: AllowedSenderList; tcp: AllowedSenderList };
  janitorInterval: number;
  senders: { reportNew: boolean; reportGoneAway: boolean; timeoutAfter: number; keepTrack: boolean };
  compactJson: boolean;
  mainQueue: QueueSettings;
  defaultRuleset: string;
  maxOpenFiles: number | null;
  requireAllInputs: boolean;
  oversize: { errorFile: string | null; report: boolean; mode: 'truncate' | 'split' | 'accept' };
  privDrop: { uid: number; gid: number; keepSupplemental: boolean };
  extra: Map<string, ParamValue>;
}

export function defaultGlobalSettings(): GlobalSettings {
  return {
    parser: { ...DEFAULT_PARSER_GLOBALS },
    parseHostnameAndTag: true,
    workDirectory: null,
    localHostNameOverride: null,
    preserveFqdn: false,
    umask: null,
    repeatedMessageReduction: false,
    variablesCaseSensitive: false,
    actionReportSuspension: true,
    actionReportSuspensionContinuation: false,
    processInternalMessages: false,
    logStatusMessages: true,
    environment: {},
    defaultNetstreamDriver: null,
    defaultNetstreamDriverCaFile: null,
    defaultNetstreamDriverCertFile: null,
    defaultNetstreamDriverKeyFile: null,
    defaultNetstreamDriverCrlFile: null,
    netstreamDriverCaExtraFiles: null,
    dropMessagesWithMaliciousDnsPtrRecords: false,
    abortOnUncleanConfig: false,
    compatDefaultsSecure: 'backward-compatible',
    ipProtocol: 'unspecified',
    supportCompressionExtension: true,
    markIntervalSeconds: 20 * 60,
    internalMessages: { severityFilter: 6, rateInterval: 60, rateBurst: 100 },
    disableDns: false,
    dnsCache: { enableTtl: false, defaultTtlSeconds: 24 * 60 * 60 },
    aclDontResolve: false,
    aclAddHostnameOnFail: false,
    allowedSenders: { udp: new AllowedSenderList(), tcp: new AllowedSenderList() },
    janitorInterval: 10,
    senders: { reportNew: false, reportGoneAway: false, timeoutAfter: 12 * 60 * 60, keepTrack: false },
    compactJson: false,
    mainQueue: defaultQueueSettings('FixedArray', 100000),
    defaultRuleset: 'RSYSLOG_DefaultRuleset',
    maxOpenFiles: null,
    requireAllInputs: false,
    oversize: { errorFile: null, report: true, mode: 'truncate' },
    privDrop: { uid: 0, gid: 0, keepSupplemental: false },
    extra: new Map(),
  };
}

export const GLOBAL_PARAMS: readonly ParamDescriptor[] = [
  { name: 'workdirectory', type: 'string' }, { name: 'operatingstatefile', type: 'string' },
  { name: 'dropmsgswithmaliciousdnsptrrecords', type: 'binary' }, { name: 'localhostname', type: 'word' },
  { name: 'compactjsonstring', type: 'binary' }, { name: 'preservefqdn', type: 'binary' },
  { name: 'debug.onshutdown', type: 'binary' }, { name: 'debug.logfile', type: 'string' }, { name: 'debug.gnutls', type: 'nonneg' },
  { name: 'debug.abortonprogramerror', type: 'binary' }, { name: 'debug.unloadmodules', type: 'binary' },
  { name: 'defaultnetstreamdrivercafile', type: 'string' }, { name: 'defaultnetstreamdrivercrlfile', type: 'string' },
  { name: 'defaultnetstreamdriverkeyfile', type: 'string' }, { name: 'defaultnetstreamdrivercertfile', type: 'string' },
  { name: 'defaultnetstreamdriver', type: 'string' }, { name: 'defaultopensslengine', type: 'string' },
  { name: 'netstreamdrivercaextrafiles', type: 'string' }, { name: 'maxmessagesize', type: 'size' },
  { name: 'oversizemsg.errorfile', type: 'word' }, { name: 'oversizemsg.report', type: 'binary' },
  { name: 'oversizemsg.input.mode', type: 'word' }, { name: 'reportchildprocessexits', type: 'word' },
  { name: 'action.reportsuspension', type: 'binary' }, { name: 'action.reportsuspensioncontinuation', type: 'binary' },
  { name: 'parser.controlcharacterescapeprefix', type: 'char' }, { name: 'parser.droptrailinglfonreception', type: 'binary' },
  { name: 'parser.droptrailingcronreception', type: 'binary' }, { name: 'parser.escapecontrolcharactersonreceive', type: 'binary' },
  { name: 'parser.spacelfonreceive', type: 'binary' }, { name: 'parser.escape8bitcharactersonreceive', type: 'binary' },
  { name: 'parser.escapecontrolcharactertab', type: 'binary' }, { name: 'parser.escapecontrolcharacterscstyle', type: 'binary' },
  { name: 'parser.parsehostnameandtag', type: 'binary' }, { name: 'parser.permitslashinprogramname', type: 'binary' },
  { name: 'stdlog.channelspec', type: 'string' }, { name: 'janitor.interval', type: 'positive' },
  { name: 'senders.reportnew', type: 'binary' }, { name: 'senders.reportgoneaway', type: 'binary' },
  { name: 'senders.timeoutafter', type: 'positive' }, { name: 'senders.keeptrack', type: 'binary' },
  { name: 'inputs.timeout.shutdown', type: 'positive' }, { name: 'privdrop.group.keepsupplemental', type: 'binary' },
  { name: 'privdrop.group.id', type: 'positive' }, { name: 'privdrop.group.name', type: 'gid' },
  { name: 'privdrop.user.id', type: 'positive' }, { name: 'privdrop.user.name', type: 'uid' },
  { name: 'net.ipprotocol', type: 'word' }, { name: 'net.acladdhostnameonfail', type: 'binary' },
  { name: 'net.aclresolvehostname', type: 'binary' }, { name: 'net.enabledns', type: 'binary' },
  { name: 'net.permitaclwarning', type: 'binary' }, { name: 'maxopenfiles', type: 'positive' },
  { name: 'compatibility.configformat.legacy', type: 'word' }, { name: 'compatibility.configformat.syslogd', type: 'word' },
  { name: 'compatibility.configformat.property', type: 'word' }, { name: 'compatibility.defaults.secure', type: 'word' },
  { name: 'systemd.notifyreadydelay', type: 'binary' }, { name: 'abortonuncleanconfig', type: 'binary' },
  { name: 'inputstartuppolicy', type: 'word' }, { name: 'abortonfailedqueuestartup', type: 'binary' },
  { name: 'variables.casesensitive', type: 'binary' }, { name: 'environment', type: 'array' },
  { name: 'processinternalmessages', type: 'binary' }, { name: 'umask', type: 'filemode' },
  { name: 'security.abortonidresolutionfail', type: 'binary' }, { name: 'internal.developeronly.options', type: 'int' },
  { name: 'internalmsg.ratelimit.interval', type: 'positive' }, { name: 'internalmsg.ratelimit.burst', type: 'positive' },
  { name: 'internalmsg.severity', type: 'severity' }, { name: 'allmessagestostderr', type: 'binary' },
  { name: 'errormessagestostderr.maxnumber', type: 'positive' }, { name: 'shutdown.enable.ctlc', type: 'binary' },
  { name: 'default.action.queue.timeoutshutdown', type: 'int' }, { name: 'default.action.queue.timeoutactioncompletion', type: 'int' },
  { name: 'default.action.queue.timeoutenqueue', type: 'int' }, { name: 'default.action.queue.timeoutworkerthreadshutdown', type: 'int' },
  { name: 'default.ruleset.queue.timeoutshutdown', type: 'int' }, { name: 'default.ruleset.queue.timeoutactioncompletion', type: 'int' },
  { name: 'default.ruleset.queue.timeoutenqueue', type: 'int' }, { name: 'default.ruleset.queue.timeoutworkerthreadshutdown', type: 'int' },
  { name: 'reverselookup.cache.ttl.default', type: 'nonneg' }, { name: 'reverselookup.cache.ttl.enable', type: 'binary' },
  { name: 'parser.supportcompressionextension', type: 'binary' }, { name: 'shutdown.queue.doublesize', type: 'binary' },
  { name: 'debug.files', type: 'array' }, { name: 'debug.whitelist', type: 'binary' },
  { name: 'libcapng.default', type: 'binary' }, { name: 'libcapng.enable', type: 'binary' },
];

function str(values: ParamValues, name: string): string | undefined {
  const value = values.get(name);
  return value?.kind === 'S' ? value.s : undefined;
}

function flag(values: ParamValues, name: string): boolean | undefined {
  const value = values.get(name);
  return value?.kind === 'N' ? value.n !== 0 : undefined;
}

function count(values: ParamValues, name: string): number | undefined {
  const value = values.get(name);
  return value?.kind === 'N' ? value.n : undefined;
}

export function clampMaxLine(requested: number, report: (message: string) => void): number {
  if (requested < 128) {
    report(`maxMessageSize tried to set to ${requested}, but cannot be less than 128 - set to 128 instead`);
    return 128;
  }
  if (requested > 2147483647) {
    report('maxMessageSize larger than INT_MAX (2147483647) - reduced to INT_MAX');
    return 2147483647;
  }
  return requested;
}

export function applyGlobalParams(settings: GlobalSettings, values: ParamValues, report: (message: string) => void): void {
  const parser = settings.parser;
  for (const [name, value] of values) settings.extra.set(name, value);
  settings.workDirectory = str(values, 'workdirectory') ?? settings.workDirectory;
  settings.localHostNameOverride = str(values, 'localhostname') ?? settings.localHostNameOverride;
  settings.preserveFqdn = flag(values, 'preservefqdn') ?? settings.preserveFqdn;
  settings.compactJson = flag(values, 'compactjsonstring') ?? settings.compactJson;
  settings.dropMessagesWithMaliciousDnsPtrRecords = flag(values, 'dropmsgswithmaliciousdnsptrrecords') ?? settings.dropMessagesWithMaliciousDnsPtrRecords;
  settings.defaultNetstreamDriver = str(values, 'defaultnetstreamdriver') ?? settings.defaultNetstreamDriver;
  settings.defaultNetstreamDriverCaFile = str(values, 'defaultnetstreamdrivercafile') ?? settings.defaultNetstreamDriverCaFile;
  settings.defaultNetstreamDriverCertFile = str(values, 'defaultnetstreamdrivercertfile') ?? settings.defaultNetstreamDriverCertFile;
  settings.defaultNetstreamDriverKeyFile = str(values, 'defaultnetstreamdriverkeyfile') ?? settings.defaultNetstreamDriverKeyFile;
  settings.defaultNetstreamDriverCrlFile = str(values, 'defaultnetstreamdrivercrlfile') ?? settings.defaultNetstreamDriverCrlFile;
  settings.netstreamDriverCaExtraFiles = str(values, 'netstreamdrivercaextrafiles') ?? settings.netstreamDriverCaExtraFiles;
  const maxLine = count(values, 'maxmessagesize');
  if (maxLine !== undefined) parser.maxLine = clampMaxLine(maxLine, report);
  parser.controlCharacterEscapePrefix = str(values, 'parser.controlcharacterescapeprefix') ?? parser.controlCharacterEscapePrefix;
  parser.dropTrailingLFOnReception = flag(values, 'parser.droptrailinglfonreception') ?? parser.dropTrailingLFOnReception;
  parser.dropTrailingCROnReception = flag(values, 'parser.droptrailingcronreception') ?? parser.dropTrailingCROnReception;
  parser.escapeControlCharactersOnReceive = flag(values, 'parser.escapecontrolcharactersonreceive') ?? parser.escapeControlCharactersOnReceive;
  parser.spaceLFOnReceive = flag(values, 'parser.spacelfonreceive') ?? parser.spaceLFOnReceive;
  parser.escape8BitCharactersOnReceive = flag(values, 'parser.escape8bitcharactersonreceive') ?? parser.escape8BitCharactersOnReceive;
  parser.escapeControlCharacterTab = flag(values, 'parser.escapecontrolcharactertab') ?? parser.escapeControlCharacterTab;
  parser.escapeControlCharactersCStyle = flag(values, 'parser.escapecontrolcharacterscstyle') ?? parser.escapeControlCharactersCStyle;
  parser.permitSlashInProgramname = flag(values, 'parser.permitslashinprogramname') ?? parser.permitSlashInProgramname;
  settings.parseHostnameAndTag = flag(values, 'parser.parsehostnameandtag') ?? settings.parseHostnameAndTag;
  settings.actionReportSuspension = flag(values, 'action.reportsuspension') ?? settings.actionReportSuspension;
  settings.actionReportSuspensionContinuation = flag(values, 'action.reportsuspensioncontinuation') ?? settings.actionReportSuspensionContinuation;
  settings.processInternalMessages = flag(values, 'processinternalmessages') ?? settings.processInternalMessages;
  settings.variablesCaseSensitive = flag(values, 'variables.casesensitive') ?? settings.variablesCaseSensitive;
  settings.abortOnUncleanConfig = flag(values, 'abortonuncleanconfig') ?? settings.abortOnUncleanConfig;
  settings.aclAddHostnameOnFail = flag(values, 'net.acladdhostnameonfail') ?? settings.aclAddHostnameOnFail;
  const resolveHostNames = flag(values, 'net.aclresolvehostname');
  if (resolveHostNames !== undefined) settings.aclDontResolve = !resolveHostNames;
  const enableDns = flag(values, 'net.enabledns');
  if (enableDns !== undefined) settings.disableDns = !enableDns;
  settings.internalMessages.severityFilter = count(values, 'internalmsg.severity') ?? settings.internalMessages.severityFilter;
  settings.internalMessages.rateInterval = count(values, 'internalmsg.ratelimit.interval') ?? settings.internalMessages.rateInterval;
  settings.internalMessages.rateBurst = count(values, 'internalmsg.ratelimit.burst') ?? settings.internalMessages.rateBurst;
  settings.supportCompressionExtension = flag(values, 'parser.supportcompressionextension') ?? settings.supportCompressionExtension;
  settings.dnsCache.enableTtl = flag(values, 'reverselookup.cache.ttl.enable') ?? settings.dnsCache.enableTtl;
  settings.dnsCache.defaultTtlSeconds = count(values, 'reverselookup.cache.ttl.default') ?? settings.dnsCache.defaultTtlSeconds;
  const ipProtocol = str(values, 'net.ipprotocol');
  if (ipProtocol === 'unspecified' || ipProtocol === 'ipv4-only' || ipProtocol === 'ipv6-only') settings.ipProtocol = ipProtocol;
  else if (ipProtocol !== undefined) report(`invalid net.ipprotocol parameter '${ipProtocol}' -- ignored`);
  const secureMode = str(values, 'compatibility.defaults.secure');
  if (secureMode === 'strict' || secureMode === 'backward-compatible' || secureMode === 'warn') {
    settings.compatDefaultsSecure = secureMode;
    if (secureMode === 'strict') settings.abortOnUncleanConfig = true;
  } else if (secureMode !== undefined) {
    report(`invalid value '${secureMode}' for global parameter compatibility.defaults.secure`);
  }
  settings.maxOpenFiles = count(values, 'maxopenfiles') ?? settings.maxOpenFiles;
  const policy = str(values, 'inputstartuppolicy');
  if (policy === 'require-all') settings.requireAllInputs = true;
  else if (policy === 'best-effort') settings.requireAllInputs = false;
  else if (policy !== undefined) report(`invalid inputStartupPolicy '${policy}'; expected 'best-effort' or 'require-all'`);
  settings.oversize.errorFile = str(values, 'oversizemsg.errorfile') ?? settings.oversize.errorFile;
  settings.oversize.report = flag(values, 'oversizemsg.report') ?? settings.oversize.report;
  const oversizeMode = str(values, 'oversizemsg.input.mode');
  if (oversizeMode !== undefined) settings.oversize.mode = oversizeMode === 'split' || oversizeMode === 'accept' ? oversizeMode : 'truncate';
  settings.privDrop.keepSupplemental = flag(values, 'privdrop.group.keepsupplemental') ?? settings.privDrop.keepSupplemental;
  settings.privDrop.gid = count(values, 'privdrop.group.id') ?? count(values, 'privdrop.group.name') ?? settings.privDrop.gid;
  settings.privDrop.uid = count(values, 'privdrop.user.id') ?? count(values, 'privdrop.user.name') ?? settings.privDrop.uid;
  settings.umask = count(values, 'umask') ?? settings.umask;
  settings.janitorInterval = count(values, 'janitor.interval') ?? settings.janitorInterval;
  settings.senders.reportNew = flag(values, 'senders.reportnew') ?? settings.senders.reportNew;
  settings.senders.reportGoneAway = flag(values, 'senders.reportgoneaway') ?? settings.senders.reportGoneAway;
  settings.senders.timeoutAfter = count(values, 'senders.timeoutafter') ?? settings.senders.timeoutAfter;
  settings.senders.keepTrack = flag(values, 'senders.keeptrack') ?? settings.senders.keepTrack;
  const environment = values.get('environment');
  if (environment?.kind === 'A') {
    for (const assignment of environment.a) {
      const separator = assignment.indexOf('=');
      if (separator > 0) settings.environment[assignment.slice(0, separator)] = assignment.slice(separator + 1);
      else report(`environment variable '${assignment}' ignored: no '=' found`);
    }
  }
}
