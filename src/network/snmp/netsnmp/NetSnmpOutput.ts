import type { SnmpValue, SnmpVarBinding } from '../types';

export type OidOutputFormat = 'module' | 'suffix' | 'full' | 'numeric' | 'full-and-numeric' | 'ucd';
export type StringOutputFormat = 'guess' | 'ascii' | 'hex';

export interface NetSnmpOutputOptions {
  oidFormat: OidOutputFormat;
  stringFormat: StringOutputFormat;
  quickPrint: boolean;
  quickEqualsPrint: boolean;
  bareValue: boolean;
  numericTimeticks: boolean;
  hexText: boolean;
}

export function defaultOutputOptions(): NetSnmpOutputOptions {
  return {
    oidFormat: 'module', stringFormat: 'guess',
    quickPrint: false, quickEqualsPrint: false, bareValue: false,
    numericTimeticks: false, hexText: false,
  };
}

export type OutputToggleOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'precision-from-next-argument' }
  | { readonly kind: 'unknown'; readonly letter: string };

const NO_EFFECT_WITHOUT_MIBS = new Set(['0', 'b', 'e', 'E', 'U', 'X']);

export function applyOutputToggles(letters: string, options: NetSnmpOutputOptions): OutputToggleOutcome {
  for (let i = 0; i < letters.length; i++) {
    const letter = letters[i];
    if (NO_EFFECT_WITHOUT_MIBS.has(letter)) continue;
    switch (letter) {
      case 'a': options.stringFormat = 'ascii'; break;
      case 'x': options.stringFormat = 'hex'; break;
      case 'f': options.oidFormat = 'full'; break;
      case 'F': options.oidFormat = 'full-and-numeric'; break;
      case 'n': options.oidFormat = 'numeric'; break;
      case 's': options.oidFormat = 'suffix'; break;
      case 'S': options.oidFormat = 'module'; break;
      case 'u': options.oidFormat = 'ucd'; break;
      case 'q': options.quickPrint = !options.quickPrint; break;
      case 'Q':
        options.quickEqualsPrint = true;
        options.quickPrint = !options.quickPrint;
        break;
      case 't': options.numericTimeticks = !options.numericTimeticks; break;
      case 'T': options.hexText = !options.hexText; break;
      case 'v': options.bareValue = !options.bareValue; break;
      case 'p':
        return i + 1 < letters.length ? { kind: 'applied' } : { kind: 'precision-from-next-argument' };
      default: return { kind: 'unknown', letter };
    }
  }
  return { kind: 'applied' };
}

const ROOT_LABELS: ReadonlyMap<number, string> = new Map([
  [0, 'ccitt'], [1, 'iso'], [2, 'joint-iso-ccitt'],
]);

export function formatObjectIdentifier(oid: string, options: NetSnmpOutputOptions): string {
  const subIds = oid.split('.');
  const label = ROOT_LABELS.get(Number(subIds[0]));
  if (options.oidFormat === 'numeric' || label === undefined) return `.${oid}`;
  const rest = subIds.slice(1).map((subId) => `.${subId}`).join('');
  switch (options.oidFormat) {
    case 'full':
    case 'ucd':
      return `.${label}${rest}`;
    case 'full-and-numeric':
      return `.${label}(${subIds[0]})${rest}`;
    case 'module':
    case 'suffix':
      return `${label}${rest}`;
  }
}

const EXCEPTION_TEXT: Readonly<Partial<Record<SnmpValue['type'], string>>> = {
  'no-such-object': 'No Such Object available on this agent at this OID',
  'no-such-instance': 'No Such Instance currently exists at this OID',
  'end-of-mib-view': 'No more variables left in this MIB View (It is past the end of the MIB tree)',
};

export function isExceptionValue(value: SnmpValue): boolean {
  return EXCEPTION_TEXT[value.type] !== undefined;
}

