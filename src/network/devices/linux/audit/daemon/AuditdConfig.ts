export type AuditPriority = 'EMERG' | 'ALERT' | 'CRIT' | 'ERR' | 'WARNING' | 'NOTICE' | 'INFO';

export interface AuditMessage {
  readonly priority: AuditPriority;
  readonly text: string;
}

export type LogFormat = 'RAW' | 'NOLOG' | 'ENRICHED';
export type FlushTechnique = 'NONE' | 'INCREMENTAL' | 'INCREMENTAL_ASYNC' | 'DATA' | 'SYNC';
export type FailureAction = 'IGNORE' | 'SYSLOG' | 'ROTATE' | 'EMAIL' | 'EXEC' | 'SUSPEND' | 'SINGLE' | 'HALT';
export type SizeAction = 'IGNORE' | 'SYSLOG' | 'SUSPEND' | 'ROTATE' | 'KEEP_LOGS';
export type OverflowAction = 'IGNORE' | 'SYSLOG' | 'SUSPEND' | 'SINGLE' | 'HALT';
export type NodeNameFormat = 'NONE' | 'HOSTNAME' | 'FQD' | 'NUMERIC' | 'USER';

export interface AuditdConfig {
  localEvents: boolean;
  writeLogs: boolean;
  logFile: string;
  logFormat: LogFormat;
  logGroup: number;
  priorityBoost: number;
  flush: FlushTechnique;
  freq: number;
  numLogs: number;
  nodeNameFormat: NodeNameFormat;
  nodeName: string | null;
  maxLogSize: number;
  maxLogSizeAction: SizeAction;
  spaceLeft: number;
  spaceLeftPercent: number;
  spaceLeftAction: FailureAction;
  spaceLeftExe: string | null;
  actionMailAcct: string;
  verifyEmail: boolean;
  adminSpaceLeft: number;
  adminSpaceLeftPercent: number;
  adminSpaceLeftAction: FailureAction;
  adminSpaceLeftExe: string | null;
  diskFullAction: FailureAction;
  diskFullExe: string | null;
  diskErrorAction: FailureAction;
  diskErrorExe: string | null;
  useLibwrap: boolean;
  distributeNetworkEvents: boolean;
  qDepth: number;
  overflowAction: OverflowAction;
  maxRestarts: number;
  pluginDir: string;
  endOfEventTimeout: number;
}

export type FileKind = 'file' | 'directory' | 'symlink' | 'other';

