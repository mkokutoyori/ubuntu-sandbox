export type SftpVerb =
  | 'chdir' | 'chgrp' | 'chmod' | 'chown' | 'df' | 'get' | 'help' | 'lchdir' | 'link' | 'lls' | 'lmkdir'
  | 'lpwd' | 'ls' | 'lumask' | 'mkdir' | 'put' | 'pwd' | 'quit' | 'reget' | 'rename' | 'reput' | 'rm'
  | 'rmdir' | 'shell' | 'symlink' | 'version' | 'progress';

const COMMANDS: Readonly<Record<string, SftpVerb>> = {
  bye: 'quit', cd: 'chdir', chdir: 'chdir', chgrp: 'chgrp', chmod: 'chmod', chown: 'chown', df: 'df', dir: 'ls',
  exit: 'quit', get: 'get', help: 'help', lcd: 'lchdir', lchdir: 'lchdir', lls: 'lls', lmkdir: 'lmkdir', ln: 'link',
  lpwd: 'lpwd', ls: 'ls', lumask: 'lumask', mkdir: 'mkdir', mget: 'get', mput: 'put', progress: 'progress',
  put: 'put', pwd: 'pwd', quit: 'quit', reget: 'reget', rename: 'rename', reput: 'reput', rm: 'rm',
  rmdir: 'rmdir', symlink: 'symlink', version: 'version', '!': 'shell', '?': 'help',
};

export const SFTP_COMMAND_NAMES: readonly string[] = Object.keys(COMMANDS);

export interface SftpListingFlags {
  readonly long: boolean;
  readonly short: boolean;
  readonly numeric: boolean;
  readonly siUnits: boolean;
  readonly showAll: boolean;
  readonly sort: 'name' | 'time' | 'size' | 'none';
  readonly reverse: boolean;
}

export interface SftpParsedCommand {
  readonly verb: SftpVerb;
  readonly ignoreErrors: boolean;
  readonly disableEcho: boolean;
  readonly resume: boolean;
  readonly fsync: boolean;
  readonly human: boolean;
  readonly inodes: boolean;
  readonly legacy: boolean;
  readonly preserve: boolean;
  readonly recursive: boolean;
  readonly symbolic: boolean;
  readonly listing: SftpListingFlags;
  readonly number: number;
  readonly path1: string | null;
  readonly path2: string | null;
  readonly rest: string;
  readonly command: string;
}

export type SftpParseOutcome =
  | { readonly kind: 'blank'; readonly disableEcho: boolean; readonly ignoreErrors: boolean }
  | { readonly kind: 'invalid'; readonly diagnostic: string; readonly disableEcho: boolean; readonly ignoreErrors: boolean }
  | { readonly kind: 'command'; readonly command: SftpParsedCommand };

const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_LENGTH = 8192;
const WHITESPACE = /\s/;

export function makeArguments(line: string, literalBackslash = false): string[] | string {
  if (line.length > MAX_ARGUMENT_LENGTH - 1) return 'string too long';
  const args: string[] = [];
  let state: 'start' | 'single' | 'double' | 'plain' = 'start';
  let current = '';
  for (let i = 0; ; i++) {
    if (args.length >= MAX_ARGUMENTS) return 'Too many arguments.';
    const char = line[i];
    if (char !== undefined && WHITESPACE.test(char)) {
      if (state === 'plain') {
        args.push(current);
        current = '';
        state = 'start';
      } else if (state !== 'start') {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      const quote = char === '"' ? 'double' : 'single';
      if (state === 'start') state = quote;
      else if (state === 'plain') state = quote;
      else if (state === quote) state = 'plain';
      else current += char;
    } else if (char === '\\' && literalBackslash && state !== 'single' && state !== 'double') {
      if (state === 'start') state = 'plain';
      current += char;
    } else if (char === '\\') {
      const next = line[i + 1];
      if (state === 'single' || state === 'double') {
        const quote = state === 'single' ? "'" : '"';
        if (next === quote) {
          i++;
          current += next;
        } else if (next === '?' || next === '[' || next === '*') {
          current += `\\\\\\${next}`;
          i++;
        } else {
          current += char;
          i++;
          current += line[i] ?? '';
        }
      } else {
        if (state === 'start') state = 'plain';
        if (next === '?' || next === '[' || next === '*' || next === '\\') {
          current += char;
          i++;
          current += line[i];
        } else {
          i++;
          current += line[i] ?? '';
        }
      }
    } else if (char === '#') {
      if (state === 'single' || state === 'double') {
        current += char;
      } else {
        if (state === 'plain') args.push(current);
        return args;
      }
    } else if (char === undefined) {
      if (state === 'single' || state === 'double') return 'Unterminated quoted argument';
      if (state === 'plain') args.push(current);
      return args;
    } else {
      if (state === 'start') state = 'plain';
      if ((state === 'single' || state === 'double') && (char === '?' || char === '[' || char === '*')) {
        current += `\\${char}`;
      } else {
        current += char;
      }
    }
  }
}

export function undoGlobEscape(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\') {
      out += text[i];
      continue;
    }
    i++;
    const next = text[i];
    if (next === undefined) {
      out += '\\';
    } else if (next === '?' || next === '[' || next === '*' || next === '\\') {
      out += next;
    } else {
      out += `\\${next}`;
    }
  }
  return out;
}

