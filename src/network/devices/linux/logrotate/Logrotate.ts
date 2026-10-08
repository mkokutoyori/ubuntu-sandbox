import { ConfigReader } from './LogrotateConfig';
import { LogrotateEngine } from './LogrotateEngine';
import { MESS_DEBUG, MessageLog } from './LogrotateLog';
import { isFailure, type LogrotateSystem } from './LogrotateSystem';

export const LOGROTATE_VERSION = '3.19.0';
export const DEFAULT_STATE_FILE = '/var/lib/logrotate/status';
const DEFAULT_MAIL_COMMAND = '/usr/bin/mail';

const USAGE = [
  'Usage: logrotate [-dfv?] [-d|--debug] [-f|--force] [-m|--mail=command]',
  '        [-s|--state=statefile] [--skip-state-lock] [-v|--verbose]',
  '        [-l|--log=logfile] [--version] [-?|--help] [--usage]',
  '        [OPTION...] <configfile>',
  '',
].join('\n');

const HELP = [
  'Usage: logrotate [OPTION...] <configfile>',
  '  -d, --debug               Don\'t do anything, just test and print debug',
  '                            messages',
  '  -f, --force               Force file rotation',
  `  -m, --mail=command        Command to send mail (instead of \`${DEFAULT_MAIL_COMMAND}')`,
  '  -s, --state=statefile     Path of state file',
  '      --skip-state-lock     Do not lock the state file',
  '  -v, --verbose             Display messages during rotation',
  '  -l, --log=logfile         Log file or \'syslog\' to log to syslog',
  '      --version             Display version information',
  '',
  'Help options:',
  '  -?, --help                Show this help message',
  '      --usage               Display brief usage message',
  '',
].join('\n');

const VERSION_TEXT = [
  `logrotate ${LOGROTATE_VERSION}`,
  '',
  `    Default mail command:       ${DEFAULT_MAIL_COMMAND}`,
  '    Default compress command:   /bin/gzip',
  '    Default uncompress command: /bin/gunzip',
  '    Default compress extension: .gz',
  `    Default state file path:    ${DEFAULT_STATE_FILE}`,
  '    ACL support:                yes',
  '    SELinux support:            yes',
  '',
].join('\n');

const LONG_FLAGS = new Set(['debug', 'force', 'skip-state-lock', 'verbose', 'version', 'help', 'usage']);
const LONG_VALUE = new Set(['mail', 'state', 'log']);
const SHORT_FLAGS = new Set(['d', 'f', 'v', '?']);
const SHORT_VALUE = new Set(['m', 's', 'l']);

export interface LogrotateResult {
  readonly output: string;
  readonly exitCode: number;
}

interface ParsedOptions {
  readonly events: ReadonlyArray<{ readonly name: string; readonly value?: string }>;
  readonly files: string[];
  readonly bad: string | null;
}

function parseOptions(argv: readonly string[]): ParsedOptions {
  const events: Array<{ name: string; value?: string }> = [];
  const files: string[] = [];
  let bad: string | null = null;
  let onlyFiles = false;
  for (let i = 0; i < argv.length && bad === null; i++) {
    const arg = argv[i];
    if (onlyFiles || arg === '-' || !arg.startsWith('-')) {
      files.push(arg);
    } else if (arg === '--') {
      onlyFiles = true;
    } else if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals < 0 ? arg.slice(2) : arg.slice(2, equals);
      const inline = equals < 0 ? undefined : arg.slice(equals + 1);
      if (LONG_FLAGS.has(name) && inline === undefined) {
        events.push({ name });
      } else if (LONG_VALUE.has(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined) bad = arg;
        else events.push({ name, value });
      } else {
        bad = arg;
      }
    } else {
      for (let j = 1; j < arg.length && bad === null; j++) {
        const char = arg[j];
        if (SHORT_FLAGS.has(char)) {
          events.push({ name: char });
        } else if (SHORT_VALUE.has(char)) {
          const rest = arg.slice(j + 1);
          const value = rest !== '' ? rest : argv[++i];
          if (value === undefined) bad = arg;
          else events.push({ name: char, value });
          break;
        } else {
          bad = arg;
        }
      }
    }
  }
  return { events, files, bad };
}

export function runLogrotate(system: LogrotateSystem, argv: readonly string[]): LogrotateResult {
  const log = new MessageLog();
  const parsed = parseOptions(argv);
  let debug = false;
  let force = false;
  let skipLock = false;
  let stateFile = DEFAULT_STATE_FILE;
  let mailCommand = DEFAULT_MAIL_COMMAND;
  let logFilePath: string | null = null;
  let mirror = '';
  const finish = (exitCode: number): LogrotateResult => {
    if (logFilePath !== null) system.writeText(logFilePath, mirror);
    return { output: log.output(), exitCode };
  };

  for (const event of parsed.events) {
    switch (event.name) {
      case 'd': case 'debug':
        debug = true;
        log.normal('WARNING: logrotate in debug mode does nothing except printing debug messages!  Consider using verbose mode (-v) instead if this is not what you want.\n\n');
        log.setLevel(MESS_DEBUG);
        break;
      case 'v': case 'verbose': log.setLevel(MESS_DEBUG); break;
      case 'f': case 'force': force = true; break;
      case 'm': case 'mail': mailCommand = event.value as string; break;
      case 's': case 'state': stateFile = event.value as string; break;
      case 'skip-state-lock': skipLock = true; break;
      case 'l': case 'log': {
        const target = event.value as string;
        if (target !== 'syslog') {
          const failure = system.writeText(target, '');
          if (failure !== null) {
            log.error(`error opening log file ${target}: ${failure === 'ENOENT' ? 'No such file or directory' : 'Permission denied'}\n`);
          } else {
            logFilePath = target;
            log.setMirror((text) => { mirror += text; });
          }
        }
        break;
      }
      case 'version': log.write(VERSION_TEXT); return finish(0);
      case 'help': case '?': log.write(HELP); return finish(0);
      case 'usage': log.write(USAGE); return finish(0);
      default: break;
    }
  }

  if (parsed.bad !== null) {
    log.write(`logrotate: bad argument ${parsed.bad}: unknown error\n`);
    return finish(2);
  }
  if (parsed.files.length === 0) {
    log.write(`logrotate ${LOGROTATE_VERSION} - Copyright (C) 1995-2001 Red Hat, Inc.\nThis may be freely redistributed under the terms of the GNU General Public License\n\n${USAGE}`);
    return finish(1);
  }
  let failed = false;
  const reader = new ConfigReader(system, log);
  if (reader.readAllConfigPaths(parsed.files)) failed = true;
  const engine = new LogrotateEngine(system, log, { debug, mailCommand });
  engine.setNow(system.nowSeconds());

  if (!debug && engine.lockState(stateFile, skipLock)) return finish(3);
  if (engine.readState(stateFile)) failed = true;

  log.debug(`\nHandling ${reader.logs.length} logs\n`);
  for (const info of reader.logs) {
    if (engine.rotateLogSet(info, force)) failed = true;
  }
  if (!debug && engine.writeState(stateFile)) failed = true;
  return finish(failed ? 1 : 0);
}

export { isFailure };
