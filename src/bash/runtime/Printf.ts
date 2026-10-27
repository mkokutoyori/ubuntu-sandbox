import { decodeBackslashEscapes } from './EscapeSequences';

export interface PrintfClock {
  nowMs(): number;
  format(pattern: string, epochMs: number): string;
}

export interface PrintfResult {
  readonly output: string;
  readonly status: number;
  readonly errors: readonly string[];
}

interface Specification {
  readonly flags: string;
  readonly width: number | '*' | null;
  readonly precision: number | '*' | null;
  readonly conversion: string;
  readonly timePattern?: string;
}

type Piece = { readonly literal: string } | { readonly specification: Specification } | { readonly stop: true };

const INT64_MAX = (1n << 63n) - 1n;
const INT64_MIN = -(1n << 63n);

class FormatError extends Error {}

function parseFormat(format: string): Piece[] {
  const pieces: Piece[] = [];
  let literal = '';
  const flushLiteral = (): void => {
    if (literal === '') return;
    const decoded = decodeBackslashEscapes(literal, 'printf-format');
    pieces.push({ literal: decoded.text });
    if (decoded.stopped) pieces.push({ stop: true });
    literal = '';
  };
  let index = 0;
  while (index < format.length) {
    const character = format[index];
    if (character !== '%') {
      literal += character;
      index++;
      continue;
    }
    if (format[index + 1] === '%') {
      literal += '%';
      index += 2;
      continue;
    }
    flushLiteral();
    index++;
    let flags = '';
    while (index < format.length && "-+ #0'".includes(format[index])) flags += format[index++];
    let width: number | '*' | null = null;
    if (format[index] === '*') { width = '*'; index++; }
    else {
      const digits = /^\d+/.exec(format.slice(index));
      if (digits !== null) { width = Number(digits[0]); index += digits[0].length; }
    }
    let precision: number | '*' | null = null;
    if (format[index] === '.') {
      index++;
      if (format[index] === '*') { precision = '*'; index++; }
      else {
        const digits = /^\d+/.exec(format.slice(index));
        precision = digits === null ? 0 : Number(digits[0]);
        if (digits !== null) index += digits[0].length;
      }
    }
    while (index < format.length && 'hlLjzt'.includes(format[index])) index++;
    if (format[index] === '(') {
      const close = format.indexOf(')T', index);
      if (close < 0) throw new FormatError("`(': missing format character");
      pieces.push({ specification: { flags, width, precision, conversion: 'T', timePattern: format.slice(index + 1, close) } });
      index = close + 2;
      continue;
    }
    const conversion = format[index];
    if (conversion === undefined) throw new FormatError('missing format character');
    if (!'diouxXcsbqfFeEgGaA'.includes(conversion)) throw new FormatError(`\`${conversion}': invalid format character`);
    pieces.push({ specification: { flags, width, precision, conversion } });
    index++;
  }
  flushLiteral();
  return pieces;
}

function parseInteger(argument: string, errors: string[]): bigint {
  if (argument === '') return 0n;
  if (argument[0] === "'" || argument[0] === '"') {
    const character = Array.from(argument.slice(1))[0];
    return character === undefined ? 0n : BigInt(character.codePointAt(0) as number);
  }
  const match = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(argument);
  if (match === null) {
    errors.push(`${argument}: invalid number`);
    return 0n;
  }
  const digits = match[2];
  let value = /^0[xX]/.test(digits) ? BigInt(digits) : digits.length > 1 && digits[0] === '0' ? BigInt(`0o${digits.slice(1)}`) : BigInt(digits);
  if (match[1] === '-') value = -value;
  if (match[0].length !== argument.length && argument.slice(match[0].length).trim() !== '') errors.push(`${argument}: invalid number`);
  if (value > INT64_MAX) value = INT64_MAX;
  if (value < INT64_MIN) value = INT64_MIN;
  return value;
}

