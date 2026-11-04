import { bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { actorOf, type ShellContext } from '../LinuxFileCommands';
import { Streams, docsResult, parseSizeWithSuffix, quoteLocale, quoteShell, quotef, readFailureText, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'suffix-length', letter: 'a', takesArgument: true },
  { name: 'additional-suffix', letter: 'A', takesArgument: true },
  { name: 'bytes', letter: 'b', takesArgument: true },
  { name: 'line-bytes', letter: 'C', takesArgument: true },
  { name: 'numeric-suffixes', letter: 'd', takesArgument: false, optionalArgument: true },
  { name: 'hex-suffixes', letter: 'x', takesArgument: false, optionalArgument: true },
  { name: 'elide-empty-files', letter: 'e', takesArgument: false },
  { name: 'filter', letter: 'F', takesArgument: true },
  { name: 'lines', letter: 'l', takesArgument: true },
  { name: 'number', letter: 'n', takesArgument: true },
  { name: 'separator', letter: 't', takesArgument: true },
  { name: 'unbuffered', letter: 'u', takesArgument: false },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

export interface SplitHost {
  runFilter(command: string, file: string, input: string): { output: string; exitCode: number; stderr?: string };
}

type Mode =
  | { kind: 'lines'; count: number }
  | { kind: 'bytes'; size: number }
  | { kind: 'lineBytes'; size: number }
  | { kind: 'chunks'; count: number; select: number | null; style: 'bytes' | 'lines' | 'robin' };

interface Piece { readonly bytes: Uint8Array }

function parseCount(text: string): number | null {
  if (!/^\d+/.test(text)) return null;
  const size = parseSizeWithSuffix(text);
  return size === null || !Number.isSafeInteger(size) ? null : size;
}

function parseChunks(text: string): Extract<Mode, { kind: 'chunks' }> | string {
  const bad = `split: invalid number of chunks: ${quoteLocale(text)}`;
  const parts = text.split('/');
  let style: 'bytes' | 'lines' | 'robin' = 'bytes';
  if (parts[0] === 'l' || parts[0] === 'r') { style = parts[0] === 'l' ? 'lines' : 'robin'; parts.shift(); }
  if (parts.length < 1 || parts.length > 2 || (parts.length === 2 && style === 'bytes' && false)) return bad;
  const totalText = parts[parts.length - 1];
  if (!/^\d+$/.test(totalText) || Number(totalText) === 0) return `split: invalid number of chunks: ${quoteLocale(totalText)}`;
  let select: number | null = null;
  if (parts.length === 2) {
    if (!/^\d+$/.test(parts[0])) return `split: invalid chunk number: ${quoteLocale(parts[0])}`;
    select = Number(parts[0]);
    if (select < 1 || select > Number(totalText)) return `split: invalid chunk number: ${quoteLocale(parts[0])}`;
  }
  return { kind: 'chunks', count: Number(totalText), select, style };
}

function sliceRecords(bytes: Uint8Array, separator: number): Uint8Array[] {
  const records: Uint8Array[] = [];
  let from = 0;
  for (let at = 0; at < bytes.length; at++) {
    if (bytes[at] === separator) { records.push(bytes.subarray(from, at + 1)); from = at + 1; }
  }
  if (from < bytes.length) records.push(bytes.subarray(from));
  return records;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function chunkEnds(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  const extra = total % count;
  const ends: number[] = [];
  let end = 0;
  for (let index = 0; index < count; index++) { end += base + (index < extra ? 1 : 0); ends.push(end); }
  return ends;
}

function buildPieces(bytes: Uint8Array, mode: Mode, separator: number): Piece[] {
  if (mode.kind === 'bytes') {
    const pieces: Piece[] = [];
    for (let at = 0; at < bytes.length; at += mode.size) pieces.push({ bytes: bytes.subarray(at, at + mode.size) });
    return pieces;
  }
  if (mode.kind === 'lines') {
    const records = sliceRecords(bytes, separator);
    const pieces: Piece[] = [];
    for (let at = 0; at < records.length; at += mode.count) pieces.push({ bytes: concat(records.slice(at, at + mode.count)) });
    return pieces;
  }
  if (mode.kind === 'lineBytes') {
    const pieces: Piece[] = [];
    let current: Uint8Array[] = [];
    let length = 0;
    const flush = (): void => { if (current.length > 0) pieces.push({ bytes: concat(current) }); current = []; length = 0; };
    for (const record of sliceRecords(bytes, separator)) {
      let rest = record;
      if (length > 0 && length + rest.length > mode.size) flush();
      while (rest.length > mode.size) { pieces.push({ bytes: rest.subarray(0, mode.size) }); rest = rest.subarray(mode.size); }
      current.push(rest);
      length += rest.length;
    }
    flush();
    return pieces;
  }
  const groups: Uint8Array[][] = Array.from({ length: mode.count }, () => []);
  if (mode.style === 'bytes') {
    const ends = chunkEnds(bytes.length, mode.count);
    let from = 0;
    ends.forEach((end, index) => { groups[index].push(bytes.subarray(from, end)); from = end; });
  } else if (mode.style === 'lines') {
    const ends = chunkEnds(bytes.length, mode.count);
    let start = 0;
    for (const record of sliceRecords(bytes, separator)) {
      let index = ends.findIndex((end) => start < end);
      if (index < 0) index = mode.count - 1;
      groups[index].push(record);
      start += record.length;
    }
  } else {
    sliceRecords(bytes, separator).forEach((record, index) => groups[index % mode.count].push(record));
  }
  return groups.map((parts) => ({ bytes: concat(parts) }));
}

interface SuffixPlan { readonly alphabet: string; readonly length: number; readonly fixed: boolean; readonly start: number }

function suffixAt(plan: SuffixPlan, index: number): string | null {
  const base = plan.alphabet.length;
  let n = index + plan.start;
  let length = plan.length;
  let leading = 0;
  if (plan.fixed) {
    if (n >= base ** length) return null;
  } else {
    while (n >= (base - 1) * base ** (length - 1)) { n -= (base - 1) * base ** (length - 1); leading++; length++; }
  }
  let digits = '';
  for (let place = 0; place < length; place++) { digits = plan.alphabet[n % base] + digits; n = Math.floor(n / base); }
  return plan.alphabet[base - 1].repeat(leading) + digits;
}

export function runSplit(ctx: ShellContext, args: readonly string[], io: CoreutilsIO, host: SplitHost): CoreutilsRun {
  let mode: Mode | null = null;
  let suffixLength: number | null = null;
  let alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let startValue = 0;
  let additional = '';
  let elideEmpty = false;
  let verbose = false;
  let filter: string | null = null;
  let separator = 10;
  const operands: string[] = [];
  const streams = new Streams();
  const plain = (message: string): CoreutilsRun => {
    const single = new Streams();
    single.diagnostic(message);
    single.exitCode = 1;
    return single.result();
  };
  const setMode = (next: Mode): CoreutilsRun | null => {
    if (mode !== null) return usageFailure('split', 'split: cannot split in more than one way');
    mode = next;
    return null;
  };
  for (const item of shortOptions(args, 'a:b:C:dxel:n:t:uv0123456789', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('split', getoptDiagnostic('split', item));
    const value = item.argument ?? '';
    let early: CoreutilsRun | null = null;
    switch (item.letter) {
      case 'H': return docsResult('split', 'help');
      case 'V': return docsResult('split', 'version');
      case 'a':
        if (!/^\d+$/.test(value)) return plain(`split: invalid suffix length: ${quoteLocale(value)}`);
        suffixLength = Number(value) === 0 ? null : Number(value);
        break;
      case 'A':
        if (value.includes('/')) return plain(`split: invalid suffix ${quoteLocale(value)}, contains directory separator`);
        additional = value;
        break;
      case 'b': case 'C': {
        const size = parseCount(value);
        if (size === null || size === 0) return plain(`split: invalid number of bytes: ${quoteLocale(value)}`);
        early = setMode(item.letter === 'b' ? { kind: 'bytes', size } : { kind: 'lineBytes', size });
        break;
      }
      case 'l': {
        const count = parseCount(value);
        if (count === null || count === 0) return plain(`split: invalid number of lines: ${quoteLocale(value)}`);
        early = setMode({ kind: 'lines', count });
        break;
      }
      case 'n': {
        const parsed = parseChunks(value);
        if (typeof parsed === 'string') return plain(parsed);
        early = setMode(parsed);
        break;
      }
      case 'd': alphabet = '0123456789'; if (item.argument !== undefined) startValue = Number.parseInt(value, 10) || 0; break;
      case 'x': alphabet = '0123456789abcdef'; if (item.argument !== undefined) startValue = Number.parseInt(value, 16) || 0; break;
      case 'e': elideEmpty = true; break;
      case 'F': filter = value; break;
      case 't': {
        const spec = value === '\\0' ? '\0' : value;
        if (Array.from(spec).length !== 1) return plain(`split: multi-character separator ${quoteLocale(value)}`);
        separator = spec.charCodeAt(0);
        break;
      }
      case 'v': verbose = true; break;
      default:
        if (/^\d$/.test(item.letter)) {
          const count = Number(item.letter);
          early = setMode({ kind: 'lines', count: count === 0 ? 1 : count });
        }
    }
    if (early !== null) return early;
  }
  if (operands.length > 2) return usageFailure('split', `split: extra operand ${quoteLocale(operands[2])}`);
  const source = operands[0] ?? '-';
  const prefix = operands[1] ?? 'x';
  const effective: Mode = mode ?? { kind: 'lines', count: 1000 };
  const read = source === '-' ? { kind: 'ok' as const, text: io.stdin ?? '' } : io.read(source);
  if (read.kind !== 'ok') return plain(`split: cannot open ${quoteLocale(source)} for reading: ${readFailureText(read)}`);
  const bytes = fileTextToBytes(read.text);
  const pieces = buildPieces(bytes, effective, separator);
  if (effective.kind === 'chunks' && effective.select !== null) {
    const chosen = pieces[effective.select - 1];
    if (chosen !== undefined) streams.stdout(bytesToFileText(chosen.bytes));
    return streams.result();
  }
  const plan: SuffixPlan = {
    alphabet, length: suffixLength ?? 2, fixed: suffixLength !== null, start: startValue,
  };
  const actor = actorOf(ctx);
  let made = 0;
  for (const piece of pieces) {
    if (elideEmpty && piece.bytes.length === 0) continue;
    const suffix = suffixAt(plan, made);
    if (suffix === null) { streams.diagnostic('split: output file suffixes exhausted'); streams.exitCode = 1; return streams.result(); }
    made++;
    const name = `${prefix}${suffix}${additional}`;
    const path = ctx.vfs.path(name, ctx.cwd, actor);
    if (verbose) streams.stdout(`creating file ${quoteShell(name)}\n`);
    const text = bytesToFileText(piece.bytes);
    if (filter !== null) {
      const result = host.runFilter(filter, name, text);
      streams.stdout(result.output);
      if (result.stderr !== undefined && result.stderr !== '') streams.stderr(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
      if (result.exitCode !== 0) {
        streams.diagnostic(`split: with FILE=${name}, exit ${result.exitCode} from command: ${filter}`);
        streams.exitCode = 1;
        return streams.result();
      }
      continue;
    }
    if (path.parent().inode() === null) {
      streams.diagnostic(`split: ${quotef(name)}: No such file or directory`);
      streams.exitCode = 1;
      return streams.result();
    }
    if (!ctx.vfs.writeFile(path.value, text, ctx.uid, ctx.gid, ctx.umask)) {
      streams.diagnostic(`split: ${quotef(name)}: Permission denied`);
      streams.exitCode = 1;
      return streams.result();
    }
  }
  return streams.result();
}
