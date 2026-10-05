import type { WinFileCommandContext } from './WinFileCommands';
import { wildcardToRegex } from '@/powershell/runtime/PSWildcard';

export const COMP_HELP = [
  'Compares the contents of two files or sets of files byte by byte.',
  '',
  'COMP [data1] [data2] [/D] [/A] [/L] [/N=number] [/C] [/OFF[LINE]]',
  '',
  '  data1     Specifies location and name(s) of first file(s) to compare.',
  '  data2     Specifies location and name(s) of second files to compare.',
  '  /D        Displays differences in decimal format. (The default format is',
  '            hexadecimal.)',
  '  /A        Displays differences as characters.',
  '  /L        Displays line numbers for differences, instead of byte offset.',
  '  /N=number Compares only the first specified number of lines in each file.',
  '  /C        Disregards case of ASCII letters when comparing files.',
  '  /OFF[LINE] Do not skip files with offline attribute set.',
  '',
  'To compare sets of files, use wildcards in data1 and data2 parameters.',
].join('\n');

const MAXIMUM_MISMATCHES = 10;
const MORE_FILES = 'Compare more files (Y/N) ? ';

interface CompOptions {
  decimal: boolean;
  characters: boolean;
  lineNumbers: boolean;
  lineLimit: number | null;
  ignoreCase: boolean;
}

interface Outcome {
  readonly lines: string[];
  readonly exitCode: number;
}

function parseOptions(tokens: readonly string[]): { options: CompOptions; invalid: string | null } {
  const options: CompOptions = { decimal: false, characters: false, lineNumbers: false, lineLimit: null, ignoreCase: false };
  let invalid: string | null = null;
  for (const token of tokens) {
    const lowered = token.toLowerCase();
    if (lowered === '/d') options.decimal = true;
    else if (lowered === '/a') options.characters = true;
    else if (lowered === '/l') options.lineNumbers = true;
    else if (lowered === '/c') options.ignoreCase = true;
    else if (lowered === '/off' || lowered === '/offline') continue;
    else if (/^\/n=\d+$/.test(lowered)) options.lineLimit = Number(lowered.slice(3));
    else invalid ??= token;
  }
  return { options, invalid };
}

function bytesOf(text: string, options: CompOptions): Uint8Array {
  const limited = options.lineLimit === null ? text : text.split('\n').slice(0, options.lineLimit).join('\n');
  return new TextEncoder().encode(limited);
}

function foldedByte(byte: number, options: CompOptions): number {
  return options.ignoreCase && byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte;
}

function renderByte(byte: number, options: CompOptions): string {
  if (options.characters) return String.fromCharCode(byte);
  return options.decimal ? String(byte) : byte.toString(16).toUpperCase().padStart(2, '0');
}

function lineOf(bytes: Uint8Array, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) if (bytes[index] === 0x0a) line++;
  return line;
}

function compareFiles(ctx: WinFileCommandContext, nameA: string, nameB: string, options: CompOptions): Outcome {
  const lines = [`Comparing ${nameA} and ${nameB}...`];
  const first = ctx.fs.readFile(ctx.fs.normalizePath(nameA, ctx.cwd));
  if (!first.ok) return { lines: [...lines, `Can't find/open file: ${nameA}`], exitCode: 2 };
  const second = ctx.fs.readFile(ctx.fs.normalizePath(nameB, ctx.cwd));
  if (!second.ok) return { lines: [...lines, `Can't find/open file: ${nameB}`], exitCode: 2 };
  const left = bytesOf(first.content ?? '', options);
  const right = bytesOf(second.content ?? '', options);
  if (left.length !== right.length) return { lines: [...lines, 'Files are different sizes.'], exitCode: 1 };

  let mismatches = 0;
  for (let offset = 0; offset < left.length && mismatches < MAXIMUM_MISMATCHES; offset++) {
    if (foldedByte(left[offset], options) === foldedByte(right[offset], options)) continue;
    mismatches++;
    const where = options.lineNumbers
      ? `LINE ${lineOf(left, offset)}`
      : `OFFSET ${options.decimal ? offset : offset.toString(16).toUpperCase()}`;
    lines.push(`Compare error at ${where}`, `file1 = ${renderByte(left[offset], options)}`, `file2 = ${renderByte(right[offset], options)}`);
  }
  if (mismatches === 0) return { lines: [...lines, 'Files compare OK'], exitCode: 0 };
  if (mismatches === MAXIMUM_MISMATCHES) lines.push(`${MAXIMUM_MISMATCHES} Mismatches - ending compare`);
  return { lines, exitCode: 1 };
}

