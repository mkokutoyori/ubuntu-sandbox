import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { argumentFailure, matchArgument } from './BackupControl';
import { Streams, docsResult, quoteLocale, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'from', letter: 'F', takesArgument: true },
  { name: 'from-unit', letter: 'U', takesArgument: true },
  { name: 'to', letter: 'T', takesArgument: true },
  { name: 'to-unit', letter: 'u', takesArgument: true },
  { name: 'round', letter: 'R', takesArgument: true },
  { name: 'padding', letter: 'P', takesArgument: true },
  { name: 'suffix', letter: 'S', takesArgument: true },
  { name: 'grouping', letter: 'G', takesArgument: false },
  { name: 'delimiter', letter: 'd', takesArgument: true },
  { name: 'field', letter: 'f', takesArgument: true },
  { name: 'debug', letter: 'D', takesArgument: false },
  { name: 'header', letter: 'h', takesArgument: false, optionalArgument: true },
  { name: 'format', letter: 'M', takesArgument: true },
  { name: 'invalid', letter: 'I', takesArgument: true },
  { name: 'zero-terminated', letter: 'z', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

type Scale = 'none' | 'auto' | 'si' | 'iec' | 'iec-i';
type Round = 'up' | 'down' | 'from-zero' | 'towards-zero' | 'nearest';
type Invalid = 'abort' | 'fail' | 'warn' | 'ignore';

const FROM_SCALES: readonly (readonly [string, Scale])[] = [['none', 'none'], ['auto', 'auto'], ['si', 'si'], ['iec', 'iec'], ['iec-i', 'iec-i']];
const TO_SCALES: readonly (readonly [string, Scale])[] = [['none', 'none'], ['si', 'si'], ['iec', 'iec'], ['iec-i', 'iec-i']];
const ROUNDS: readonly (readonly [string, Round])[] = [['up', 'up'], ['down', 'down'], ['from-zero', 'from-zero'], ['towards-zero', 'towards-zero'], ['nearest', 'nearest']];
const INVALIDS: readonly (readonly [string, Invalid])[] = [['abort', 'abort'], ['fail', 'fail'], ['warn', 'warn'], ['ignore', 'ignore']];

const SUFFIXES = 'KMGTPEZYRQ';
const MAX_UNSCALED_DIGITS = 18;
const MAX_ACCEPTABLE_DIGITS = 33;

class Exit extends Error {
  constructor(readonly line: string | null, readonly withTry = false) {
    super(line ?? '');
  }
}

const baseOf = (scale: Scale): number => (scale === 'iec' || scale === 'iec-i' ? 1024 : 1000);

function rounded(value: number, mode: Round): number {
  switch (mode) {
    case 'up': return Math.ceil(value);
    case 'down': return Math.floor(value);
    case 'from-zero': return value < 0 ? Math.floor(value) : Math.ceil(value);
    case 'towards-zero': return Math.trunc(value);
    default: return Math.trunc(value < 0 ? value - 0.5 : value + 0.5);
  }
}

interface Human { value: number; precision: number; rest: string; error: string | null }

function parseHuman(text: string, allowed: Scale): Human {
  const fail = (error: string): Human => ({ value: 0, precision: 0, rest: '', error });
  let at = 0;
  const negative = text[0] === '-';
  if (negative) at++;
  const intStart = at;
  let digits = 0;
  let integer = 0;
  let loss = false;
  while (at < text.length && /\d/.test(text[at])) {
    const digit = Number(text[at]);
    if (integer !== 0 || digit !== 0) digits++;
    if (digits > MAX_UNSCALED_DIGITS) loss = true;
    if (digits > MAX_ACCEPTABLE_DIGITS) return fail('overflow');
    integer = integer * 10 + digit;
    at++;
  }
  if (at === intStart && text[at] !== '.') return fail('invalid-number');
  let value = negative ? -integer : integer;
  let precision = 0;
  if (text[at] === '.') {
    at++;
    const fractionStart = at;
    let fraction = 0;
    let fractionDigits = 0;
    while (at < text.length && /\d/.test(text[at])) {
      fraction = fraction * 10 + Number(text[at]);
      fractionDigits++;
      if (fractionDigits > MAX_ACCEPTABLE_DIGITS) return fail('overflow');
      at++;
    }
    if (at === fractionStart && text[at] === '-') return fail('invalid-number');
    const scaled = fraction / 10 ** fractionDigits;
    value = negative ? value - scaled : value + scaled;
    precision = fractionDigits;
  }
  void loss;
  let power = 0;
  let base = baseOf(allowed);
  if (at < text.length) {
    while (text[at] === ' ' || text[at] === '\t') at++;
    const suffix = text[at];
    if (suffix === undefined || !SUFFIXES.includes(suffix)) return { ...fail('invalid-suffix'), rest: text.slice(at) };
    if (allowed === 'none') return fail('forbidden-suffix');
    power = SUFFIXES.indexOf(suffix) + 1;
    at++;
    if (allowed === 'auto' && text[at] === 'i') { base = 1024; at++; }
    precision = 0;
  }
  if (allowed === 'iec-i') {
    if (text[at] === 'i') at++;
    else return fail('missing-i');
  }
  value *= base ** power;
  return { value, precision, rest: text.slice(at), error: null };
}

function formatG(value: number): string {
  const text = value.toExponential(5).replace(/\.?0+e/, 'e');
  const [mantissa, exponent] = text.split('e');
  const sign = exponent.startsWith('-') ? '-' : '+';
  return `${mantissa}e${sign}${exponent.replace(/^[+-]/, '').padStart(2, '0')}`;
}

function unitToNumber(text: string): number {
  let source = text;
  let suffixes = SUFFIXES;
  if (text !== '' && !/\d$/.test(text)) {
    if (text.endsWith('i') && text.length >= 2 && !/\d/.test(text[text.length - 2])) source = text.slice(0, -1);
    else { source = `${text}B`; suffixes = `0${SUFFIXES}`; }
  }
  const match = /^(\d*)([A-Za-z]*)$/.exec(source);
  let number = Number.NaN;
  if (match !== null) {
    const suffix = match[2];
    let multiplier = 1;
    if (suffix !== '') {
      const decimal = suffix.endsWith('B');
      const letter = decimal ? suffix.slice(0, -1) : suffix;
      if (letter.length === 1 && suffixes.includes(letter) && letter !== '0') multiplier = (decimal ? 1000 : 1024) ** (SUFFIXES.indexOf(letter) + 1);
      else if (suffix === 'B' && suffixes.startsWith('0')) multiplier = 1;
      else multiplier = Number.NaN;
    }
    number = (match[1] === '' && match[2] === '' ? Number.NaN : match[1] === '' ? 1 : Number(match[1])) * multiplier;
  }
  if (!Number.isFinite(number) || number === 0) throw new Exit(`numfmt: invalid unit size: ${quoteLocale(text)}`);
  return number;
}

interface Format { prefix: string; suffix: string; padding: number; zeroPadding: number; alignLeft: boolean; grouping: boolean; precision: number }

function parseFormat(format: string, base: Format): Format {
  const result = { ...base };
  let i = 0;
  let prefixLength = 0;
  while (!(format[i] === '%' && format[i + 1] !== '%')) {
    if (format[i] === undefined) throw new Exit(`numfmt: format ${quoteLocale(format)} has no % directive`);
    if (format[i] === '%') i++;
    i++;
    prefixLength++;
  }
  i++;
  let zero = false;
  for (;;) {
    let skipped = 0;
    while (format[i] === ' ') { i++; skipped++; }
    if (format[i] === '\'') { result.grouping = true; i++; } else if (format[i] === '0') { zero = true; i++; } else if (skipped === 0) break;
  }
  const widthMatch = /^[+-]?\d+/.exec(format.slice(i));
  if (widthMatch !== null) {
    const pad = Number(widthMatch[0]);
    i += widthMatch[0].length;
    if (pad !== 0) {
      if (pad < 0) { result.alignLeft = true; result.padding = -pad; } else if (zero) result.zeroPadding = pad; else result.padding = pad;
    }
  }
  if (format[i] === undefined) throw new Exit(`numfmt: format ${quoteLocale(format)} ends in %`);
  if (format[i] === '.') {
    i++;
    const precisionMatch = /^\d+/.exec(format.slice(i));
    if (precisionMatch === null || format[i] === ' ' || format[i] === '+') throw new Exit(`numfmt: invalid precision in format ${quoteLocale(format)}`);
    result.precision = Number(precisionMatch[0]);
    i += precisionMatch[0].length;
  }
  if (format[i] !== 'f') throw new Exit(`numfmt: invalid format ${quoteLocale(format)}, directive must be %[0]['][-][N][.][N]f`);
  i++;
  const suffixAt = i;
  for (; i < format.length; i += (format[i] === '%' ? 1 : 0) + 1) {
    if (format[i] === '%' && format[i + 1] !== '%') throw new Exit(`numfmt: format ${quoteLocale(format)} has too many % directives`);
  }
  result.prefix = format.slice(0, prefixLength);
  result.suffix = format.slice(suffixAt);
  return result;
}

export function runNumfmt(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  let scaleFrom: Scale = 'none';
  let scaleTo: Scale = 'none';
  let fromUnit = 1;
  let toUnit = 1;
  let roundStyle: Round = 'from-zero';
  let invalid: Invalid = 'abort';
  let delimiter: string | null = null;
  let fields: [number, number][] | null = null;
  let suffix: string | null = null;
  let debug = false;
  let header = 0;
  let formatText: string | null = null;
  let lineDelimiter = '\n';
  let format: Format = { prefix: '', suffix: '', padding: 0, zeroPadding: 0, alignLeft: false, grouping: false, precision: -1 };
  const operands: string[] = [];
  const streams = new Streams();
  let flushedOutput = '';
  const say = (line: string): void => {
    streams.stdout(flushedOutput);
    flushedOutput = '';
    streams.diagnostic(line);
  };
  try {
    for (const item of shortOptions(args, 'd:z', LONG_OPTIONS)) {
      if (item.kind === 'operand') { operands.push(item.value); continue; }
      if (item.kind !== 'option') return usageFailure('numfmt', getoptDiagnostic('numfmt', item));
      const value = item.argument ?? '';
      const pick = <T extends string>(table: readonly (readonly [string, T])[], option: string): T => {
        const matched = matchArgument(value, table) as T | 'invalid' | 'ambiguous';
        if (matched === 'invalid' || matched === 'ambiguous') throw new Exit(argumentFailure('numfmt', matched as 'invalid' | 'ambiguous', value, option, table.map(([name]) => name)), true);
        return matched as T;
      };
      switch (item.letter) {
        case 'H': return docsResult('numfmt', 'help');
        case 'V': return docsResult('numfmt', 'version');
        case 'F': scaleFrom = pick(FROM_SCALES, '--from'); break;
        case 'U': fromUnit = unitToNumber(value); break;
        case 'T': scaleTo = pick(TO_SCALES, '--to'); break;
        case 'u': toUnit = unitToNumber(value); break;
        case 'R': roundStyle = pick(ROUNDS, '--round'); break;
        case 'G': format.grouping = true; break;
        case 'P': {
          const width = /^[+-]?\d+$/.test(value) ? Number(value) : 0;
          if (width === 0) throw new Exit(`numfmt: invalid padding value ${quoteLocale(value)}`);
          format.alignLeft = width < 0;
          format.padding = Math.abs(width);
          break;
        }
        case 'f': {
          if (fields !== null) throw new Exit('numfmt: multiple field specifications');
          const ranges: [number, number][] = [];
          for (const part of value.split(/[,\s]/)) {
            const match = /^(\d*)(-?)(\d*)$/.exec(part);
            if (part === '' || match === null || (match[1] === '' && match[3] === '' && match[2] === '') || part === '-') throw new Exit(part === '' ? 'numfmt: missing list of fields' : `numfmt: invalid field value ${quoteLocale(part)}`, true);
            const low = match[1] === '' ? 1 : Number(match[1]);
            const high = match[2] === '' ? low : match[3] === '' ? Infinity : Number(match[3]);
            if (low === 0) throw new Exit('numfmt: fields are numbered from 1', true);
            if (high < low) throw new Exit('numfmt: invalid decreasing range', true);
            ranges.push([low, high]);
          }
          fields = ranges;
          break;
        }
        case 'd':
          if (value.length > 1) throw new Exit('numfmt: the delimiter must be a single character');
          delimiter = value;
          break;
        case 'z': lineDelimiter = '\0'; break;
        case 'S': suffix = value; break;
        case 'D': debug = true; break;
        case 'h':
          if (item.argument !== undefined) {
            if (!/^\d+$/.test(value) || Number(value) === 0) throw new Exit(`numfmt: invalid header value ${quoteLocale(value)}`);
            header = Number(value);
          } else header = 1;
          break;
        case 'M': formatText = value; break;
        case 'I': invalid = pick(INVALIDS, '--invalid'); break;
        default: break;
      }
    }
    if (formatText !== null && format.grouping) throw new Exit('numfmt: --grouping cannot be combined with --format');
    if (formatText !== null) format = parseFormat(formatText, format);
    if (format.grouping && scaleTo !== 'none') throw new Exit('numfmt: grouping cannot be combined with --to');
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    if (error.withTry) return usageFailure('numfmt', error.line);
    streams.diagnostic(error.line ?? '');
    streams.exitCode = 1;
    return streams.result();
  }
  void debug;
  const conversionExit = invalid === 'abort' ? 2 : 0;
  const reportable = invalid !== 'ignore';
  const autoPadding = format.padding === 0 && delimiter === null;
  let padding = format.padding;
  let validAll = true;

  const toHuman = (value: number, precision: number): string => {
    let digits = precision;
    const group = format.grouping;
    void group;
    let text: string;
    if (scaleTo === 'none') {
      const factor = 10 ** digits;
      const shifted = rounded(value * factor, roundStyle) / factor;
      text = shifted.toFixed(digits);
    } else {
      const base = baseOf(scaleTo);
      let power = 0;
      let scaled = value;
      while (Math.abs(scaled) >= base) { power++; scaled /= base; }
      let adjust = 0;
      if (format.precision !== -1) adjust = Math.min(power * 3, format.precision);
      else if (Math.abs(scaled) < 10) adjust = 1;
      scaled = rounded(scaled * 10 ** adjust, roundStyle) / 10 ** adjust;
      if (Math.abs(scaled) >= base) { scaled /= base; power++; }
      const showDecimal = scaled !== 0 && Math.abs(scaled) < 10 && power > 0;
      digits = format.precision === -1 ? (showDecimal ? 1 : 0) : format.precision;
      text = `${scaled.toFixed(digits)}${power === 0 ? '' : SUFFIXES[power - 1]}`;
      if (scaleTo === 'iec-i' && power > 0) text += 'i';
    }
    if (format.zeroPadding > 0) {
      const negative = text.startsWith('-');
      const body = negative ? text.slice(1) : text;
      text = (negative ? '-' : '') + body.padStart(format.zeroPadding - (negative ? 1 : 0), '0');
    }
    return text;
  };

  const processNumber = (raw: string, field: number): string | null => {
    let text = raw;
    if (suffix !== null && text.length > suffix.length && text.endsWith(suffix)) text = text.slice(0, text.length - suffix.length);
    let start = 0;
    while (text[start] === ' ' || text[start] === '\t') start++;
    if (autoPadding) padding = start > 0 || field > 1 ? text.length : 0;
    const human = parseHuman(text.slice(start), scaleFrom);
    let problem: string | null = null;
    if (human.error === 'overflow') problem = `numfmt: value too large to be converted: ${quoteLocale(text.slice(start))}`;
    else if (human.error === 'invalid-number') problem = `numfmt: invalid number: ${quoteLocale(text.slice(start))}`;
    else if (human.error === 'forbidden-suffix') problem = `numfmt: rejecting suffix in input: ${quoteLocale(text.slice(start))} (consider using --from)`;
    else if (human.error === 'invalid-suffix') problem = `numfmt: invalid suffix in input: ${quoteLocale(text.slice(start))}`;
    else if (human.error === 'missing-i') problem = `numfmt: missing 'i' suffix in input: ${quoteLocale(text.slice(start))} (e.g Ki/Mi/Gi)`;
    else if (human.rest !== '') problem = `numfmt: invalid suffix in input ${quoteLocale(text.slice(start))}: ${quoteLocale(human.rest)}`;
    if (problem !== null) {
      if (reportable) {
        say(problem);
        if (conversionExit !== 0) throw new Exit(null);
      }
      return null;
    }
    let value = human.value;
    if (fromUnit !== 1 || toUnit !== 1) value = (value * fromUnit) / toUnit;
    const precisionUsed = format.precision === -1 ? human.precision : format.precision;
    const exponent = value === 0 ? 0 : Math.max(0, Math.floor(Math.log10(Math.abs(value))));
    if (scaleTo === 'none' && exponent + precisionUsed > MAX_UNSCALED_DIGITS) {
      if (reportable) {
        say(precisionUsed > 0
          ? `numfmt: value/precision too large to be printed: '${formatG(value)}/${precisionUsed}' (consider using --to)`
          : `numfmt: value too large to be printed: '${formatG(value)}' (consider using --to)`);
        if (conversionExit !== 0) throw new Exit(null);
      }
      return null;
    }
    if (exponent > MAX_ACCEPTABLE_DIGITS - 1) {
      if (reportable) {
        say(`numfmt: value too large to be printed: '${formatG(value)}' (cannot handle values > 999Q)`);
        if (conversionExit !== 0) throw new Exit(null);
      }
      return null;
    }
    const plainInteger = scaleTo === 'none' && scaleFrom === 'none' && fromUnit === 1 && toUnit === 1 && /^-?\d+$/.test(text.slice(start)) && format.precision === -1 && format.zeroPadding === 0;
    let shown = plainInteger ? text.slice(start).replace(/^(-?)0+(?=\d)/, '$1') : toHuman(value, precisionUsed);
    if (suffix !== null) shown += suffix;
    if (padding > 0 && shown.length < padding) shown = format.alignLeft ? shown.padEnd(padding) : shown.padStart(padding);
    return `${format.prefix}${shown}${format.suffix}`;
  };

  const included = (field: number): boolean => (fields === null ? field === 1 : fields.some(([low, high]) => field >= low && field <= high));
  const isSeparator = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n';

  const processLine = (line: string, newline: boolean): boolean => {
    let valid = true;
    let at = 0;
    let field = 0;
    let out = '';
    for (;;) {
      field++;
      const start = at;
      if (delimiter !== null) {
        if (line[at] !== delimiter) while (at < line.length && line[at] !== delimiter) at++;
      } else {
        while (at < line.length && isSeparator(line[at])) at++;
        while (at < line.length && !isSeparator(line[at])) at++;
      }
      const text = line.slice(start, at);
      const emit = (): void => {
        if (!included(field)) { out += text; return; }
        const converted = processNumber(text, field);
        if (converted === null) { valid = false; out += text; } else out += converted;
      };
      if (at < line.length) {
        emit();
        out += delimiter === null ? ' ' : delimiter;
        at++;
      } else {
        emit();
        break;
      }
    }
    flushedOutput += out + (newline ? lineDelimiter : '');
    return valid;
  };

  try {
    if (operands.length > 0) {
      for (const operand of operands) validAll = processLine(operand, true) && validAll;
    } else {
      const input = io.stdin ?? '';
      const records = input === '' ? [] : input.split(lineDelimiter);
      const endsWithDelimiter = input.endsWith(lineDelimiter);
      if (endsWithDelimiter) records.pop();
      let remainingHeader = header;
      records.forEach((record, index) => {
        const newline = index < records.length - 1 || endsWithDelimiter;
        if (remainingHeader > 0) { remainingHeader--; flushedOutput += record + (newline ? lineDelimiter : ''); return; }
        validAll = processLine(record, newline) && validAll;
      });
    }
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    streams.stdout(flushedOutput);
    streams.exitCode = 2;
    return streams.result();
  }
  streams.stdout(flushedOutput);
  if (!validAll && invalid !== 'warn' && invalid !== 'ignore') streams.exitCode = 2;
  return streams.result();
}
