import type { PamLocalTime, PamWritableFiles } from './PamLinuxHost';
import {
  FAILLOCK_DEFAULT_TALLYDIR,
  TALLY_STATUS_RHOST,
  TALLY_STATUS_TTY,
  TALLY_STATUS_VALID,
  parseTally,
  tallyPath,
} from './modules/PamFaillockModule';

export interface FaillockToolHost {
  readFile(path: string): string | null;
  readonly files: Pick<PamWritableFiles, 'writeFile' | 'listDirectory' | 'exists'>;
  localTime(epochMs: number): PamLocalTime;
}

export interface FaillockToolResult {
  readonly output: string;
  readonly exitCode: number;
}

interface Options {
  reset: boolean;
  dir: string;
  user: string | null;
}

const PROGRAM = 'faillock';
const SOURCE_WIDTH = 52;
const USAGE = `Usage: ${PROGRAM} [--dir /path/to/tally-directory] [--user username] [--reset]`;

function parseArguments(args: readonly string[]): Options | string {
  const options: Options = { reset: false, dir: FAILLOCK_DEFAULT_TALLYDIR, user: null };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--dir') {
      const value = args[++index];
      if (value === undefined || value.length === 0) return `${PROGRAM}: No directory supplied.`;
      options.dir = value;
    } else if (argument === '--user') {
      const value = args[++index];
      if (value === undefined || value.length === 0) return `${PROGRAM}: No user name supplied.`;
      options.user = value;
    } else if (argument === '--reset') {
      options.reset = true;
    } else {
      return `${PROGRAM}: Unknown option: ${argument}`;
    }
  }
  return options;
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

function formatWhen(host: FaillockToolHost, epochSeconds: number): string {
  const time = host.localTime(epochSeconds * 1000);
  return `${time.year}-${two(time.month + 1)}-${two(time.day)} ${two(time.hour)}:${two(time.minute)}:${two(time.second)}`;
}

function recordKind(status: number): string {
  if ((status & TALLY_STATUS_RHOST) !== 0) return 'RHOST';
  return (status & TALLY_STATUS_TTY) !== 0 ? 'TTY' : 'SVC';
}

function reportUser(host: FaillockToolHost, options: Options, user: string): string[] | null {
  const path = tallyPath(options.dir, user);
  if (!host.files.exists(path)) return null;
  if (options.reset) {
    host.files.writeFile(path, '');
    return [];
  }
  const lines = [`${user}:`, `${'When'.padEnd(19)} ${'Type'.padEnd(5)} ${'Source'.padEnd(48)} ${'Valid'.padEnd(5)}`];
  for (const record of parseTally(host.readFile(path))) {
    const source = record.source.slice(0, SOURCE_WIDTH).padEnd(SOURCE_WIDTH);
    const valid = (record.status & TALLY_STATUS_VALID) !== 0 ? 'V' : 'I';
    lines.push(`${formatWhen(host, record.time).padEnd(19)} ${recordKind(record.status).padEnd(5)} ${source} ${valid}`);
  }
  return lines;
}

export function runFaillock(args: readonly string[], host: FaillockToolHost): FaillockToolResult {
  const options = parseArguments(args);
  if (typeof options === 'string') return { output: `${options}\n${USAGE}`, exitCode: 1 };
  const users = options.user !== null ? [options.user] : host.files.listDirectory(options.dir);
  if (users === null) return { output: `${PROGRAM}: Error reading tally directory: No such file or directory`, exitCode: 2 };
  const lines: string[] = [];
  for (const user of users) {
    if (user.startsWith('.')) continue;
    lines.push(...(reportUser(host, options, user) ?? []));
  }
  return { output: lines.join('\n'), exitCode: 0 };
}
