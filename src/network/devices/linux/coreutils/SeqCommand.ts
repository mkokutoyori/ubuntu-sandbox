import { formatPrintf } from '@/bash/runtime/Printf';
import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { Streams, docsResult, quoteLocale, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'format', letter: 'f', takesArgument: true },
  { name: 'separator', letter: 's', takesArgument: true },
  { name: 'equal-width', letter: 'w', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const OUTPUT_LIMIT = 5_000_000;

interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

function parseDecimal(text: string): Decimal | 'infinite' | null {
  if (/^[-+]?(inf|infinity)$/i.test(text)) return 'infinite';
  if (/^[-+]?0[xX][0-9a-fA-F]+$/.test(text)) return { units: BigInt(text.replace(/^\+/, '')), scale: 0 };
  const match = /^([-+]?)(\d*)\.?(\d*)(?:[eE]([-+]?\d+))?$/.exec(text);
  if (match === null || (match[2] === '' && match[3] === '')) return null;
  const exponent = match[4] === undefined ? 0 : Number(match[4]);
  let digits = `${match[2]}${match[3]}`.replace(/^0+(?=\d)/, '');
  let scale = match[3].length - exponent;
  if (scale < 0) { digits += '0'.repeat(-scale); scale = 0; }
  return { units: BigInt(`${match[1] === '-' ? '-' : ''}${digits === '' ? '0' : digits}`), scale };
}

function render(units: bigint, precision: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(precision + 1, '0');
  const body = precision === 0 ? digits : `${digits.slice(0, -precision)}.${digits.slice(-precision)}`;
  return negative ? `-${body}` : body;
}

function formatFailure(line: string): CoreutilsRun {
  const failure = new Streams();
  failure.diagnostic(line);
  failure.exitCode = 1;
  return failure.result();
}

export function runSeq(args: readonly string[]): CoreutilsRun {
  let separator = '\n';
  let format: string | null = null;
  let equalWidth = false;
  const operands: string[] = [];
  const isNumberLike = (token: string): boolean => /^-[\d.]/.test(token);
  const scanned: string[] = [];
  for (const token of args) scanned.push(isNumberLike(token) ? `\u0000${token}` : token);
  for (const item of shortOptions(scanned, 'f:s:w', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value.replace(/^\u0000/, '')); continue; }
    if (item.kind !== 'option') return usageFailure('seq', getoptDiagnostic('seq', item));
    switch (item.letter) {
      case 'H': return docsResult('seq', 'help');
      case 'V': return docsResult('seq', 'version');
      case 'f': format = item.argument ?? ''; break;
      case 's': separator = item.argument ?? ''; break;
      case 'w': equalWidth = true; break;
      default: break;
    }
  }
  if (operands.length === 0) return usageFailure('seq', 'seq: missing operand');
  if (operands.length > 3) return usageFailure('seq', `seq: extra operand ${quoteLocale(operands[3])}`);
  const parsed = operands.map((operand) => ({ operand, value: parseDecimal(operand) }));
  for (const { operand, value } of parsed) {
    if (/^[-+]?nan$/i.test(operand)) return usageFailure('seq', `seq: invalid 'not-a-number' argument: '${operand}'`);
    if (value === null) return usageFailure('seq', `seq: invalid floating point argument: ${quoteLocale(operand)}`);
  }
  if (format !== null && equalWidth) return usageFailure('seq', 'seq: format string may not be specified when printing equal width strings');
  if (format !== null) {
    const directives = [...format.replace(/%%/g, '').matchAll(/%[-+ #0']*\d*(?:\.\d*)?([A-Za-z]?)/g)];
    if (directives.length === 0) return formatFailure(`seq: format ${quoteLocale(format)} has no % directive`);
    if (directives.length > 1) return formatFailure(`seq: format ${quoteLocale(format)} has too many % directives`);
    if (!/[aAeEfFgG]/.test(directives[0][1])) return formatFailure(`seq: format ${quoteLocale(format)} has unknown %${directives[0][1]} directive`);
  }

  const numbers = parsed.map((entry) => entry.value as Decimal | 'infinite');
  const one: Decimal = { units: 1n, scale: 0 };
  const [first, increment, last] = numbers.length === 1 ? [one, one, numbers[0]]
    : numbers.length === 2 ? [numbers[0], one, numbers[1]] : [numbers[0], numbers[1], numbers[2]];
  const streams = new Streams();
  if (first === 'infinite') return streams.result();
  if (increment === 'infinite') return streams.result();
  if (increment.units === 0n) return usageFailure('seq', `seq: invalid Zero increment value: ${quoteLocale(operands[operands.length === 3 ? 1 : 0])}`);
  const precision = Math.max(first.scale, increment.scale);
  const align = (value: Decimal, to: number): bigint => value.units * 10n ** BigInt(to - value.scale);
  const scaleAll = Math.max(precision, last === 'infinite' ? 0 : last.scale);
  const from = align(first, scaleAll);
  const step = align(increment, scaleAll);
  const to = last === 'infinite' ? null : align(last, scaleAll);
  const shift = BigInt(scaleAll - precision);
  const quantise = (units: bigint): bigint => (shift === 0n ? units : units / 10n ** shift);
  const ascending = step > 0n;
  const items: string[] = [];
  let width = 0;
  if (equalWidth) {
    const first_ = render(quantise(from), precision);
    const lastShown = to === null ? first_ : render(quantise(to), precision);
    width = Math.max(first_.length, lastShown.length);
  }
  for (let current = from; to === null || (ascending ? current <= to : current >= to); current += step) {
    if (items.length >= OUTPUT_LIMIT) break;
    const shown = render(quantise(current), precision);
    if (format !== null) items.push(formatPrintf(format, [shown]).output);
    else if (equalWidth && shown.length < width) {
      const negative = shown.startsWith('-');
      const body = negative ? shown.slice(1) : shown;
      items.push(`${negative ? '-' : ''}${body.padStart(width - (negative ? 1 : 0), '0')}`);
    } else items.push(shown);
  }
  if (items.length > 0) streams.stdout(`${items.join(separator)}\n`);
  return streams.result();
}
