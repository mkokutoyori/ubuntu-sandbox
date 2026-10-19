const SWITCHES = new Set(['1', '2', '4', '6', 'A', 'a', 'f', 'h', 'N', 'p', 'q', 'r', 'v', 'C']);
const VALUED = new Set(['c', 'D', 'i', 'l', 'o', 's', 'S', 'b', 'B', 'F', 'J', 'P', 'R']);
const PASSED_THROUGH = new Set(['A', '4', '6', 'C']);
const PASSED_WITH_VALUE = new Set(['F', 'J', 'c', 'i', 'o']);
const MAX_LIMIT_KBPS = 100 * 1024 * 1024;

export interface SftpDestination {
  readonly user: string | null;
  readonly host: string;
  readonly port: number | null;
  readonly path: string | null;
}

export interface SftpCommandLine {
  readonly quiet: boolean;
  readonly suppressNotices: boolean;
  readonly batchFile: string | null;
  readonly resumeAll: boolean;
  readonly fsyncAll: boolean;
  readonly preserveAll: boolean;
  readonly recursiveAll: boolean;
  readonly verbosity: number;
  readonly showProgress: boolean;
  readonly directServer: string | null;
  readonly sshProgram: string | null;
  readonly subsystem: string | null;
  readonly sshArguments: readonly string[];
  readonly bufferSize: number | null;
  readonly requests: number | null;
  readonly limitKbps: number | null;
  readonly destination: SftpDestination | null;
  readonly secondOperand: string | null;
}

export type SftpCommandLineOutcome =
  | { readonly kind: 'parsed'; readonly line: SftpCommandLine }
  | { readonly kind: 'usage'; readonly diagnostic: string | null }
  | { readonly kind: 'fatal'; readonly message: string };

function parsePortNumber(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

function splitPath(rest: string): { host: string; path: string | null } {
  const bracket = /^\[([^\]]*)\]:?(.*)$/.exec(rest);
  if (bracket !== null) return { host: bracket[1], path: bracket[2] === '' ? null : bracket[2] };
  const colon = rest.indexOf(':');
  if (colon < 0) return { host: rest, path: null };
  return { host: rest.slice(0, colon), path: rest.slice(colon + 1) };
}

