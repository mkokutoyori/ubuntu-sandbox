import { bytesToFileText } from '@/crypto/encoding';
import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { Streams, docsResult, quoteLocale, quotef, readFailureText, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'force', letter: 'f', takesArgument: false },
  { name: 'iterations', letter: 'n', takesArgument: true },
  { name: 'size', letter: 's', takesArgument: true },
  { name: 'remove', letter: 'u', takesArgument: false, optionalArgument: true },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'exact', letter: 'x', takesArgument: false },
  { name: 'zero', letter: 'z', takesArgument: false },
  { name: 'random-source', letter: 'R', takesArgument: true },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const BLOCK = 4096;
const SIZE_SUFFIXES: Readonly<Record<string, number>> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3 };

function parseSize(text: string): number | null {
  const match = /^(\d+)([A-Za-z]*)$/.exec(text);
  if (match === null) return null;
  if (match[2] === '') return Number(match[1]);
  const factor = SIZE_SUFFIXES[match[2].toUpperCase()] ?? (match[2] === 'c' ? 1 : match[2] === 'b' ? 512 : undefined);
  return factor === undefined ? null : Number(match[1]) * factor;
}

export function runShred(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  let passes = 3;
  let verbose = false;
  let remove = false;
  let zero = false;
  let exact = false;
  let size: number | null = null;
  const operands: string[] = [];
  const streams = new Streams();
  const stop = (line: string): CoreutilsRun => {
    streams.diagnostic(line);
    streams.exitCode = 1;
    return streams.result();
  };
  for (const item of shortOptions(args, 'fn:s:uvxz', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('shred', getoptDiagnostic('shred', item));
    const value = item.argument ?? '';
    switch (item.letter) {
      case 'H': return docsResult('shred', 'help');
      case 'V': return docsResult('shred', 'version');
      case 'f': break;
      case 'n':
        if (!/^\d+$/.test(value)) return stop(`shred: invalid number of passes: ${quoteLocale(value)}`);
        passes = Number(value);
        break;
      case 's': {
        const parsed = parseSize(value);
        if (parsed === null) return stop(`shred: invalid file size: ${quoteLocale(value)}`);
        size = parsed;
        break;
      }
      case 'u': remove = true; break;
      case 'v': verbose = true; break;
      case 'x': exact = true; break;
      case 'z': zero = true; break;
      case 'R':
        if (io.read(value).kind !== 'ok') return stop(`shred: ${quotef(value)}: No such file or directory`);
        break;
      default: break;
    }
  }
  if (operands.length === 0) return usageFailure('shred', 'shred: missing file operand');
  const total = passes + (zero ? 1 : 0);
  for (const name of operands) {
    if (name === '-') { streams.diagnostic('shred: -: invalid file type'); streams.exitCode = 1; continue; }
    const read = io.read(name);
    if (read.kind !== 'ok') {
      streams.diagnostic(`shred: ${quotef(name)}: failed to open for writing: ${readFailureText(read)}`);
      streams.exitCode = 1;
      continue;
    }
    const current = Buffer.byteLength(read.text, 'utf8');
    let length = size ?? (exact || current === 0 ? current : Math.ceil(current / BLOCK) * BLOCK);
    if (size === null && exact) length = current;
    for (let pass = 1; length > 0 && pass <= total; pass++) {
      const isZero = zero && pass === total;
      if (verbose) streams.diagnostic(`shred: ${quotef(name)}: pass ${pass}/${total} (${isZero ? '000000' : 'random'})...`);
      const bytes = new Uint8Array(length);
      if (!isZero) for (let at = 0; at < length; at++) bytes[at] = Math.floor(Math.random() * 256);
      const kept = size !== null && size < current ? read.text.slice(size) : '';
      if (!io.write?.(name, bytesToFileText(bytes) + kept)) { streams.diagnostic(`shred: ${quotef(name)}: failed to open for writing: Permission denied`); streams.exitCode = 1; break; }
    }
    if (remove) {
      if (verbose) streams.diagnostic(`shred: ${quotef(name)}: removing`);
      const slash = name.lastIndexOf('/');
      const directory = slash < 0 ? '' : name.slice(0, slash + 1);
      const base = name.slice(slash + 1);
      let previous = name;
      for (let width = base.length; width >= 1; width--) {
        const renamed = directory + '0'.repeat(width);
        if (verbose) streams.diagnostic(`shred: ${quotef(previous)}: renamed to ${quotef(renamed)}`);
        previous = renamed;
      }
      io.remove?.(name);
      if (verbose) streams.diagnostic(`shred: ${quotef(name)}: removed`);
    }
  }
  return streams.result();
}
