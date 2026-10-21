import type { VirtualFileSystem } from '../../../VirtualFileSystem';
import { buildAuparseEvent } from '../../tools/AuparseEvent';
import { extractFeedTimestamp } from '../../tools/AuparseFeed';
import type { Interpreter } from '../../tools/AuditInterpret';
import { posixDirname } from '../AuditdConfig';

export interface PluginHost {
  readonly pid: number;
  readonly vfs: VirtualFileSystem;
  libcSyslog(priorityWithFacility: number, ident: string, text: string): void;
  localTime(seconds: number): string;
  interpreter(): Interpreter;
}

export interface PluginInstance {
  write(line: string): void;
  reload(): void;
  terminate(): void;
}

export type PluginProgram = (args: readonly string[], host: PluginHost) => PluginInstance | null;

export const LOG_EMERG = 0;
export const LOG_ALERT = 1;
export const LOG_CRIT = 2;
export const LOG_ERR = 3;
export const LOG_WARNING = 4;
export const LOG_NOTICE = 5;
export const LOG_INFO = 6;
export const LOG_DEBUG = 7;
export const LOG_USER = 1 << 3;
const INTERPRETATION_SEPARATOR = '\u001d';
const MAX_AUDIT_MESSAGE_LENGTH = 8970;
const MAX_INTERPRETED_LENGTH = MAX_AUDIT_MESSAGE_LENGTH - 128;

const SYSLOG_WORDS: Readonly<Record<string, { kind: 'priority' | 'facility'; value: number }>> = {
  log_debug: { kind: 'priority', value: LOG_DEBUG },
  log_info: { kind: 'priority', value: LOG_INFO },
  log_notice: { kind: 'priority', value: LOG_NOTICE },
  log_warning: { kind: 'priority', value: LOG_WARNING },
  log_err: { kind: 'priority', value: LOG_ERR },
  log_crit: { kind: 'priority', value: LOG_CRIT },
  log_alert: { kind: 'priority', value: LOG_ALERT },
  log_emerg: { kind: 'priority', value: LOG_EMERG },
  log_local0: { kind: 'facility', value: 16 << 3 },
  log_local1: { kind: 'facility', value: 17 << 3 },
  log_local2: { kind: 'facility', value: 18 << 3 },
  log_local3: { kind: 'facility', value: 19 << 3 },
  log_local4: { kind: 'facility', value: 20 << 3 },
  log_local5: { kind: 'facility', value: 21 << 3 },
  log_local6: { kind: 'facility', value: 22 << 3 },
  log_local7: { kind: 'facility', value: 23 << 3 },
  log_auth: { kind: 'facility', value: 4 << 3 },
  log_authpriv: { kind: 'facility', value: 10 << 3 },
  log_daemon: { kind: 'facility', value: 3 << 3 },
  log_syslog: { kind: 'facility', value: 5 << 3 },
  log_user: { kind: 'facility', value: LOG_USER },
};

const SYSLOG_IDENT = 'audisp-syslog';
const OPENLOG_IDENT = 'audispd';

function interpretedRecord(line: string, host: PluginHost): string | null {
  const time = extractFeedTimestamp(line);
  if (time === null) return null;
  const event = buildAuparseEvent([line], { sec: time.sec, milli: time.milli, serial: time.serial, host: time.host }, host.interpreter(), 'raw');
  if (event === null) return null;
  event.firstRecord();
  let more = event.firstField();
  if (event.numFields() === 0) return null;
  let out = '';
  let header = false;
  while (more > 0 && out.length < MAX_INTERPRETED_LENGTH) {
    const type = event.fieldType();
    const name = event.fieldName();
    let value: string | null;
    if (type === 'ESCAPED_FILE') value = event.interpretRealpath();
    else if (type === 'SOCKADDR') value = event.interpretSockAddress() ?? event.interpretSockFamily();
    else value = event.interpretField();
    out += `${name ?? '?'}=${value ?? '?'} `;
    more = event.nextField();
    if (!header && name === 'type') {
      out += `msg=audit(${host.localTime(time.sec)}) : `;
      header = true;
    }
  }
  return out;
}

export const audispSyslog: PluginProgram = (args, host) => {
  let facility = LOG_USER;
  let priority = LOG_INFO;
  let interpret = false;
  for (const argument of args) {
    const word = SYSLOG_WORDS[argument.toLowerCase()];
    if (word !== undefined) {
      if (word.kind === 'priority') priority = word.value;
      else facility = word.value;
    } else if (argument.toLowerCase() === 'interpret') {
      interpret = true;
    } else {
      host.libcSyslog(LOG_USER | LOG_ERR, SYSLOG_IDENT, `Unknown log priority/facility ${argument}`);
      return null;
    }
  }
  host.libcSyslog(LOG_USER | LOG_INFO, SYSLOG_IDENT, `syslog plugin initialized with facility ${facility} and priority ${priority}`);
  const ident = facility !== LOG_USER ? OPENLOG_IDENT : SYSLOG_IDENT;
  return {
    write(line) {
      const text = interpret ? interpretedRecord(line, host) : line.replace(INTERPRETATION_SEPARATOR, ' ');
      if (text !== null) host.libcSyslog(facility | priority, ident, text);
    },
    reload() {},
    terminate() {},
  };
};

const AF_UNIX_DEFAULT_PATH = '/var/run/audispd_events';
const AF_UNIX_DEFAULT_MODE = 0o640;
const AF_UNIX_SOCKET_MODE_AFTER_UMASK = 0o700;

export const audispAfUnix: PluginProgram = (args, host) => {
  const vfs = host.vfs;
  let mode = 0;
  let path: string | null = null;
  const log = (priority: number, text: string): void => host.libcSyslog(LOG_USER | priority, 'audisp-af_unix', text);
  if (args.length !== 2) {
    log(LOG_ERR, 'Missing arguments, using defaults');
    mode = AF_UNIX_DEFAULT_MODE;
    path = AF_UNIX_DEFAULT_PATH;
  } else {
    for (const argument of args) {
      if (/^[0-9]/.test(argument)) {
        mode = Number.parseInt(argument, 8) || 0;
      } else {
        path = argument;
        if (!path.includes('/')) {
          log(LOG_ERR, `Malformed path ${path}`);
          return null;
        }
        const directory = posixDirname(path);
        if (vfs.getType(directory) !== 'directory') {
          log(LOG_ERR, `Couldn't open ${directory} (No such file or directory)`);
          return null;
        }
        vfs.deleteFile(path);
      }
    }
    if (mode === 0 || path === null) {
      log(LOG_ERR, 'Bad arguments, using defaults');
      mode = AF_UNIX_DEFAULT_MODE;
      path = AF_UNIX_DEFAULT_PATH;
    }
  }
  const socketPath = path!;
  if (!vfs.createSocket(socketPath, AF_UNIX_SOCKET_MODE_AFTER_UMASK, 0, 0)) {
    log(LOG_ERR, "Couldn't bind af_unix socket (Address already in use)");
    log(LOG_ERR, 'audisp-af_unix plugin exiting');
    return null;
  }
  vfs.chmod(socketPath, mode);
  log(LOG_INFO, 'audisp-af_unix plugin is listening for events');
  return {
    write() {},
    reload() {},
    terminate() {
      vfs.deleteFile(socketPath);
    },
  };
};

export const AUDISP_PROGRAMS: Readonly<Record<string, PluginProgram>> = {
  'audisp-syslog': audispSyslog,
  'audisp-af_unix': audispAfUnix,
};