interface FlagScan {
  readonly flags: ReadonlySet<string>;
  readonly index: number;
}

function scanFlags(args: readonly string[], allowed: string): FlagScan | { readonly invalid: string } {
  const flags = new Set<string>();
  let index = 1;
  for (; index < args.length; index++) {
    const word = args[index];
    if (word === '--') {
      index++;
      break;
    }
    if (!word.startsWith('-') || word === '-') break;
    for (const letter of word.slice(1)) {
      if (!allowed.includes(letter)) return { invalid: letter };
      flags.add(letter);
    }
  }
  return { flags, index };
}

function listingFlags(flags: ReadonlySet<string>, order: string): SftpListingFlags {
  let long = false;
  let short = false;
  let numeric = false;
  let siUnits = false;
  let showAll = false;
  let reverse = false;
  let sort: SftpListingFlags['sort'] = 'name';
  for (const letter of order) {
    switch (letter) {
      case '1': short = true; long = false; numeric = false; siUnits = false; break;
      case 'S': sort = 'size'; break;
      case 'a': showAll = true; break;
      case 'f': sort = 'none'; break;
      case 'h': siUnits = true; break;
      case 'l': short = false; long = true; break;
      case 'n': short = false; long = true; numeric = true; break;
      case 'r': reverse = true; break;
      case 't': sort = 'time'; break;
      default: break;
    }
  }
  void flags;
  return { long, short, numeric, siUnits, showAll, sort, reverse };
}

const NO_LISTING: SftpListingFlags = {
  long: false, short: false, numeric: false, siUnits: false, showAll: false, sort: 'name', reverse: false,
};

function scanLsOrder(args: readonly string[]): { order: string; index: number } | { invalid: string } {
  let order = '';
  let index = 1;
  for (; index < args.length; index++) {
    const word = args[index];
    if (word === '--') {
      index++;
      break;
    }
    if (!word.startsWith('-') || word === '-') break;
    for (const letter of word.slice(1)) {
      if (!'1Safhlnrt'.includes(letter)) return { invalid: letter };
      order += letter;
    }
  }
  return { order, index };
}

function strtoll(text: string, base: number): number | null {
  const pattern = base === 8 ? /^[+-]?[0-7]+$/ : /^[+-]?\d+$/;
  if (!pattern.test(text)) return null;
  const value = parseInt(text, base === 0 ? 10 : base);
  return Number.isNaN(value) ? null : value;
}