function parseFloatArgument(argument: string, errors: string[]): number {
  if (argument === '') return 0;
  if (argument[0] === "'" || argument[0] === '"') {
    const character = Array.from(argument.slice(1))[0];
    return character === undefined ? 0 : (character.codePointAt(0) as number);
  }
  const special = /^\s*([+-]?)(inf(?:inity)?|nan)$/i.exec(argument);
  if (special !== null) return special[2].toLowerCase().startsWith('inf') ? (special[1] === '-' ? -Infinity : Infinity) : NaN;
  if (/^\s*[+-]?0[xX]/.test(argument)) return Number(parseInteger(argument, errors));
  const match = /^\s*[+-]?(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(argument);
  if (match === null) {
    errors.push(`${argument}: invalid number`);
    return 0;
  }
  if (match[0].length !== argument.length && argument.slice(match[0].length).trim() !== '') errors.push(`${argument}: invalid number`);
  return Number(match[0]);
}

function roundHalfEven(digits: string, keep: number): { text: string; carry: boolean } {
  const head = digits.slice(0, keep);
  const rest = digits.slice(keep);
  if (rest === '' || rest[0] < '5') return { text: head, carry: false };
  const tailIsZero = /^0*$/.test(rest.slice(1));
  const exactTie = rest[0] === '5' && tailIsZero;
  const lastDigit = keep > 0 ? Number(head[keep - 1]) : 0;
  const roundUp = rest[0] > '5' || (rest[0] === '5' && !tailIsZero) || (exactTie && lastDigit % 2 === 1);
  if (!roundUp) return { text: head, carry: false };
  const incremented = (BigInt(head === '' ? '0' : head) + 1n).toString().padStart(head.length, '0');
  return incremented.length > head.length ? { text: incremented.slice(1), carry: true } : { text: incremented, carry: false };
}

function fixed(value: number, precision: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1e21) return BigInt(Math.round(magnitude)).toString() + (precision > 0 ? `.${'0'.repeat(precision)}` : '');
  const exact = magnitude.toFixed(Math.min(100, precision + 40));
  const [integerPart, fractionPart = ''] = exact.split('.');
  const rounded = roundHalfEven(integerPart + fractionPart, integerPart.length + precision);
  let digits = rounded.text;
  if (rounded.carry) digits = `1${digits}`;
  const integerLength = integerPart.length + (rounded.carry ? 1 : 0);
  const integer = digits.slice(0, integerLength) || '0';
  const fraction = digits.slice(integerLength);
  return precision > 0 ? `${integer}.${fraction}` : integer;
}

function exponential(value: number, precision: number): string {
  if (value === 0) return `${precision > 0 ? `0.${'0'.repeat(precision)}` : '0'}e+00`;
  const exact = Math.abs(value).toExponential(Math.min(100, precision + 25));
  const [mantissa, exponentText] = exact.split('e');
  let exponent = Number(exponentText);
  const digits = mantissa.replace('.', '');
  const rounded = roundHalfEven(digits, precision + 1);
  let significant = rounded.text;
  if (rounded.carry) {
    significant = `1${significant}`.slice(0, precision + 1);
    exponent++;
  }
  significant = significant.padEnd(precision + 1, '0');
  const body = precision > 0 ? `${significant[0]}.${significant.slice(1)}` : significant[0];
  const sign = exponent < 0 ? '-' : '+';
  return `${body}e${sign}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

function general(value: number, precision: number, alternate: boolean): string {
  const effective = precision === 0 ? 1 : precision;
  if (value === 0) return alternate ? `0.${'0'.repeat(effective - 1)}` : '0';
  const probe = exponential(value, effective - 1);
  const exponent = Number(probe.split('e')[1]);
  let text: string;
  if (exponent < -4 || exponent >= effective) {
    text = probe;
    if (!alternate) text = text.replace(/\.?0+e/, 'e');
  } else {
    text = fixed(value, effective - 1 - exponent);
    if (!alternate && text.includes('.')) text = text.replace(/\.?0+$/, '');
  }
  return text;
}

function hexFloat(value: number, upper: boolean): string {
  if (value === 0) return upper ? '0X0P+0' : '0x0p+0';
  let exponent = Math.floor(Math.log2(Math.abs(value)));
  let mantissa = Math.abs(value) / 2 ** exponent;
  while (mantissa >= 2) { mantissa /= 2; exponent++; }
  while (mantissa < 1) { mantissa *= 2; exponent--; }
  const fraction = Math.round((mantissa - 1) * 2 ** 52).toString(16).padStart(13, '0').replace(/0+$/, '');
  const text = `0x1${fraction === '' ? '' : `.${fraction}`}p${exponent >= 0 ? '+' : ''}${exponent}`;
  return upper ? text.toUpperCase() : text;
}

function quote(value: string): string {
  if (value === '') return "''";
  const bytes = Array.from(new TextEncoder().encode(value));
  if (bytes.some((byte) => byte < 0x20 || byte >= 0x7f)) {
    let out = "$'";
    for (const byte of bytes) {
      const named: Record<number, string> = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r', 27: '\\E', 39: "\\'", 92: '\\\\' };
      if (named[byte] !== undefined) out += named[byte];
      else if (byte < 0x20 || byte >= 0x7f) out += `\\${byte.toString(8).padStart(3, '0')}`;
      else out += String.fromCharCode(byte);
    }
    return `${out}'`;
  }
  let out = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    const special = ' \\\'"$`*?[]{}|&;()<>!^,'.includes(character) || (index === 0 && (character === '#' || character === '~'));
    out += special ? `\\${character}` : character;
  }
  return out;
}

function pad(text: string, specification: Specification, width: number, numeric: boolean): string {
  if (text.length >= width) return text;
  if (specification.flags.includes('-')) return text.padEnd(width, ' ');
  if (numeric && specification.flags.includes('0')) {
    const sign = /^[+\- ]/.test(text) ? text[0] : '';
    const prefix = /^[+\- ]?0[xX]/.test(text) ? text.slice(sign.length, sign.length + 2) : '';
    const rest = text.slice(sign.length + prefix.length);
    return sign + prefix + rest.padStart(width - sign.length - prefix.length, '0');
  }
  return text.padStart(width, ' ');
}