export interface FileInfo {
  readonly kind: FileKind;
  readonly ino?: number;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

export type FsErrno = 'ENOENT' | 'EACCES' | 'ELOOP' | 'ENOTDIR';

export type StatResult = { readonly ok: true; readonly info: FileInfo } | { readonly ok: false; readonly errno: FsErrno };

export interface AuditdConfigFs {
  stat(path: string, followLinks: boolean): StatResult;
  readText(path: string): string | null;
  openDirectory(path: string): FsErrno | null;
  groupGid(name: string): number | null;
  isExecutable(path: string): boolean;
  hostResolves(host: string): boolean;
}

export interface AuditdConfigOptions {
  readonly configFile: string;
  readonly allowLinks: boolean;
}

export interface AuditdConfigLoad {
  readonly rc: 0 | 1;
  readonly config: AuditdConfig;
  readonly messages: readonly AuditMessage[];
}

export const AUDITD_CONF_PATH = '/etc/audit/auditd.conf';
export const EMAIL_COMMAND = '/usr/lib/sendmail';
export const END_OF_EVENT_TIMEOUT = 2;

const LINE_BUFFER_BYTES = 160;
const INT_MAX = 2147483647;
const ULONG_MAX = (1n << 64n) - 1n;
const S_IWOTH = 0o002;
const S_IWUSR = 0o200;
const S_IXUSR = 0o100;
const S_IWGRP = 0o020;
const S_IXGRP = 0o010;
const S_IRWXO = 0o007;
const S_IRWXU = 0o700;
const S_IRWXG = 0o070;

export const ERRNO_TEXT: Readonly<Record<FsErrno, string>> = {
  ENOENT: 'No such file or directory',
  EACCES: 'Permission denied',
  ELOOP: 'Too many levels of symbolic links',
  ENOTDIR: 'Not a directory',
};

const ERANGE_TEXT = 'Numerical result out of range';

export function clearConfig(): AuditdConfig {
  return {
    localEvents: true,
    writeLogs: true,
    logFile: '/var/log/audit/audit.log',
    logFormat: 'ENRICHED',
    logGroup: 0,
    priorityBoost: 4,
    flush: 'NONE',
    freq: 0,
    numLogs: 0,
    nodeNameFormat: 'NONE',
    nodeName: null,
    maxLogSize: 0,
    maxLogSizeAction: 'IGNORE',
    spaceLeft: 0,
    spaceLeftPercent: 0,
    spaceLeftAction: 'IGNORE',
    spaceLeftExe: null,
    actionMailAcct: 'root',
    verifyEmail: true,
    adminSpaceLeft: 0,
    adminSpaceLeftPercent: 0,
    adminSpaceLeftAction: 'IGNORE',
    adminSpaceLeftExe: null,
    diskFullAction: 'IGNORE',
    diskFullExe: null,
    diskErrorAction: 'SYSLOG',
    diskErrorExe: null,
    useLibwrap: true,
    distributeNetworkEvents: false,
    qDepth: 2000,
    overflowAction: 'SYSLOG',
    maxRestarts: 10,
    pluginDir: '/etc/audit/plugins.d',
    endOfEventTimeout: END_OF_EVENT_TIMEOUT,
  };
}

export interface NameValue {
  name: string | null;
  value: string | null;
  option: string | null;
}

interface Parsing {
  readonly config: AuditdConfig;
  readonly fs: AuditdConfigFs;
  readonly messages: AuditMessage[];
}

type Parser = (nv: Required<NameValue>, line: number, state: Parsing) => number;

const YES_NO: Readonly<Record<string, boolean>> = { yes: true, no: false };

const LOG_FORMATS: Readonly<Record<string, LogFormat>> = { raw: 'RAW', nolog: 'NOLOG', enriched: 'ENRICHED' };
const FLUSH_TECHNIQUES: Readonly<Record<string, FlushTechnique>> = {
  none: 'NONE', incremental: 'INCREMENTAL', incremental_async: 'INCREMENTAL_ASYNC', data: 'DATA', sync: 'SYNC',
};
const FAILURE_ACTIONS: Readonly<Record<string, FailureAction>> = {
  ignore: 'IGNORE', syslog: 'SYSLOG', rotate: 'ROTATE', email: 'EMAIL', exec: 'EXEC',
  suspend: 'SUSPEND', single: 'SINGLE', halt: 'HALT',
};
const SIZE_ACTIONS: Readonly<Record<string, SizeAction>> = {
  ignore: 'IGNORE', syslog: 'SYSLOG', suspend: 'SUSPEND', rotate: 'ROTATE', keep_logs: 'KEEP_LOGS',
};
const NODE_NAME_FORMATS: Readonly<Record<string, NodeNameFormat>> = {
  none: 'NONE', hostname: 'HOSTNAME', fqd: 'FQD', numeric: 'NUMERIC', user: 'USER',
};
const OVERFLOW_ACTIONS: Readonly<Record<string, OverflowAction>> = {
  ignore: 'IGNORE', syslog: 'SYSLOG', suspend: 'SUSPEND', single: 'SINGLE', halt: 'HALT',
};

function message(state: Parsing, priority: AuditPriority, text: string): void {
  state.messages.push({ priority, text });
}

function onlyDigits(text: string): boolean {
  return /^[0-9]*$/.test(text);
}

function leadingNumber(text: string): bigint {
  const match = /^[ \t\n\v\f\r]*([0-9]*)/.exec(text);
  return match === null || match[1] === '' ? 0n : BigInt(match[1]);
}

function lookupWord<T>(table: Readonly<Record<string, T>>, word: string): T | undefined {
  return table[word.toLowerCase()];
}

function notFound(state: Parsing, nv: Required<NameValue>, line: number): number {
  message(state, 'ERR', `Option ${nv.value} not found - line ${line}`);
  return 1;
}

function yesNo(assign: (config: AuditdConfig, value: boolean) => void): Parser {
  return (nv, line, state) => {
    const value = lookupWord(YES_NO, nv.value);
    if (value === undefined) return notFound(state, nv, line);
    assign(state.config, value);
    return 0;
  };
}

function unsignedNumber(
  nv: Required<NameValue>, line: number, state: Parsing, limit: bigint | null, assign: (value: number) => void,
): number {
  if (!onlyDigits(nv.value)) {
    message(state, 'ERR', `Value ${nv.value} should only be numbers - line ${line}`);
    return 1;
  }
  const value = leadingNumber(nv.value);
  if (value > ULONG_MAX) {
    message(state, 'ERR', `Error converting string to a number (${ERANGE_TEXT}) - line ${line}`);
    return 1;
  }
  if (limit !== null && value > limit) {
    message(state, 'ERR', `Error - converted number (${nv.value}) is too large - line ${line}`);
    return 1;
  }
  assign(Number(value));
  return 0;
}

export function posixDirname(path: string): string {
  if (path === '') return '.';
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end--;
  const trimmed = path.slice(0, end);
  const slash = trimmed.lastIndexOf('/');
  if (slash === -1) return '.';
  let dirEnd = slash;
  while (dirEnd > 0 && trimmed[dirEnd - 1] === '/') dirEnd--;
  return dirEnd === 0 ? '/' : trimmed.slice(0, dirEnd);
}

function parseLogFile(nv: Required<NameValue>, line: number, state: Parsing): number {
  const dir = posixDirname(nv.value);
  if (dir.length < 4) {
    message(state, 'ERR', `The directory name: ${dir} is too short - line ${line}`);
    return 1;
  }
  const opened = state.fs.openDirectory(dir);
  if (opened !== null) {
    message(state, 'ERR', `Could not open dir ${dir} (${ERRNO_TEXT[opened]})`);
    return 1;
  }
  const stat = state.fs.stat(nv.value, true);
  if (stat.ok === false) {
    if (stat.errno !== 'ENOENT') {
      message(state, 'ERR', `Unable to open ${nv.value} (${ERRNO_TEXT[stat.errno]})`);
      return 1;
    }
  } else {
    const info = stat.info;
    if (info.kind !== 'file') {
      message(state, 'ERR', `${nv.value} is not a regular file`);
      return 1;
    }
    if (info.uid !== 0) {
      message(state, 'ERR', `${nv.value} is not owned by root`);
      return 1;
    }
    if ((info.mode & (S_IXUSR | S_IWGRP | S_IXGRP | S_IRWXO)) !== 0) {
      message(state, 'WARNING', `${nv.value} permissions should be 0600 or 0640`);
    }
    if ((info.mode & S_IWUSR) === 0) message(state, 'WARNING', 'audit log is not writable by owner');
  }
  state.config.logFile = nv.value;
  return 0;
}

function parseNumLogs(nv: Required<NameValue>, line: number, state: Parsing): number {
  if (!onlyDigits(nv.value)) {
    message(state, 'ERR', `Value ${nv.value} should only be numbers - line ${line}`);
    return 1;
  }
  const value = leadingNumber(nv.value);
  if (value > ULONG_MAX) {
    message(state, 'ERR', `Error converting string to a number (${ERANGE_TEXT}) - line ${line}`);
    return 1;
  }
  if (value > 999n) {
    message(state, 'ERR', 'num_logs must be 999 or less');
    return 1;
  }
  state.config.numLogs = Number(value);
  return 0;
}

function parseLogFormat(nv: Required<NameValue>, line: number, state: Parsing): number {
  const format = lookupWord(LOG_FORMATS, nv.value);
  if (format === undefined) return notFound(state, nv, line);
  state.config.logFormat = format;
  if (format === 'NOLOG') {
    message(state, 'WARNING', 'The NOLOG option to log_format is deprecated. Please use the write_logs option.');
    if (state.config.writeLogs) message(state, 'WARNING', 'The NOLOG option is overriding the write_logs current setting.');
    state.config.writeLogs = false;
  }
  return 0;
}

function parseLogGroup(nv: Required<NameValue>, line: number, state: Parsing): number {
  if (/^[0-9]/.test(nv.value)) {
    const value = leadingNumber(nv.value);
    if (value > ULONG_MAX) {
      message(state, 'ERR', `Numeric group ID conversion error (${ERANGE_TEXT}) for ${nv.value} - line ${line}\n`);
      return 1;
    }
    state.config.logGroup = Number(value % 4294967296n);
    return 0;
  }
  const gid = state.fs.groupGid(nv.value);
  if (gid === null) {
    message(state, 'ERR', `Group ID is non-numeric and unknown (${nv.value}) - line ${line}\n`);
    return 1;
  }
  state.config.logGroup = gid;
  return 0;
}

function spaceParser(
  assign: (config: AuditdConfig, mode: 'absolute' | 'percent', value: number) => void,
): Parser {
  return (nv, line, state) => {
    for (const character of nv.value) {
      if (!/[0-9%]/.test(character)) {
        message(state, 'ERR', `Value ${character} ${nv.value} should only be numbers or percent - line ${line}`);
        return 1;
      }
    }
    const percentAt = nv.value.indexOf('%');
    const percent = percentAt !== -1;
    const text = percent ? `${nv.value.slice(0, percentAt)} ${nv.value.slice(percentAt + 1)}` : nv.value;
    const value = leadingNumber(text);
    if (value > ULONG_MAX) {
      message(state, 'ERR', `Error converting string to a number (${ERANGE_TEXT}) - line ${line}`);
      return 1;
    }
    if (percent) {
      if (value > 99n) {
        message(state, 'ERR', `Percentages should be less than 100 - line ${line}`);
        return 1;
      }
      assign(state.config, 'percent', Number(value));
    } else {
      assign(state.config, 'absolute', Number(value));
    }
    return 0;
  };
}

function checkExeName(value: string | null, line: number, state: Parsing): number {
  if (value === null) {
    message(state, 'ERR', `Executable path needed for line ${line}`);
    return -1;
  }
  if (!value.startsWith('/')) {
    message(state, 'ERR', `Absolute path needed for ${value} - line ${line}`);
    return -1;
  }
  const stat = state.fs.stat(value, true);
  if (stat.ok === false) {
    message(state, 'ERR', `Unable to stat ${value} (${ERRNO_TEXT[stat.errno]}) - line ${line}`);
    return -1;
  }
  if (stat.info.kind !== 'file') {
    message(state, 'ERR', `${value} is not a regular file - line ${line}`);
    return -1;
  }
  if (stat.info.uid !== 0) {
    message(state, 'ERR', `${value} is not owned by root - line ${line}`);
    return -1;
  }
  const permissions = stat.info.mode & (S_IRWXU | S_IRWXG | S_IRWXO);
  if (permissions !== (S_IRWXU | 0o040 | S_IXGRP) && permissions !== (S_IRWXU | 0o040 | S_IXGRP | 0o004 | 0o001)
    && permissions !== (0o400 | S_IXUSR | 0o040 | S_IXGRP | 0o004 | 0o001)) {
    message(state, 'ERR', `${value} permissions should be 0750, 0755, 0555 or 0550 - line ${line}`);
    return -1;
  }
  return 0;
}

interface ActionSlot {
  readonly assign: (config: AuditdConfig, action: FailureAction) => void;
  readonly assignExe: (config: AuditdConfig, exe: string) => void;
  readonly forbidden: readonly FailureAction[];
  readonly checksEmail: boolean;
  readonly forbiddenWording: string | null;
}

function actionParser(slot: ActionSlot): Parser {
  return (nv, line, state) => {
    const action = lookupWord(FAILURE_ACTIONS, nv.value);
    if (action === undefined) return notFound(state, nv, line);
    if (slot.forbidden.includes(action)) {
      message(state, 'ERR', `Illegal option ${nv.value} for ${slot.forbiddenWording} - line ${line}`);
      return 1;
    }
    if (action === 'EMAIL' && slot.checksEmail && !state.fs.isExecutable(EMAIL_COMMAND)) {
      message(state, 'ERR', `Email option is specified but ${EMAIL_COMMAND} doesn't seem executable.`);
    } else if (action === 'EXEC') {
      if (checkExeName(nv.option, line, state) !== 0) return 1;
      slot.assignExe(state.config, nv.option!);
    }
    slot.assign(state.config, action);
    return 0;
  };
}

function validateEmail(account: string, state: Parsing): number {
  if (account.length < 2) {
    message(state, 'ERR', `email: ${account} is too short, expecting at least 2 characters`);
    return 2;
  }
  if (!/^[A-Za-z0-9@.\-_]*$/.test(account)) {
    message(state, 'ERR', `email: ${account} has illegal character`);
    return 2;
  }
  const at = account.indexOf('@');
  if (at !== -1) {
    if (account.lastIndexOf('.') === -1 || at > account.lastIndexOf('.')) {
      message(state, 'ERR', `email: ${account} should have . after @`);
      return 2;
    }
    const host = account.slice(at + 1);
    if (!state.fs.hostResolves(host)) {
      message(state, 'ERR', `validate_email: failed looking up host for ${host} (Name or service not known)`);
      return 1;
    }
  }
  return 0;
}

function parseQDepth(nv: Required<NameValue>, line: number, state: Parsing): number {
  if (!onlyDigits(nv.value)) {
    message(state, 'ERR', `Value ${nv.value} should only be numbers - line ${line}`);
    return 1;
  }
  const value = leadingNumber(nv.value);
  if (value > ULONG_MAX) {
    message(state, 'ERR', `Error converting string to a number (${ERANGE_TEXT}) - line ${line}`);
    return 1;
  }
  if (value > 99999n) {
    message(state, 'ERR', 'q_depth must be 99999 or less');
    return 1;
  }
  if (value < 512n) message(state, 'WARNING', 'q_depth should be larger than 512 for safety margin');
  state.config.qDepth = Number(value);
  return 0;
}

function parsePluginDir(nv: Required<NameValue>, _line: number, state: Parsing): number {
  const length = nv.value.length;
  state.config.pluginDir = length > 1 && !nv.value.endsWith('/') ? `${nv.value}/` : nv.value;
  return 0;
}

function accepted(_nv: Required<NameValue>, _line: number, _state: Parsing): number {
  return 0;
}

function deprecated(_nv: Required<NameValue>, line: number, state: Parsing): number {
  message(state, 'WARNING', `The disp_qos option is deprecated - line ${line}`);
  return 0;
}

function deprecatedDispatcher(_nv: Required<NameValue>, line: number, state: Parsing): number {
  message(state, 'WARNING', `The dispatcher option is deprecated - line ${line}`);
  return 0;
}

interface Keyword {
  readonly parser: Parser;
  readonly maxOptions: number;
}

const KEYWORDS: Readonly<Record<string, Keyword>> = {
  local_events: { parser: yesNo((c, v) => { c.localEvents = v; }), maxOptions: 0 },
  write_logs: { parser: yesNo((c, v) => { c.writeLogs = v; }), maxOptions: 0 },
  log_file: { parser: parseLogFile, maxOptions: 0 },
  log_format: { parser: parseLogFormat, maxOptions: 0 },
  log_group: { parser: parseLogGroup, maxOptions: 0 },
  flush: {
    parser: (nv, line, state) => {
      const technique = lookupWord(FLUSH_TECHNIQUES, nv.value);
      if (technique === undefined) return notFound(state, nv, line);
      state.config.flush = technique;
      return 0;
    },
    maxOptions: 0,
  },
  freq: { parser: (nv, line, state) => unsignedNumber(nv, line, state, BigInt(INT_MAX), (v) => { state.config.freq = v; }), maxOptions: 0 },
  num_logs: { parser: parseNumLogs, maxOptions: 0 },
  dispatcher: { parser: deprecatedDispatcher, maxOptions: 0 },
  name_format: {
    parser: (nv, line, state) => {
      const format = lookupWord(NODE_NAME_FORMATS, nv.value);
      if (format === undefined) return notFound(state, nv, line);
      state.config.nodeNameFormat = format;
      return 0;
    },
    maxOptions: 0,
  },
  name: { parser: (nv, _line, state) => { state.config.nodeName = nv.value; return 0; }, maxOptions: 0 },
  disp_qos: { parser: deprecated, maxOptions: 0 },
  max_log_file: {
    parser: (nv, line, state) => unsignedNumber(nv, line, state, null, (v) => { state.config.maxLogSize = v; }),
    maxOptions: 0,
  },
  max_log_file_action: {
    parser: (nv, line, state) => {
      const action = lookupWord(SIZE_ACTIONS, nv.value);
      if (action === undefined) return notFound(state, nv, line);
      state.config.maxLogSizeAction = action;
      return 0;
    },
    maxOptions: 0,
  },
  space_left: {
    parser: spaceParser((c, mode, value) => {
      c.spaceLeftPercent = mode === 'percent' ? value : 0;
      if (mode === 'percent') c.spaceLeft = 0;
      else c.spaceLeft = value;
    }),
    maxOptions: 0,
  },
  space_left_action: {
    parser: actionParser({
      assign: (c, a) => { c.spaceLeftAction = a; },
      assignExe: (c, e) => { c.spaceLeftExe = e; },
      forbidden: [], checksEmail: true, forbiddenWording: null,
    }),
    maxOptions: 1,
  },
  action_mail_acct: {
    parser: (nv, _line, state) => {
      if (state.config.verifyEmail && validateEmail(nv.value, state) > 1) return 1;
      state.config.actionMailAcct = nv.value;
      return 0;
    },
    maxOptions: 0,
  },
  verify_email: { parser: yesNo((c, v) => { c.verifyEmail = v; }), maxOptions: 0 },
  admin_space_left: {
    parser: spaceParser((c, mode, value) => {
      c.adminSpaceLeftPercent = mode === 'percent' ? value : 0;
      if (mode === 'percent') c.adminSpaceLeft = 0;
      else c.adminSpaceLeft = value;
    }),
    maxOptions: 0,
  },
  admin_space_left_action: {
    parser: actionParser({
      assign: (c, a) => { c.adminSpaceLeftAction = a; },
      assignExe: (c, e) => { c.adminSpaceLeftExe = e; },
      forbidden: [], checksEmail: true, forbiddenWording: null,
    }),
    maxOptions: 1,
  },
  disk_full_action: {
    parser: actionParser({
      assign: (c, a) => { c.diskFullAction = a; },
      assignExe: (c, e) => { c.diskFullExe = e; },
      forbidden: ['EMAIL'], checksEmail: false, forbiddenWording: 'disk_full_action',
    }),
    maxOptions: 1,
  },
  disk_error_action: {
    parser: actionParser({
      assign: (c, a) => { c.diskErrorAction = a; },
      assignExe: (c, e) => { c.diskErrorExe = e; },
      forbidden: ['EMAIL', 'ROTATE'], checksEmail: false, forbiddenWording: 'disk_error_action',
    }),
    maxOptions: 1,
  },
  priority_boost: {
    parser: (nv, line, state) => unsignedNumber(nv, line, state, BigInt(INT_MAX), (v) => { state.config.priorityBoost = v; }),
    maxOptions: 0,
  },
  tcp_listen_port: { parser: accepted, maxOptions: 0 },
  tcp_listen_queue: { parser: accepted, maxOptions: 0 },
  tcp_max_per_addr: { parser: accepted, maxOptions: 0 },
  use_libwrap: { parser: yesNo((c, v) => { c.useLibwrap = v; }), maxOptions: 0 },
  tcp_client_ports: { parser: accepted, maxOptions: 0 },
  tcp_client_max_idle: { parser: accepted, maxOptions: 0 },
  transport: {
    parser: (nv, line, state) => (nv.value.toLowerCase() === 'tcp' ? 0 : notFound(state, nv, line)),
    maxOptions: 0,
  },
  enable_krb5: { parser: accepted, maxOptions: 0 },
  krb5_principal: { parser: accepted, maxOptions: 0 },
  krb5_key_file: { parser: accepted, maxOptions: 0 },
  distribute_network: { parser: yesNo((c, v) => { c.distributeNetworkEvents = v; }), maxOptions: 0 },
  q_depth: { parser: parseQDepth, maxOptions: 0 },
  overflow_action: {
    parser: (nv, line, state) => {
      const action = lookupWord(OVERFLOW_ACTIONS, nv.value);
      if (action === undefined) return notFound(state, nv, line);
      state.config.overflowAction = action;
      return 0;
    },
    maxOptions: 0,
  },
  max_restarts: {
    parser: (nv, line, state) => unsignedNumber(nv, line, state, BigInt(INT_MAX), (v) => { state.config.maxRestarts = v; }),
    maxOptions: 0,
  },
  plugin_dir: { parser: parsePluginDir, maxOptions: 0 },
  end_of_event_timeout: {
    parser: (nv, line, state) => unsignedNumber(nv, line, state, null, (v) => { state.config.endOfEventTimeout = v; }),
    maxOptions: 0,
  },
};

function lookupKeyword(name: string): Keyword | undefined {
  return KEYWORDS[name.toLowerCase()];
}

function splitSpaces(buffer: string): string[] {
  return buffer.split(' ').filter((token) => token !== '');
}

export function splitNameValue(buffer: string): { rc: number; nv: NameValue } {
  const nv: NameValue = { name: null, value: null, option: null };
  const tokens = splitSpaces(buffer);
  if (tokens.length === 0 || tokens[0].startsWith('#')) return { rc: 0, nv };
  nv.name = tokens[0];
  if (tokens.length < 2) return { rc: 1, nv };
  if (tokens[1] !== '=') return { rc: 2, nv };
  if (tokens.length < 3) return { rc: 1, nv };
  nv.value = tokens[2];
  if (tokens.length > 3) {
    nv.option = tokens[3];
    if (tokens.length > 4) return { rc: 1, nv };
  }
  return { rc: 0, nv };
}

export function* readConfigLines(content: string, file: string, messages: AuditMessage[], lineNumber: { value: number }): Generator<string> {
  let position = 0;
  let tooLong = false;
  while (position < content.length) {
    const chunk = content.slice(position, position + LINE_BUFFER_BYTES - 1);
    position += chunk.length;
    const newline = chunk.indexOf('\n');
    if (newline !== -1) {
      position -= chunk.length - newline - 1;
      if (!tooLong) {
        yield chunk.slice(0, newline);
      } else {
        tooLong = false;
        lineNumber.value++;
      }
    } else if (!tooLong) {
      messages.push({ priority: 'ERR', text: `Skipping line ${lineNumber.value} in ${file}: too long` });
      tooLong = true;
    }
  }
}

function sanityCheck(state: Parsing): number {
  const c = state.config;
  if (c.spaceLeftPercent === 0 && c.adminSpaceLeftPercent === 0 && c.spaceLeft <= c.adminSpaceLeft) {
    message(state, 'ERR', `Error - space_left(${c.spaceLeft}) must be larger than admin_space_left(${c.adminSpaceLeft})`);
    return 1;
  }
  if ((c.flush === 'INCREMENTAL' || c.flush === 'INCREMENTAL_ASYNC') && c.freq === 0) {
    message(state, 'ERR', 'Error - incremental flushing chosen, but 0 selected for freq');
    return 1;
  }
  if (c.logGroup !== 0) {
    const dir = posixDirname(c.logFile);
    if (dir === '/var/log') {
      message(state, 'ERR', `Error - log_file is directly in ${dir} and chgrp will alter a system directory's permissions. Use another directory.`);
      return 1;
    }
  }
  const flushRank: Record<FlushTechnique, number> = { NONE: 0, INCREMENTAL: 1, INCREMENTAL_ASYNC: 2, DATA: 3, SYNC: 4 };
  if (flushRank[c.flush] > flushRank.INCREMENTAL_ASYNC && c.freq !== 0) {
    message(state, 'WARNING', 'Warning - freq is non-zero and incremental flushing not selected.');
  }
  return 0;
}

export function loadAuditdConfig(fs: AuditdConfigFs, options: AuditdConfigOptions): AuditdConfigLoad {
  const config = clearConfig();
  const messages: AuditMessage[] = [];
  const state: Parsing = { config, fs, messages };
  const file = options.configFile;
  const fail = (): AuditdConfigLoad => ({ rc: 1, config, messages });

  const found = fs.stat(file, options.allowLinks);
  const stat: StatResult = found.ok && found.info.kind === 'symlink' && !options.allowLinks
    ? { ok: false, errno: 'ELOOP' } : found;
  if (stat.ok === false) {
    if (stat.errno !== 'ENOENT') {
      message(state, 'ERR', `Error opening config file (${ERRNO_TEXT[stat.errno]})`);
      return fail();
    }
    message(state, 'WARNING', `Config file ${file} doesn't exist, skipping`);
    return { rc: 0, config, messages };
  }
  if (stat.info.uid !== 0) {
    message(state, 'ERR', `Error - ${file} isn't owned by root`);
    return fail();
  }
  if ((stat.info.mode & S_IWOTH) === S_IWOTH) {
    message(state, 'ERR', `Error - ${file} is world writable`);
    return fail();
  }
  if (stat.info.kind !== 'file') {
    message(state, 'ERR', `Error - ${file} is not a regular file`);
    return fail();
  }
  const content = fs.readText(file) ?? '';

  const lineNumber = { value: 1 };
  for (const buffer of readConfigLines(content, file, messages, lineNumber)) {
    const { rc, nv } = splitNameValue(buffer);
    if (rc === 1) message(state, 'ERR', `Wrong number of arguments for line ${lineNumber.value} in ${file}`);
    else if (rc === 2) message(state, 'ERR', `Missing equal sign for line ${lineNumber.value} in ${file}`);
    if (nv.name === null) {
      lineNumber.value++;
      continue;
    }
    if (nv.value === null) {
      message(state, 'ERR', `Not processing any more lines in ${file}`);
      return fail();
    }
    const keyword = lookupKeyword(nv.name);
    if (keyword === undefined) {
      message(state, 'ERR', `Unknown keyword "${nv.name}" in line ${lineNumber.value} of ${file}`);
      return fail();
    }
    if (keyword.maxOptions === 0 && nv.option !== null) {
      message(state, 'ERR', `Keyword "${nv.name}" has invalid option "${nv.option}" in line ${lineNumber.value} of ${file}`);
      return fail();
    }
    if (keyword.parser(nv as Required<NameValue>, lineNumber.value, state) !== 0) return fail();
    lineNumber.value++;
  }

  if (lineNumber.value > 1 && sanityCheck(state) !== 0) return fail();
  return { rc: 0, config, messages };
}

export function formatMessages(messages: readonly AuditMessage[]): string {
  return messages.map((entry) => `${entry.text}\n`).join('');
}