function directoryOf(spec: string): { directory: string; pattern: string } {
  const separator = spec.lastIndexOf('\\');
  return { directory: spec.slice(0, separator + 1), pattern: spec.slice(separator + 1) };
}

function expand(ctx: WinFileCommandContext, spec: string): string[] {
  const absolute = ctx.fs.normalizePath(spec, ctx.cwd);
  if (ctx.fs.isDirectory(absolute)) return ctx.fs.listDirectory(absolute).filter(item => item.entry.type === 'file').map(item => `${spec.replace(/\\$/, '')}\\${item.name}`);
  const { directory, pattern } = directoryOf(spec);
  if (!/[*?]/.test(pattern)) return [spec];
  const matcher = wildcardToRegex(pattern);
  return ctx.fs.listDirectory(ctx.fs.normalizePath(directory === '' ? '.' : directory, ctx.cwd))
    .filter(item => item.entry.type === 'file' && matcher.test(item.name))
    .map(item => `${directory}${item.name}`);
}

function pairsOf(ctx: WinFileCommandContext, first: string, second: string): Array<[string, string]> {
  const left = expand(ctx, first);
  const secondIsSet = /[*?]/.test(directoryOf(second).pattern) || ctx.fs.isDirectory(ctx.fs.normalizePath(second, ctx.cwd));
  if (!secondIsSet) return left.map(name => [name, second]);
  const right = expand(ctx, second);
  if (right.length > 0 && left.length > 0 && ctx.fs.isDirectory(ctx.fs.normalizePath(second, ctx.cwd))) {
    return left.map(name => [name, `${second.replace(/\\$/, '')}\\${directoryOf(name).pattern}`]);
  }
  return left.map((name, index): [string, string] => [name, right[index] ?? second]);
}

async function prompt(ctx: WinFileCommandContext, output: string[], text: string): Promise<string | null> {
  const preceding = output.length > 0 ? output.splice(0).join('\n') : undefined;
  const asked = await ctx.ask(text, preceding);
  if (!asked.flushed) output.push(...(preceding === undefined ? [] : [preceding]), text);
  return asked.answer;
}

export async function cmdComp(ctx: WinFileCommandContext, args: string[]): Promise<string> {
  if (args.length === 1 && args[0] === '/?') return COMP_HELP;
  const switches = args.filter(argument => argument.startsWith('/'));
  const names = args.filter(argument => !argument.startsWith('/'));
  const { options, invalid } = parseOptions(switches);
  if (invalid !== null) {
    ctx.setExitCode(1);
    return `Invalid switch - ${invalid}`;
  }

  const output: string[] = [];
  let first = names[0];
  let second = names[1];
  let exitCode = 0;
  let activeOptions = options;
  for (;;) {
    if (first === undefined || second === undefined) {
      const asked = await prompt(ctx, output, 'Name of first file to compare: ');
      if (asked === null || asked.trim() === '') break;
      first = asked.trim();
      second = ((await prompt(ctx, output, 'Name of second file to compare: ')) ?? '').trim();
      const extra = (await prompt(ctx, output, 'Option(s): ')) ?? '';
      activeOptions = parseOptions(extra.split(/\s+/).filter(token => token !== '')).options;
    }
    const pairs = pairsOf(ctx, first!, second!);
    if (pairs.length === 0) {
      output.push(`Can't find/open file: ${first}`);
      exitCode = 2;
    }
    for (const [left, right] of pairs) {
      if (output.length > 0) output.push('');
      const outcome = compareFiles(ctx, left, right, activeOptions);
      output.push(...outcome.lines);
      exitCode = Math.max(exitCode, outcome.exitCode);
    }
    output.push('');
    const answer = await prompt(ctx, output, MORE_FILES);
    if (answer === null || !/^y/i.test(answer.trim())) break;
    first = undefined;
    second = undefined;
  }
  ctx.setExitCode(exitCode);
  return output.join('\n');
}