function signed(text: string, negative: boolean, flags: string): string {
  if (negative) return `-${text}`;
  if (flags.includes('+')) return `+${text}`;
  if (flags.includes(' ')) return ` ${text}`;
  return text;
}

export function formatPrintf(format: string, args: readonly string[], clock?: PrintfClock): PrintfResult {
  const errors: string[] = [];
  let pieces: Piece[];
  try {
    pieces = parseFormat(format);
  } catch (e) {
    if (e instanceof FormatError) return { output: '', status: 1, errors: [e.message] };
    throw e;
  }
  const conversions = pieces.filter((piece) => 'specification' in piece).length;
  let output = '';
  let cursor = 0;
  let stopped = false;
  const next = (): string | undefined => (cursor < args.length ? args[cursor++] : undefined);
  do {
    const startCursor = cursor;
    for (const piece of pieces) {
      if ('stop' in piece) { stopped = true; break; }
      if ('literal' in piece) { output += piece.literal; continue; }
      const specification = piece.specification;
      let width = specification.width === '*' ? Number(parseInteger(next() ?? '0', errors)) : specification.width ?? 0;
      let flags = specification.flags;
      if (width < 0) { flags += '-'; width = -width; }
      const precision = specification.precision === '*' ? Number(parseInteger(next() ?? '0', errors)) : specification.precision;
      const explicit: Specification = { ...specification, flags };
      const argument = next();
      const conversion = specification.conversion;
      let text: string;
      let numeric = false;
      switch (conversion) {
        case 'd':
        case 'i': {
          const value = parseInteger(argument ?? '0', errors);
          let digits = (value < 0n ? -value : value).toString();
          if (precision !== null) digits = precision === 0 && value === 0n ? '' : digits.padStart(precision, '0');
          text = signed(digits, value < 0n, flags);
          numeric = precision === null;
          break;
        }
        case 'u':
        case 'o':
        case 'x':
        case 'X': {
          const value = BigInt.asUintN(64, parseInteger(argument ?? '0', errors));
          let digits = value.toString(conversion === 'u' ? 10 : conversion === 'o' ? 8 : 16);
          if (conversion === 'X') digits = digits.toUpperCase();
          if (precision !== null) digits = precision === 0 && value === 0n ? '' : digits.padStart(precision, '0');
          if (flags.includes('#')) {
            if (conversion === 'o' && !digits.startsWith('0')) digits = `0${digits}`;
            else if ((conversion === 'x' || conversion === 'X') && value !== 0n) digits = `0${conversion}${digits}`;
          }
          text = digits;
          numeric = precision === null;
          break;
        }
        case 'c':
          text = argument === undefined || argument === '' ? '' : Array.from(argument)[0];
          break;
        case 's': {
          const value = argument ?? '';
          text = precision === null ? value : Array.from(value).slice(0, precision).join('');
          break;
        }
        case 'b': {
          const decoded = decodeBackslashEscapes(argument ?? '', 'printf-b');
          text = precision === null ? decoded.text : decoded.text.slice(0, precision);
          output += pad(text, explicit, width, false);
          if (decoded.stopped) { stopped = true; }
          text = '';
          break;
        }
        case 'q':
          text = quote(argument ?? '');
          break;
        case 'T': {
          const stamp = argument === undefined || argument === '' ? -1n : parseInteger(argument, errors);
          const epochMs = stamp < 0n ? (clock?.nowMs() ?? Date.now()) : Number(stamp) * 1000;
          text = clock !== undefined ? clock.format(specification.timePattern ?? '', epochMs) : new Date(epochMs).toISOString();
          break;
        }
        default: {
          const value = parseFloatArgument(argument ?? '0', errors);
          const upper = conversion === conversion.toUpperCase();
          const places = precision ?? 6;
          let body: string;
          if (!Number.isFinite(value)) body = Number.isNaN(value) ? 'nan' : 'inf';
          else if (conversion === 'f' || conversion === 'F') body = fixed(value, places);
          else if (conversion === 'e' || conversion === 'E') body = exponential(value, places);
          else if (conversion === 'g' || conversion === 'G') body = general(value, precision ?? 6, flags.includes('#'));
          else body = hexFloat(value, upper);
          if (upper) body = body.toUpperCase();
          text = signed(body, value < 0 || Object.is(value, -0), flags);
          numeric = Number.isFinite(value);
        }
      }
      if (conversion !== 'b') output += pad(text, explicit, width, numeric);
      if (stopped) break;
    }
    if (stopped) break;
    if (conversions === 0 || cursor === startCursor) break;
  } while (cursor < args.length);
  return { output, status: errors.length > 0 ? 1 : 0, errors };
}