export function formatVariable(binding: SnmpVarBinding, options: NetSnmpOutputOptions): string {
  const name = formatObjectIdentifier(binding.oid, options);
  let separator = ' = ';
  if (!options.quickEqualsPrint && options.quickPrint) separator = ' ';
  const head = options.bareValue ? '' : `${name}${separator}`;
  return head + (EXCEPTION_TEXT[binding.value.type] ?? formatValue(binding.value, options));
}

function formatValue(value: SnmpValue, options: NetSnmpOutputOptions): string {
  const typed = (prefix: string, text: string): string => options.quickPrint ? text : `${prefix}${text}`;
  switch (value.type) {
    case 'integer': return typed('INTEGER: ', String(Math.trunc(Number(value.value))));
    case 'octet-string': return formatOctetString(octetsOf(value), options);
    case 'object-id': return typed('OID: ', formatObjectIdentifier(String(value.value), options));
    case 'timeticks': return formatTimeticks(unsigned32(value), options);
    case 'gauge32': return typed('Gauge32: ', String(unsigned32(value)));
    case 'counter32': return typed('Counter32: ', String(unsigned32(value)));
    case 'counter64': return typed('Counter64: ', String(value.value));
    case 'ipv4': return typed('IpAddress: ', dottedQuad(value));
    case 'null': return 'NULL';
    default: return '';
  }
}

function unsigned32(value: SnmpValue): number {
  return Number(value.value) >>> 0;
}

function dottedQuad(value: SnmpValue): string {
  return value.value instanceof Uint8Array ? [...value.value.slice(0, 4)].join('.') : String(value.value);
}

export function octetsOf(value: SnmpValue): Uint8Array {
  if (value.value instanceof Uint8Array) return value.value;
  return new TextEncoder().encode(value.value === null ? '' : String(value.value));
}

function isPrintable(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e;
}

function isSpace(byte: number): boolean {
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
}

const HEX_OUTPUT_LENGTH = 16;

function formatOctetString(octets: Uint8Array, options: NetSnmpOutputOptions): string {
  const hex = options.stringFormat === 'hex'
    || (options.stringFormat === 'guess' && octets.some((byte) => !isPrintable(byte) && !isSpace(byte)));
  if (octets.length === 0) return '""';
  if (hex) {
    const lines: string[] = [];
    for (let start = 0; start < octets.length; start += HEX_OUTPUT_LENGTH) {
      const line = octets.slice(start, start + HEX_OUTPUT_LENGTH);
      const bytes = [...line].map((byte) => `${byte.toString(16).toUpperCase().padStart(2, '0')} `).join('');
      const text = options.hexText
        ? `  [${[...line].map((byte) => isPrintable(byte) || isSpace(byte) ? String.fromCharCode(byte) : '.').join('')}]`
        : '';
      lines.push(bytes + text);
    }
    const body = lines.join('\n');
    return options.quickPrint ? `"${body}"` : `Hex-STRING: ${body}`;
  }
  const text = [...octets].map((byte) => {
    if (!isPrintable(byte) && !isSpace(byte)) return '.';
    const char = String.fromCharCode(byte);
    return char === '\\' || char === '"' ? `\\${char}` : char;
  }).join('');
  return options.quickPrint ? `"${text}"` : `STRING: "${text}"`;
}

function formatTimeticks(ticks: number, options: NetSnmpOutputOptions): string {
  if (options.numericTimeticks) return String(ticks);
  const centiseconds = ticks % 100;
  let seconds = Math.floor(ticks / 100);
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  const clock = `${hours}:${two(minutes)}:${two(seconds)}.${two(centiseconds)}`;
  if (options.quickPrint) return `${days}:${clock}`;
  let uptime = clock;
  if (days === 1) uptime = `1 day, ${clock}`;
  else if (days > 1) uptime = `${days} days, ${clock}`;
  return `Timeticks: (${ticks}) ${uptime}`;
}