export function parseSftpLine(line: string, literalBackslash = false): SftpParseOutcome {
  let rest = line.replace(/^[ \t\r\n]+/, '');
  let ignoreErrors = false;
  let disableEcho = false;
  while (rest[0] === '-' || rest[0] === '@') {
    if (rest[0] === '-') ignoreErrors = true;
    else disableEcho = true;
    rest = rest.slice(1);
  }
  rest = rest.replace(/^[ \t\r\n]+/, '');
  if (rest === '' || rest[0] === '#') return { kind: 'blank', disableEcho, ignoreErrors };
  const args = makeArguments(rest, literalBackslash);
  if (typeof args === 'string') return { kind: 'invalid', diagnostic: args, disableEcho, ignoreErrors };
  const word = args[0];
  const known = word === undefined ? undefined : COMMANDS[word.toLowerCase()];
  let verb: SftpVerb | undefined = known;
  let command = word ?? '';
  let remainder = rest;
  if (rest[0] === '!') {
    verb = 'shell';
    remainder = rest.slice(1);
  } else if (verb === undefined) {
    return { kind: 'invalid', diagnostic: 'Invalid command.', disableEcho, ignoreErrors };
  }
  const base = {
    ignoreErrors, disableEcho, resume: false, fsync: false, human: false, inodes: false, legacy: false,
    preserve: false, recursive: false, symbolic: false, listing: NO_LISTING, number: 0,
    path1: null as string | null, path2: null as string | null, rest: remainder, command,
  };
  const invalid = (diagnostic: string): SftpParseOutcome => ({ kind: 'invalid', diagnostic, disableEcho, ignoreErrors });
  const done = (extra: Partial<SftpParsedCommand> = {}): SftpParseOutcome => ({
    kind: 'command', command: { ...base, verb: verb!, ...extra },
  });
  switch (verb) {
    case 'get': case 'reget': case 'reput': case 'put': {
      const scan = scanFlags(args, 'afPpRr');
      if ('invalid' in scan) return invalid(`${command}: Invalid flag -${scan.invalid}`);
      if (args.length - scan.index < 1) return invalid(`You must specify at least one path after a ${command} command.`);
      const second = args.length - scan.index > 1 ? undoGlobEscape(args[scan.index + 1]) : null;
      return done({
        resume: scan.flags.has('a'), fsync: scan.flags.has('f'),
        preserve: scan.flags.has('p') || scan.flags.has('P'), recursive: scan.flags.has('r') || scan.flags.has('R'),
        path1: args[scan.index], path2: second,
      });
    }
    case 'link': case 'rename': case 'symlink': {
      const allowed = verb === 'link' ? 's' : verb === 'rename' ? 'l' : '';
      const scan = scanFlags(args, allowed);
      if ('invalid' in scan) return invalid(`${command}: Invalid flag -${scan.invalid}`);
      if (args.length - scan.index < 2) return invalid(`You must specify two paths after a ${command} command.`);
      return done({
        symbolic: scan.flags.has('s'), legacy: scan.flags.has('l'),
        path1: undoGlobEscape(args[scan.index]), path2: undoGlobEscape(args[scan.index + 1]),
      });
    }
    case 'rm': case 'mkdir': case 'rmdir': case 'lmkdir': case 'chdir': case 'lchdir': {
      const scan = scanFlags(args, '');
      if ('invalid' in scan) return invalid(`${command}: Invalid flag -${scan.invalid}`);
      const mandatory = verb === 'rm' || verb === 'mkdir' || verb === 'rmdir' || verb === 'lmkdir';
      if (args.length - scan.index < 1) {
        if (!mandatory) return done();
        return invalid(`You must specify a path after a ${command} command.`);
      }
      const path = verb === 'rm' ? args[scan.index] : undoGlobEscape(args[scan.index]);
      return done({ path1: path });
    }
    case 'df': {
      const scan = scanFlags(args, 'hi');
      if ('invalid' in scan) return invalid(`${command}: Invalid flag -${scan.invalid}`);
      return done({
        human: scan.flags.has('h'), inodes: scan.flags.has('i'),
        path1: args.length - scan.index < 1 ? null : undoGlobEscape(args[scan.index]),
      });
    }
    case 'ls': {
      const scan = scanLsOrder(args);
      if ('invalid' in scan) return invalid(`ls: Invalid flag -${scan.invalid}`);
      return done({
        listing: listingFlags(new Set(), scan.order), path1: args.length - scan.index > 0 ? args[scan.index] : null,
      });
    }
    case 'lls': {
      const afterCommand = rest.slice(command.length).replace(/^[ \t\r\n]+/, '');
      return done({ rest: afterCommand });
    }
    case 'shell':
      return done();
    case 'lumask': case 'chmod': case 'chown': case 'chgrp': {
      const scan = scanFlags(args, 'h');
      if ('invalid' in scan) return invalid(`${command}: Invalid flag -${scan.invalid}`);
      const needNumber = `You must supply a numeric argument to the ${command} command.`;
      if (args.length - scan.index < 1) return invalid(needNumber);
      const value = strtoll(args[scan.index], verb === 'lumask' || verb === 'chmod' ? 8 : 0);
      if (value === null || value < 0 || value > 0xffffffff) return invalid(needNumber);
      if (verb === 'lumask') return done({ number: value });
      if (args.length - scan.index < 2) return invalid(`You must specify a path after a ${command} command.`);
      return done({ number: value, human: scan.flags.has('h'), path1: args[scan.index + 1] });
    }
    case 'quit': case 'pwd': case 'lpwd': case 'help': case 'version': case 'progress': {
      const scan = scanFlags(args, '');
      if ('invalid' in scan) return invalid(`${command}: Invalid flag -${scan.invalid}`);
      return done();
    }
    default:
      return invalid('Invalid command.');
  }
}
