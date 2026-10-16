export const SFTP_LOG_LEVELS = [
  'QUIET', 'FATAL', 'ERROR', 'INFO', 'VERBOSE', 'DEBUG', 'DEBUG1', 'DEBUG2', 'DEBUG3',
] as const;

export type SftpLogLevel = (typeof SFTP_LOG_LEVELS)[number];

const LOG_FACILITIES = new Set([
  'DAEMON', 'USER', 'AUTH', 'AUTHPRIV', 'LOCAL0', 'LOCAL1', 'LOCAL2', 'LOCAL3', 'LOCAL4', 'LOCAL5', 'LOCAL6', 'LOCAL7',
]);

export const SFTP_REQUEST_NAMES: readonly string[] = [
  'open', 'close', 'read', 'write', 'lstat', 'fstat', 'setstat', 'fsetstat', 'opendir', 'readdir', 'remove',
  'mkdir', 'rmdir', 'realpath', 'stat', 'rename', 'readlink', 'symlink',
  'posix-rename', 'statvfs', 'fstatvfs', 'hardlink', 'fsync', 'lsetstat', 'limits', 'expand-path',
];

export const SFTP_WRITING_REQUESTS: ReadonlySet<string> = new Set([
  'write', 'setstat', 'fsetstat', 'remove', 'mkdir', 'rmdir', 'rename', 'symlink',
  'posix-rename', 'hardlink', 'fsync', 'lsetstat',
]);

export interface SftpServerOptions {
  readonly readOnly: boolean;
  readonly startDirectory: string | null;
  readonly umask: number | null;
  readonly logLevel: SftpLogLevel;
  readonly logFacility: string;
  readonly logToStderr: boolean;
  readonly allowedRequests: string | null;
  readonly deniedRequests: string | null;
}

export const DEFAULT_SFTP_SERVER_OPTIONS: SftpServerOptions = {
  readOnly: false, startDirectory: null, umask: null, logLevel: 'ERROR', logFacility: 'AUTH',
  logToStderr: false, allowedRequests: null, deniedRequests: null,
};

export type SftpServerInvocation =
  | { readonly kind: 'serve'; readonly options: SftpServerOptions; readonly diagnostics: readonly string[] }
  | { readonly kind: 'usage' }
  | { readonly kind: 'query'; readonly lines: readonly string[] }
  | { readonly kind: 'fatal'; readonly message: string };

export const SFTP_SERVER_USAGE = [
  'usage: sftp-server [-ehR] [-d start_directory] [-f log_facility] [-l log_level]',
  '\t[-P denied_requests] [-p allowed_requests] [-u umask]',
  '       sftp-server -Q protocol_feature',
].join('\n');

const VALUED = new Set(['d', 'f', 'l', 'P', 'p', 'Q', 'u']);
const SWITCHES = new Set(['c', 'e', 'h', 'R']);

export function parseSftpServerArguments(args: readonly string[]): SftpServerInvocation {
  let options = DEFAULT_SFTP_SERVER_OPTIONS;
  const diagnostics: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === '--') break;
    if (!word.startsWith('-') || word === '-') break;
    for (let at = 1; at < word.length; at++) {
      const letter = word[at];
      if (VALUED.has(letter)) {
        const attached = word.slice(at + 1);
        const value = attached !== '' ? attached : args[++index];
        if (value === undefined) return { kind: 'usage' };
        switch (letter) {
          case 'Q':
            if (value.toLowerCase() !== 'requests') return { kind: 'fatal', message: 'Invalid query type' };
            return { kind: 'query', lines: SFTP_REQUEST_NAMES };
          case 'l': {
            const level = SFTP_LOG_LEVELS.find((candidate) => candidate === value.toUpperCase());
            if (level === undefined) diagnostics.push(`Invalid log level "${value}"`);
            else options = { ...options, logLevel: level };
            break;
          }
          case 'f':
            if (!LOG_FACILITIES.has(value.toUpperCase())) diagnostics.push(`Invalid log facility "${value}"`);
            else options = { ...options, logFacility: value.toUpperCase() };
            break;
          case 'd': options = { ...options, startDirectory: value }; break;
          case 'p':
            if (options.allowedRequests !== null) return { kind: 'fatal', message: 'Permitted requests already set' };
            options = { ...options, allowedRequests: value };
            break;
          case 'P':
            if (options.deniedRequests !== null) return { kind: 'fatal', message: 'Refused requests already set' };
            options = { ...options, deniedRequests: value };
            break;
          case 'u': {
            if (!/^[0-7]+$/.test(value) || parseInt(value, 8) > 0o777) {
              return { kind: 'fatal', message: `Invalid umask "${value}"` };
            }
            options = { ...options, umask: parseInt(value, 8) };
            break;
          }
          default: break;
        }
        break;
      }
      if (!SWITCHES.has(letter)) return { kind: 'usage' };
      if (letter === 'R') options = { ...options, readOnly: true };
      else if (letter === 'e') options = { ...options, logToStderr: true };
      else if (letter === 'h') return { kind: 'usage' };
      else if (letter === 'c') return { kind: 'serve', options, diagnostics };
    }
  }
  return { kind: 'serve', options, diagnostics };
}

export function requestListMatches(list: string, name: string): boolean {
  return list.split(',').some((pattern) => {
    const regex = new RegExp(`^${pattern.trim().replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return regex.test(name);
  });
}

export function requestPermitted(options: SftpServerOptions, name: string, writes: boolean): boolean {
  if (options.readOnly && writes) return false;
  if (options.deniedRequests !== null && requestListMatches(options.deniedRequests, name)) return false;
  if (options.allowedRequests !== null) return requestListMatches(options.allowedRequests, name);
  return true;
}

export function splitCommandWords(commandLine: string): string[] {
  return commandLine.split(' ').filter((word) => word !== '');
}

export function logLevelAtLeast(configured: SftpLogLevel, needed: SftpLogLevel): boolean {
  return SFTP_LOG_LEVELS.indexOf(configured) >= SFTP_LOG_LEVELS.indexOf(needed);
}
