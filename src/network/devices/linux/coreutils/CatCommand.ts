import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { Streams, docsResult, fromBytes, quotef, readFailureText, toBytes, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'show-all', letter: 'A', takesArgument: false },
  { name: 'number-nonblank', letter: 'b', takesArgument: false },
  { name: 'show-ends', letter: 'E', takesArgument: false },
  { name: 'number', letter: 'n', takesArgument: false },
  { name: 'squeeze-blank', letter: 's', takesArgument: false },
  { name: 'show-tabs', letter: 'T', takesArgument: false },
  { name: 'show-nonprinting', letter: 'v', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

export interface CatFlags {
  numberAll: boolean;
  numberNonBlank: boolean;
  showEnds: boolean;
  showTabs: boolean;
  showNonPrinting: boolean;
  squeezeBlank: boolean;
}

function visibleByte(byte: number, flags: CatFlags): string {
  if (byte === 10) return '\n';
  if (byte === 9) return flags.showTabs ? '^I' : '\t';
  if (!flags.showNonPrinting) return String.fromCharCode(byte);
  if (byte >= 128) {
    const low = byte - 128;
    if (low === 127) return 'M-^?';
    if (low < 32) return `M-^${String.fromCharCode(low + 64)}`;
    return `M-${String.fromCharCode(low)}`;
  }
  if (byte < 32) return `^${String.fromCharCode(byte + 64)}`;
  if (byte === 127) return '^?';
  return String.fromCharCode(byte);
}

export function runCat(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  const flags: CatFlags = { numberAll: false, numberNonBlank: false, showEnds: false, showTabs: false, showNonPrinting: false, squeezeBlank: false };
  const operands: string[] = [];
  for (const item of shortOptions(args, 'AbeEnstTuv', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('cat', getoptDiagnostic('cat', item));
    switch (item.letter) {
      case 'H': return docsResult('cat', 'help');
      case 'V': return docsResult('cat', 'version');
      case 'A': flags.showNonPrinting = true; flags.showEnds = true; flags.showTabs = true; break;
      case 'b': flags.numberNonBlank = true; flags.numberAll = true; break;
      case 'e': flags.showNonPrinting = true; flags.showEnds = true; break;
      case 'E': flags.showEnds = true; break;
      case 'n': flags.numberAll = true; break;
      case 's': flags.squeezeBlank = true; break;
      case 't': flags.showNonPrinting = true; flags.showTabs = true; break;
      case 'T': flags.showTabs = true; break;
      case 'v': flags.showNonPrinting = true; break;
      default: break;
    }
  }
  const plain = !flags.numberAll && !flags.showEnds && !flags.showTabs && !flags.showNonPrinting && !flags.squeezeBlank;
  const streams = new Streams();
  const names = operands.length === 0 ? ['-'] : operands;
  let lineNumber = 0;
  let previousBlank = false;
  let stdinUsed = false;
  for (const name of names) {
    const read = name === '-' ? { kind: 'ok' as const, text: stdinUsed ? '' : (io.stdin ?? '') } : io.read(name);
    if (name === '-') stdinUsed = true;
    if (read.kind !== 'ok') {
      streams.diagnostic(`cat: ${quotef(name)}: ${readFailureText(read)}`);
      streams.exitCode = 1;
      continue;
    }
    if (plain) { streams.stdout(read.text); continue; }
    const bytes = toBytes(read.text);
    let line: number[] = [];
    const flush = (terminated: boolean): void => {
      const blank = line.length === 0;
      if (flags.squeezeBlank && blank && previousBlank && terminated) return;
      previousBlank = blank && terminated;
      let out = '';
      if (flags.numberAll && !(flags.numberNonBlank && blank)) out += `${String(++lineNumber).padStart(6)}\t`;
      for (const byte of line) out += visibleByte(byte, flags);
      if (terminated) out += `${flags.showEnds ? '$' : ''}\n`;
      streams.stdout(fromBytes(Buffer.from(out, 'latin1')));
      line = [];
    };
    for (const byte of bytes) {
      if (byte === 10) flush(true);
      else line.push(byte);
    }
    if (line.length > 0) flush(false);
  }
  return streams.result();
}
