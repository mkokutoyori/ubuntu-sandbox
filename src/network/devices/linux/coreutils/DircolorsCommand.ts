import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { DIRCOLORS_DATABASE } from './DircolorsDatabase';
import { Streams, docsResult, quoteLocale, quotef, readFailureText, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'bourne-shell', letter: 'b', takesArgument: false },
  { name: 'sh', letter: 'b', takesArgument: false },
  { name: 'csh', letter: 'c', takesArgument: false },
  { name: 'c-shell', letter: 'c', takesArgument: false },
  { name: 'print-database', letter: 'p', takesArgument: false },
  { name: 'print-ls-colors', letter: 'P', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const SLACK_CODES = ['NORMAL', 'NORM', 'FILE', 'RESET', 'DIR', 'LNK', 'LINK', 'SYMLINK', 'ORPHAN', 'MISSING', 'FIFO', 'PIPE', 'SOCK', 'BLK', 'BLOCK',
  'CHR', 'CHAR', 'DOOR', 'EXEC', 'LEFT', 'LEFTCODE', 'RIGHT', 'RIGHTCODE', 'END', 'ENDCODE', 'SUID', 'SETUID', 'SGID', 'SETGID', 'STICKY',
  'OTHER_WRITABLE', 'OWR', 'STICKY_OTHER_WRITABLE', 'OWT', 'CAPABILITY', 'MULTIHARDLINK', 'CLRTOEOL'];
const LS_CODES = ['no', 'no', 'fi', 'rs', 'di', 'ln', 'ln', 'ln', 'or', 'mi', 'pi', 'pi', 'so', 'bd', 'bd', 'cd', 'cd', 'do', 'ex', 'lc', 'lc', 'rc', 'rc', 'ec', 'ec',
  'su', 'su', 'sg', 'sg', 'st', 'ow', 'ow', 'tw', 'tw', 'ca', 'mh', 'cl'];

export interface DircolorsEnvironment {
  readonly shell: string;
  readonly term: string;
  readonly colorterm: string;
}

function globMatches(pattern: string, text: string): boolean {
  let source = '';
  for (let at = 0; at < pattern.length; at++) {
    const ch = pattern[at];
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else if (ch === '[') {
      const end = pattern.indexOf(']', at + 2);
      if (end < 0) source += '\\[';
      else { source += `[${pattern.slice(at + 1, end).replace(/^!/, '^')}]`; at = end; }
    } else if (ch === '\\' && at + 1 < pattern.length) source += pattern[++at].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 's').test(text);
}

function parseLine(line: string): { keyword: string | null; argument: string | null } {
  let at = 0;
  while (at < line.length && /\s/.test(line[at])) at++;
  if (at >= line.length || line[at] === '#') return { keyword: null, argument: null };
  const start = at;
  while (at < line.length && !/\s/.test(line[at])) at++;
  const keyword = line.slice(start, at);
  if (at >= line.length) return { keyword, argument: null };
  do { at++; } while (at < line.length && /\s/.test(line[at]));
  if (at >= line.length || line[at] === '#') return { keyword, argument: null };
  const argumentStart = at;
  while (at < line.length && line[at] !== '#') at++;
  let end = at - 1;
  while (end >= argumentStart && /\s/.test(line[end])) end--;
  return { keyword, argument: line.slice(argumentStart, end + 1) };
}

export function runDircolors(args: readonly string[], io: CoreutilsIO, environment: DircolorsEnvironment): CoreutilsRun {
  let syntax: 'unknown' | 'bourne' | 'c' = 'unknown';
  let printDatabase = false;
  let printLsColors = false;
  const operands: string[] = [];
  const streams = new Streams();
  for (const item of shortOptions(args, 'bcp', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('dircolors', getoptDiagnostic('dircolors', item));
    switch (item.letter) {
      case 'H': return docsResult('dircolors', 'help');
      case 'V': return docsResult('dircolors', 'version');
      case 'b': syntax = 'bourne'; break;
      case 'c': syntax = 'c'; break;
      case 'p': printDatabase = true; break;
      case 'P': printLsColors = true; break;
      default: break;
    }
  }
  if ((printDatabase || printLsColors) && syntax !== 'unknown') {
    return usageFailure('dircolors', 'dircolors: the options to output non shell syntax,\nand to select a shell syntax are mutually exclusive');
  }
  if (printDatabase && printLsColors) return usageFailure('dircolors', 'dircolors: options --print-database and --print-ls-colors are mutually exclusive');
  if ((printDatabase ? 0 : 1) < operands.length) {
    const lines = [`dircolors: extra operand ${quoteLocale(operands[printDatabase ? 0 : 1])}`];
    if (printDatabase) lines.push('file operands cannot be combined with --print-database (-p)');
    return usageFailure('dircolors', lines.join('\n'));
  }
  if (printDatabase) {
    streams.stdout(`${DIRCOLORS_DATABASE.join('\n')}\n`);
    return streams.result();
  }
  if (syntax === 'unknown' && !printLsColors) {
    if (environment.shell === '') {
      streams.diagnostic('dircolors: no SHELL environment variable, and no shell type option given');
      streams.exitCode = 1;
      return streams.result();
    }
    const base = environment.shell.slice(environment.shell.lastIndexOf('/') + 1);
    syntax = base === 'csh' || base === 'tcsh' ? 'c' : 'bourne';
  }
  let source: readonly string[];
  let filename: string | null = null;
  if (operands.length === 0) source = DIRCOLORS_DATABASE;
  else {
    filename = operands[0];
    const read = filename === '-' ? { kind: 'ok' as const, text: io.stdin ?? '' } : io.read(filename);
    if (read.kind !== 'ok') {
      streams.diagnostic(`dircolors: ${quotef(filename)}: ${readFailureText(read)}`);
      streams.exitCode = 1;
      return streams.result();
    }
    const lines = read.text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    source = lines;
  }
  let accumulated = '';
  const quoted = (text: string): string => {
    if (printLsColors) return text;
    let out = '';
    let needBackslash = true;
    for (const ch of text) {
      if (ch === '\'') { out += "'\\''"; needBackslash = true; continue; }
      if (ch === '\\' || ch === '^') { needBackslash = !needBackslash; out += ch; continue; }
      if ((ch === ':' || ch === '=') && needBackslash) out += '\\';
      needBackslash = true;
      out += ch;
    }
    return out;
  };
  const append = (prefix: string, item: string, argument: string): void => {
    if (printLsColors) accumulated += `\u001b[${argument}m`;
    accumulated += prefix + quoted(item) + (printLsColors ? '\t' : '=') + quoted(argument) + (printLsColors ? '\u001b[0m\n' : ':');
  };
  let ok = true;
  let state: 'no' | 'yes' | 'sure' | 'global' = 'global';
  const term = environment.term === '' ? 'none' : environment.term;
  source.forEach((line, index) => {
    const { keyword, argument } = parseLine(line);
    if (keyword === null) return;
    const where = filename === null ? '<internal>' : quotef(filename);
    if (argument === null) {
      streams.diagnostic(`dircolors: ${filename === null ? 'null' : quotef(filename)}:${index + 1}: invalid line;  missing second token`);
      ok = false;
      return;
    }
    const upper = keyword.toUpperCase();
    let unrecognized = false;
    if (upper === 'TERM') {
      if (state !== 'sure') state = globMatches(argument, term) ? 'sure' : 'no';
    } else if (upper === 'COLORTERM') {
      if (state !== 'sure') state = globMatches(argument, environment.colorterm) ? 'sure' : 'no';
    } else {
      if (state === 'sure') state = 'yes';
      if (state !== 'no') {
        if (keyword[0] === '.') append('*', keyword, argument);
        else if (keyword[0] === '*') append('', keyword, argument);
        else if (['OPTIONS', 'COLOR', 'EIGHTBIT'].includes(upper)) { /* ignored */ } else {
          const code = SLACK_CODES.indexOf(upper);
          if (code >= 0) append('', LS_CODES[code], argument);
          else unrecognized = true;
        }
      } else unrecognized = true;
    }
    if (unrecognized && (state === 'sure' || state === 'yes')) {
      streams.diagnostic(`dircolors: ${where}:${index + 1}: unrecognized keyword ${keyword}`);
      ok = false;
    }
  });
  if (ok) {
    const prefix = syntax === 'bourne' ? 'LS_COLORS=\'' : 'setenv LS_COLORS \'';
    const suffix = syntax === 'bourne' ? '\';\nexport LS_COLORS\n' : '\'\n';
    streams.stdout(printLsColors ? accumulated : `${prefix}${accumulated}${suffix}`);
  } else streams.exitCode = 1;
  return streams.result();
}