export function parseSftpDestination(argument: string): SftpDestination | null {
  const uri = /^sftp:\/\/(?:([^@/]*)@)?(\[[^\]]*\]|[^:/]*)(?::(\d+))?(\/.*)?$/i.exec(argument);
  if (uri !== null) {
    const host = uri[2].replace(/^\[|\]$/g, '');
    if (host === '') return null;
    const port = uri[3] === undefined ? null : parsePortNumber(uri[3]);
    if (uri[3] !== undefined && port === null) return null;
    const path = uri[4] === undefined ? null : decodeURIComponent(uri[4].replace(/^\//, ''));
    return { user: uri[1] === undefined ? null : uri[1], host, port, path: path === '' ? null : path };
  }
  const at = argument.lastIndexOf('@', argument.indexOf(':') < 0 ? argument.length : argument.indexOf(':'));
  const user = at < 0 ? null : argument.slice(0, at);
  const rest = at < 0 ? argument : argument.slice(at + 1);
  const { host, path } = splitPath(rest);
  return { user: user === '' ? null : user, host, port: null, path };
}

export function parseSftpCommandLine(args: readonly string[]): SftpCommandLineOutcome {
  const sshArguments: string[] = [];
  let quiet = false;
  let suppressNotices = false;
  let noisy = false;
  let showProgress = true;
  let batchFile: string | null = null;
  let resumeAll = false;
  let fsyncAll = false;
  let preserveAll = false;
  let recursiveAll = false;
  let verbosity = 0;
  let port: number | null = null;
  let directServer: string | null = null;
  let sshProgram: string | null = null;
  let subsystem: string | null = null;
  let bufferSize: number | null = null;
  let requests: number | null = null;
  let limitKbps: number | null = null;
  let index = 0;
  for (; index < args.length; index++) {
    const word = args[index];
    if (word === '--') {
      index++;
      break;
    }
    if (!word.startsWith('-') || word === '-') break;
    for (let at = 1; at < word.length; at++) {
      const letter = word[at];
      if (VALUED.has(letter)) {
        const attached = word.slice(at + 1);
        const value = attached !== '' ? attached : args[++index];
        if (value === undefined) {
          return { kind: 'usage', diagnostic: `sftp: option requires an argument -- '${letter}'` };
        }
        if (PASSED_WITH_VALUE.has(letter)) {
          sshArguments.push(`-${letter}`, value);
        } else if (letter === 'P') {
          const parsed = parsePortNumber(value);
          if (parsed === null) return { kind: 'fatal', message: `Bad port "${value}"\n` };
          port = parsed;
        } else if (letter === 'B') {
          if (!/^\d+$/.test(value) || Number(value) === 0) return { kind: 'fatal', message: `Invalid buffer size "${value}"` };
          bufferSize = Number(value);
        } else if (letter === 'b') {
          if (batchFile !== null) return { kind: 'fatal', message: 'Batch file already specified.' };
          batchFile = value;
          showProgress = false;
          quiet = true;
          sshArguments.push('-o', 'BatchMode=yes');
        } else if (letter === 'R') {
          if (!/^\d+$/.test(value) || Number(value) === 0) return { kind: 'fatal', message: `Invalid number of requests "${value}"` };
          requests = Number(value);
        } else if (letter === 'l') {
          if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_LIMIT_KBPS) return { kind: 'usage', diagnostic: null };
          limitKbps = Number(value) * 1024;
        } else if (letter === 's') {
          subsystem = value;
        } else if (letter === 'S') {
          sshProgram = value;
        } else if (letter === 'D') {
          directServer = value;
        }
        break;
      }
      if (!SWITCHES.has(letter)) return { kind: 'usage', diagnostic: `sftp: invalid option -- '${letter}'` };
      if (PASSED_THROUGH.has(letter)) sshArguments.push(`-${letter}`);
      switch (letter) {
        case 'q':
          quiet = true;
          suppressNotices = true;
          showProgress = false;
          sshArguments.push('-q');
          break;
        case 'v':
          verbosity++;
          break;
        case '1':
          return { kind: 'fatal', message: 'SSH protocol v.1 is no longer supported' };
        case 'a': resumeAll = true; break;
        case 'f': fsyncAll = true; break;
        case 'N': noisy = true; break;
        case 'p': preserveAll = true; break;
        case 'r': recursiveAll = true; break;
        case 'h': return { kind: 'usage', diagnostic: null };
        default: break;
      }
    }
  }
  if (noisy) quiet = false;
  if (port !== null) sshArguments.push('-p', String(port));
  const operands = args.slice(index);
  if (directServer === null && (operands.length === 0 || operands.length > 2)) return { kind: 'usage', diagnostic: null };
  let destination: SftpDestination | null = null;
  if (directServer === null) {
    destination = parseSftpDestination(operands[0]);
    if (destination === null) return { kind: 'usage', diagnostic: null };
    if (destination.host === '') return { kind: 'usage', diagnostic: 'Missing hostname' };
    if (destination.port !== null) {
      const at = sshArguments.indexOf('-p');
      if (at >= 0) sshArguments.splice(at, 2);
      sshArguments.push('-p', String(destination.port));
    }
  }
  if (verbosity > 0) sshArguments.push(...Array<string>(Math.min(verbosity, 3)).fill('-v'));
  return {
    kind: 'parsed',
    line: {
      quiet, suppressNotices, batchFile, resumeAll, fsyncAll, preserveAll, recursiveAll, verbosity, showProgress,
      directServer, sshProgram, subsystem, sshArguments, bufferSize, requests, limitKbps,
      destination, secondOperand: operands[1] ?? null,
    },
  };
}
