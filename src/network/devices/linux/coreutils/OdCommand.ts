import { formatGeneral } from '@/bash/runtime/Printf';
import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import {
  Streams, docsResult, parseSizeWithSuffix, quoteLocale, quotef, readFailureText, toBytes, usageFailure,
  type CoreutilsIO, type CoreutilsRun,
} from './CoreutilsKit';
import { argumentFailure, matchArgument } from './BackupControl';
import { formatLongDouble } from './LongDouble';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'address-radix', letter: 'A', takesArgument: true },
  { name: 'endian', letter: 'E', takesArgument: true },
  { name: 'skip-bytes', letter: 'j', takesArgument: true },
  { name: 'read-bytes', letter: 'N', takesArgument: true },
  { name: 'strings', letter: 'S', takesArgument: false, optionalArgument: true },
  { name: 'format', letter: 't', takesArgument: true },
  { name: 'output-duplicates', letter: 'v', takesArgument: false },
  { name: 'width', letter: 'w', takesArgument: false, optionalArgument: true },
  { name: 'traditional', letter: 'T', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

type Kind = 'a' | 'c' | 'd' | 'o' | 'u' | 'x' | 'f';

interface Spec {
  readonly kind: Kind;
  readonly size: number;
  readonly width: number;
  readonly printable: boolean;
}

const SIZE_LETTERS: Readonly<Record<string, number>> = { C: 1, S: 2, I: 4, L: 8 };
const FLOAT_SIZE_LETTERS: Readonly<Record<string, number>> = { F: 4, D: 8, L: 16 };

const NAMED_CHARACTERS = [
  'nul', 'soh', 'stx', 'etx', 'eot', 'enq', 'ack', 'bel', 'bs', 'ht', 'nl', 'vt', 'ff', 'cr', 'so', 'si',
  'dle', 'dc1', 'dc2', 'dc3', 'dc4', 'nak', 'syn', 'etb', 'can', 'em', 'sub', 'esc', 'fs', 'gs', 'rs', 'us', 'sp',
];

const ESCAPES: Readonly<Record<number, string>> = { 0: '\\0', 7: '\\a', 8: '\\b', 12: '\\f', 10: '\\n', 13: '\\r', 9: '\\t', 11: '\\v' };

const INTEGER_WIDTHS: Readonly<Record<string, Readonly<Record<number, number>>>> = {
  d: { 1: 4, 2: 6, 4: 11, 8: 20 },
  u: { 1: 3, 2: 5, 4: 10, 8: 20 },
  o: { 1: 3, 2: 6, 4: 11, 8: 22 },
  x: { 1: 2, 2: 4, 4: 8, 8: 16 },
};

const FLOAT_WIDTH: Readonly<Record<number, number>> = { 4: 15, 8: 24, 16: 29 };
const FLOAT_DIGITS: Readonly<Record<number, number>> = { 4: 6, 8: 15 };
const SMALLEST_NORMAL: Readonly<Record<number, number>> = { 4: 1.1754943508222875e-38, 8: 2.2250738585072014e-308 };
const MAX_BYTES = 2n ** 63n - 1n;

class Failure extends Error {}

function typeFailure(type: string, detail: string): Failure {
  return new Failure(`od: invalid type string ${quoteLocale(type)};\nthis system doesn't provide a ${detail}`);
}

function parseTypeString(text: string): Spec[] | string {
  const whole = text;
  const specs: Spec[] = [];
  let at = 0;
  while (at < text.length) {
    const letter = text[at];
    if (!'acdfoux'.includes(letter)) {
      return `od: invalid character ${quoteLocale(letter)} in type string ${quoteLocale(whole)}`;
    }
    at++;
    const kind = letter as Kind;
    let size: number | null = null;
    const start = at;
    if (kind === 'a' || kind === 'c') {
      size = 1;
    } else {
      const digits = /^\d+/.exec(text.slice(at));
      if (digits !== null) {
        if (digits[0].length > 9) return `od: invalid type string ${quoteLocale(whole)}`;
        size = Number(digits[0]);
        at += digits[0].length;
      } else if (at < text.length) {
        const table = kind === 'f' ? FLOAT_SIZE_LETTERS : SIZE_LETTERS;
        if (table[text[at]] !== undefined) { size = table[text[at]]; at++; }
      }
      size ??= kind === 'f' ? 8 : 4;
    }
    let printable = false;
    if (text[at] === 'z') { printable = true; at++; }
    const spelled = text.slice(start - 1, at);
    if (kind === 'f') {
      if (FLOAT_WIDTH[size] === undefined) return `od: invalid type string ${quoteLocale(spelled.replace(/z$/, ''))};\nthis system doesn't provide a ${size}-byte floating point type`;
    } else if (kind !== 'a' && kind !== 'c' && INTEGER_WIDTHS[kind][size] === undefined) {
      return `od: invalid type string ${quoteLocale(spelled.replace(/z$/, ''))};\nthis system doesn't provide a ${size}-byte integral type`;
    }
    const width = kind === 'a' || kind === 'c' ? 3 : kind === 'f' ? FLOAT_WIDTH[size] : INTEGER_WIDTHS[kind][size];
    specs.push({ kind, size, width, printable });
  }
  return specs;
}

function parseCount(text: string): bigint | 'invalid' | 'suffix' | 'large' {
  const hex = /^0[xX]([0-9a-fA-F]+)(.*)$/.exec(text);
  let base: bigint;
  let suffix: string;
  if (hex !== null) {
    base = BigInt(`0x${hex[1]}`);
    suffix = hex[2];
  } else {
    const decimal = /^(\d+)(.*)$/.exec(text);
    if (decimal === null) return 'invalid';
    base = BigInt(decimal[1]);
    suffix = decimal[2];
  }
  let factor = 1n;
  if (suffix !== '') {
    const multiplier = parseSizeWithSuffix(`1${suffix}`);
    if (multiplier === null) return 'suffix';
    factor = BigInt(multiplier);
  }
  const value = base * factor;
  return value > MAX_BYTES ? 'large' : value;
}

function shortestFloat(value: number, size: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value < 0 ? '-inf' : 'inf';
  if (value === 0) return '0';
  const limit = size === 4 ? 9 : 17;
  const start = Math.abs(value) < SMALLEST_NORMAL[size] ? 1 : FLOAT_DIGITS[size];
  for (let precision = start; precision <= limit; precision++) {
    const text = formatGeneral(value, precision, false);
    const back = Number(text);
    if (size === 4 ? Math.fround(back) === value : back === value) return text;
  }
  return formatGeneral(value, limit, false);
}

function readUnsigned(bytes: Uint8Array, offset: number, size: number, big: boolean): bigint {
  let value = 0n;
  for (let index = 0; index < size; index++) {
    const byte = bytes[big ? offset + index : offset + size - 1 - index] ?? 0;
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

function formatField(spec: Spec, bytes: Uint8Array, offset: number, big: boolean): string {
  if (spec.kind === 'a' || spec.kind === 'c') {
    const byte = bytes[offset] ?? 0;
    if (spec.kind === 'a') {
      const low = byte & 0x7f;
      if (low < NAMED_CHARACTERS.length) return NAMED_CHARACTERS[low];
      return low === 127 ? 'del' : String.fromCharCode(low);
    }
    if (ESCAPES[byte] !== undefined) return ESCAPES[byte];
    if (byte >= 0x20 && byte < 0x7f) return String.fromCharCode(byte);
    return byte.toString(8).padStart(3, '0');
  }
  const raw = readUnsigned(bytes, offset, spec.size, big);
  const bits = BigInt(spec.size * 8);
  switch (spec.kind) {
    case 'u': return raw.toString(10);
    case 'x': return raw.toString(16).padStart(spec.size * 2, '0');
    case 'o': return raw.toString(8).padStart(Math.ceil(spec.size * 8 / 3), '0');
    case 'd': return (raw >= 1n << (bits - 1n) ? raw - (1n << bits) : raw).toString(10);
    default: {
      if (spec.size === 16) {
        const unit: number[] = [];
        for (let index = 0; index < 16; index++) unit.push(bytes[big ? offset + 15 - index : offset + index] ?? 0);
        return formatLongDouble(unit);
      }
      const view = new DataView(new ArrayBuffer(8));
      for (let index = 0; index < spec.size; index++) {
        const byte = bytes[big ? offset + index : offset + spec.size - 1 - index] ?? 0;
        view.setUint8(index, byte);
      }
      const value = spec.size === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
      const text = (value < 0 || Object.is(value, -0) ? '-' : '') + shortestFloat(Math.abs(value), spec.size);
      const sign = Number.isNaN(value) && (view.getUint8(0) & 0x80) !== 0;
      return sign ? '-nan' : text;
    }
  }
}

function parseTraditionalOffset(text: string): bigint | null {
  const match = /^\+?(0[xX][0-9a-fA-F]+|[0-7]+)(b?)$/.exec(text);
  if (match === null) return null;
  const value = /^0[xX]/.test(match[1]) ? BigInt(match[1]) : BigInt(`0o${match[1]}`);
  return value * (match[2] === 'b' ? 512n : 1n);
}

function leastCommonMultiple(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) { [x, y] = [y, x % y]; }
  return (a / x) * b;
}

function addressText(offset: bigint, radix: string): string {
  if (radix === 'n') return '';
  const base = radix === 'o' ? 8 : radix === 'x' ? 16 : 10;
  const digits = radix === 'x' ? 6 : 7;
  return offset.toString(base).padStart(digits, '0');
}

export function runOd(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  let radix = 'o';
  let skip = 0n;
  let limit: bigint | null = null;
  let stringsLength: number | null = null;
  let verbose = false;
  let widthRequest: number | 'default' | null = null;
  let big = false;
  let traditional = false;
  const specs: Spec[] = [];
  const operands: string[] = [];
  const streams = new Streams();
  const fail = (message: string): CoreutilsRun => usageFailure('od', message);
  const plain = (message: string): CoreutilsRun => {
    const single = new Streams();
    single.diagnostic(message);
    single.exitCode = 1;
    return single.result();
  };
  const addType = (text: string): CoreutilsRun | null => {
    const parsed = parseTypeString(text);
    if (typeof parsed === 'string') return plain(parsed);
    specs.push(...parsed);
    return null;
  };
  const traditionalLetters: Readonly<Record<string, string>> = {
    a: 'a', b: 'o1', c: 'c', d: 'u2', f: 'fF', i: 'dI', l: 'dL', o: 'o2', s: 'd2', x: 'x2',
  };
  for (const item of shortOptions(args, 'A:j:N:S:t:vw::abcdfilosx', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('od', getoptDiagnostic('od', item));
    const argument = item.argument ?? '';
    switch (item.letter) {
      case 'H': return docsResult('od', 'help');
      case 'V': return docsResult('od', 'version');
      case 'A': {
        if (!'doxn'.includes(argument[0] ?? '?')) {
          return plain(`od: invalid output address radix ${quoteLocale(argument[0] ?? '')}; it must be one character from [doxn]`);
        }
        radix = argument[0];
        break;
      }
      case 'E': {
        const matched = matchArgument(argument, [['little', false], ['big', true]] as const);
        if (matched === 'invalid' || matched === 'ambiguous') {
          return fail(argumentFailure('od', matched, argument, '--endian', ['little', 'big']));
        }
        big = matched;
        break;
      }
      case 'j': case 'N': {
        const count = parseCount(argument);
        if (count === 'invalid') return plain(`od: invalid -${item.letter} argument ${quoteLocale(argument)}`);
        if (count === 'suffix') return plain(`od: invalid suffix in -${item.letter} argument ${quoteLocale(argument)}`);
        if (count === 'large') return plain(`od: -${item.letter} argument ${quoteLocale(argument)} too large`);
        if (item.letter === 'j') skip = count; else limit = count;
        break;
      }
      case 'S': {
        if (item.argument === undefined) { stringsLength = 3; break; }
        const count = parseCount(argument);
        if (count === 'invalid') return plain(`od: invalid -S argument ${quoteLocale(argument)}`);
        if (count === 'suffix') return plain(`od: invalid suffix in -S argument ${quoteLocale(argument)}`);
        if (count === 'large') return plain(`od: -S argument ${quoteLocale(argument)} too large`);
        stringsLength = Number(count);
        break;
      }
      case 't': {
        const early = addType(argument);
        if (early !== null) return early;
        break;
      }
      case 'v': verbose = true; break;
      case 'w': {
        if (item.argument === undefined) { widthRequest = 'default'; break; }
        if (!/^\d+$/.test(argument)) {
          return plain(/^\d/.test(argument) ? `od: invalid suffix in -w argument ${quoteLocale(argument)}` : `od: invalid -w argument ${quoteLocale(argument)}`);
        }
        if (argument.length > 15) return plain(`od: -w argument ${quoteLocale(argument)} too large`);
        widthRequest = Number(argument);
        break;
      }
      case 'T': traditional = true; break;
      default: {
        const early = addType(traditionalLetters[item.letter]);
        if (early !== null) return early;
      }
    }
  }
  if (specs.length === 0 && stringsLength === null) specs.push(...(parseTypeString('o2') as Spec[]));

  let labelBase: bigint | null = null;
  if (traditional && operands.length > 1) {
    const parsedOffsets = operands.slice(1).map((operand) => parseTraditionalOffset(operand));
    if (operands.length > 3 || parsedOffsets.some((value) => value === null)) {
      streams.diagnostic(`od: extra operand ${quoteLocale(operands[1])}`);
      streams.diagnostic('od: compatibility mode supports at most one file');
      streams.diagnostic("Try 'od --help' for more information.");
      streams.exitCode = 1;
      return streams.result();
    }
    skip = parsedOffsets[0] as bigint;
    if (parsedOffsets.length === 2) labelBase = parsedOffsets[1] as bigint;
    operands.splice(1);
  } else if (traditional && operands.length === 1 && /^\+/.test(operands[0])) {
    const only = parseTraditionalOffset(operands[0]);
    if (only !== null) { skip = only; operands.splice(0); }
  }

  let blockSize = 1;
  for (const spec of specs) blockSize = leastCommonMultiple(blockSize, spec.size);
  let perLine = 16;
  if (widthRequest === 'default') perLine = 32;
  else if (widthRequest !== null) perLine = widthRequest;
  if (stringsLength === null && perLine % blockSize !== 0) {
    if (widthRequest !== null && widthRequest !== 'default') {
      streams.diagnostic(`od: warning: invalid width ${perLine}; using ${blockSize} instead`);
    }
    perLine = widthRequest === null || widthRequest === 'default' ? Math.max(perLine, blockSize) : blockSize;
    if (perLine % blockSize !== 0) perLine = blockSize * Math.ceil(perLine / blockSize);
  }
  if (perLine === 0) perLine = blockSize;

  const chunks: Uint8Array[] = [];
  let stdinUsed = false;
  for (const name of operands.length === 0 ? ['-'] : operands) {
    if (name === '-') {
      chunks.push(stdinUsed ? new Uint8Array() : toBytes(io.stdin ?? ''));
      stdinUsed = true;
      continue;
    }
    const read = io.read(name);
    if (read.kind !== 'ok') {
      streams.diagnostic(`od: ${quotef(name)}: ${readFailureText(read)}`);
      streams.exitCode = 1;
      if (read.kind === 'directory') chunks.push(new Uint8Array());
      continue;
    }
    chunks.push(toBytes(read.text));
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const all = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) { all.set(chunk, cursor); cursor += chunk.length; }
  if (skip > BigInt(total)) {
    if (chunks.length > 0 || operands.length === 0) {
      streams.diagnostic('od: cannot skip past end of combined input');
      streams.exitCode = 1;
    }
    return streams.result();
  }
  const begin = Number(skip);
  const end = limit === null ? total : Math.min(total, begin + Number(limit));
  const data = all.subarray(begin, end);
  const radixText = (offset: number): string => addressText(BigInt(begin + offset), radix);

  if (stringsLength !== null) {
    let run: number[] = [];
    let runStart = 0;
    for (let index = 0; index < data.length; index++) {
      const byte = data[index];
      if (byte >= 0x20 && byte < 0x7f) {
        if (run.length === 0) runStart = index;
        run.push(byte);
      } else {
        if (byte === 0 && run.length >= stringsLength) {
          const prefix = radix === 'n' ? '' : `${radixText(runStart)} `;
          streams.stdout(`${prefix}${String.fromCharCode(...run)}\n`);
        }
        run = [];
      }
    }
    return streams.result();
  }

  const firstColumn = (offset: number): string => {
    if (labelBase === null) return radixText(offset);
    if (radix === 'n') return `(${addressText(BigInt(begin + offset), 'o')})`;
    return `${radixText(offset)} (${addressText(labelBase + BigInt(offset), radix)})`;
  };
  const blanks = radix === 'n' && labelBase === null ? '' : ' '.repeat(firstColumn(0).length);
  const widestRow = Math.max(...specs.map((spec) => (perLine / spec.size) * (spec.width + 1)));
  const fieldWidths = specs.map((spec) => {
    const fields = perLine / spec.size;
    const widths: number[] = [];
    let remaining = widestRow - fields * (spec.width + 1);
    for (let field = 0; field < fields; field++) {
      const extra = Math.round(remaining / (fields - field));
      widths.push(spec.width + extra);
      remaining -= extra;
    }
    return widths;
  });
  const lines: string[] = [];
  let previous: Uint8Array | null = null;
  let squeezed = false;
  for (let offset = 0; offset < data.length; offset += perLine) {
    const block = data.subarray(offset, Math.min(offset + perLine, data.length));
    const full = block.length === perLine;
    if (!verbose && full && previous !== null && previous.length === block.length && previous.every((byte, index) => byte === block[index])) {
      if (!squeezed) { lines.push('*'); squeezed = true; }
      continue;
    }
    squeezed = false;
    previous = full ? block : null;
    specs.forEach((spec, row) => {
      const units = Math.ceil(block.length / spec.size);
      let text = row === 0 ? firstColumn(offset) : blanks;
      for (let unit = 0; unit < units; unit++) {
        const field = formatField(spec, block, unit * spec.size, big);
        text += ` ${field.padStart(fieldWidths[row][unit])}`;
      }
      if (spec.printable) {
        for (let unit = units; unit < perLine / spec.size; unit++) text += ' '.repeat(fieldWidths[row][unit] + 1);
        let glyphs = '';
        for (const byte of block) glyphs += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.';
        text += `  >${glyphs}<`;
      }
      lines.push(text);
    });
  }
  if ((radix !== 'n' || labelBase !== null) && (chunks.length > 0 || operands.length === 0)) lines.push(firstColumn(data.length));
  if (lines.length > 0) streams.stdout(`${lines.join('\n')}\n`);
  return streams.result();
}
