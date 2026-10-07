import { PSRuntimeError } from './PSRuntimeError';
import type { PSValue } from './PSEnvironment';

const TICKS_PER_MS = 10_000;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const MAX_TICKS = 2 ** 63;

export function makeTimeSpan(ms: number): Record<string, PSValue> {
  const abs = Math.abs(ms);
  const sign = ms < 0 ? -1 : 1;
  const record: Record<string, PSValue> = {
    Days: sign * Math.floor(abs / MS_PER_DAY),
    Hours: sign * Math.floor((abs % MS_PER_DAY) / MS_PER_HOUR),
    Minutes: sign * Math.floor((abs % MS_PER_HOUR) / MS_PER_MINUTE),
    Seconds: sign * Math.floor((abs % MS_PER_MINUTE) / MS_PER_SECOND),
    Milliseconds: sign * Math.floor(abs % MS_PER_SECOND),
    Ticks: Math.round(ms * TICKS_PER_MS),
    TotalDays: ms / MS_PER_DAY,
    TotalHours: ms / MS_PER_HOUR,
    TotalMinutes: ms / MS_PER_MINUTE,
    TotalSeconds: ms / MS_PER_SECOND,
    TotalMilliseconds: ms,
  };
  Object.defineProperty(record, '__type', { value: 'TimeSpan', enumerable: false });
  return record;
}

export function isTimeSpan(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).__type === 'TimeSpan'
    && typeof (value as Record<string, unknown>).TotalMilliseconds === 'number';
}

export function timeSpanMillis(value: PSValue): number {
  if (isTimeSpan(value)) return (value as Record<string, PSValue>).TotalMilliseconds as number;
  return Number(value);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function fractionOf(abs: number): string {
  const ticks = Math.round((abs % MS_PER_SECOND) * TICKS_PER_MS);
  return pad(ticks, 7);
}

function components(ms: number): { negative: boolean; days: number; hours: number; minutes: number; seconds: number; fraction: string } {
  const abs = Math.abs(ms);
  return {
    negative: ms < 0,
    days: Math.floor(abs / MS_PER_DAY),
    hours: Math.floor((abs % MS_PER_DAY) / MS_PER_HOUR),
    minutes: Math.floor((abs % MS_PER_HOUR) / MS_PER_MINUTE),
    seconds: Math.floor((abs % MS_PER_MINUTE) / MS_PER_SECOND),
    fraction: fractionOf(abs),
  };
}

function invalidFormat(): never {
  throw new PSRuntimeError('Exception calling "ToString" with "1" argument(s): "Input string was not in a correct format."');
}

function customFormat(ms: number, format: string): string {
  const c = components(ms);
  let out = '';
  let i = 0;
  const run = (letter: string): number => {
    let n = 0;
    while (format[i + n] === letter) n++;
    return n;
  };
  while (i < format.length) {
    const ch = format[i];
    if (ch === '\\') { out += format[i + 1] ?? ''; i += 2; continue; }
    if (ch === '\'' || ch === '"') {
      const close = format.indexOf(ch, i + 1);
      if (close < 0) invalidFormat();
      out += format.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    const n = run(ch);
    switch (ch) {
      case 'd': if (n > 8) invalidFormat(); out += pad(c.days, n); break;
      case 'h': if (n > 2) invalidFormat(); out += pad(c.hours, n); break;
      case 'm': if (n > 2) invalidFormat(); out += pad(c.minutes, n); break;
      case 's': if (n > 2) invalidFormat(); out += pad(c.seconds, n); break;
      case 'f': if (n > 7) invalidFormat(); out += c.fraction.slice(0, n); break;
      case 'F': {
        if (n > 7) invalidFormat();
        const trimmed = c.fraction.slice(0, n).replace(/0+$/, '');
        out += trimmed;
        break;
      }
      case '%': i += 1; continue;
      default: invalidFormat();
    }
    i += n;
  }
  return out;
}

export function formatTimeSpan(ms: number, format?: string): string {
  const c = components(ms);
  const sign = c.negative ? '-' : '';
  const hasFraction = c.fraction !== '0000000';
  switch (format) {
    case undefined: case '': case 'c': case 't': case 'T': {
      const days = c.days !== 0 ? `${c.days}.` : '';
      return `${sign}${days}${pad(c.hours, 2)}:${pad(c.minutes, 2)}:${pad(c.seconds, 2)}${hasFraction ? `.${c.fraction}` : ''}`;
    }
    case 'g': {
      const days = c.days !== 0 ? `${c.days}:` : '';
      const fraction = hasFraction ? `.${c.fraction.replace(/0+$/, '')}` : '';
      return `${sign}${days}${c.hours}:${pad(c.minutes, 2)}:${pad(c.seconds, 2)}${fraction}`;
    }
    case 'G':
      return `${sign}${c.days}:${pad(c.hours, 2)}:${pad(c.minutes, 2)}:${pad(c.seconds, 2)}.${c.fraction}`;
    default:
      if (format.length === 1) invalidFormat();
      return customFormat(ms, format);
  }
}

const CONSTANT_FORMAT = /^\s*(-)?(?:(\d+)\.)?(\d+):(\d+)(?::(\d+)(?:\.(\d{1,7}))?)?\s*$/;
const DAYS_ONLY = /^\s*(-)?(\d+)\s*$/;

export function parseTimeSpan(text: string): number | null {
  const days = DAYS_ONLY.exec(text);
  if (days !== null) return (days[1] === '-' ? -1 : 1) * Number(days[2]) * MS_PER_DAY;
  const m = CONSTANT_FORMAT.exec(text);
  if (m === null) return null;
  const hours = Number(m[3]);
  const minutes = Number(m[4]);
  const seconds = Number(m[5] ?? 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const fraction = m[6] === undefined ? 0 : Number(m[6].padEnd(7, '0')) / TICKS_PER_MS;
  const total = Number(m[2] ?? 0) * MS_PER_DAY + hours * MS_PER_HOUR + minutes * MS_PER_MINUTE + seconds * MS_PER_SECOND + fraction;
  return m[1] === '-' ? -total : total;
}

export function timeSpanMember(span: Record<string, PSValue>, member: string): PSValue {
  const ms = span.TotalMilliseconds as number;
  switch (member) {
    case 'tostring': return (format?: PSValue) => formatTimeSpan(ms, format === undefined || format === null ? undefined : String(format));
    case 'add': return (other: PSValue) => makeTimeSpan(ms + timeSpanMillis(other));
    case 'subtract': return (other: PSValue) => makeTimeSpan(ms - timeSpanMillis(other));
    case 'negate': return () => makeTimeSpan(-ms);
    case 'duration': return () => makeTimeSpan(Math.abs(ms));
    case 'compareto': return (other: PSValue) => {
      const target = timeSpanMillis(other);
      return ms < target ? -1 : ms > target ? 1 : 0;
    };
    case 'equals': return (other: PSValue) => isTimeSpan(other) && (other as Record<string, PSValue>).TotalMilliseconds === ms;
    case 'gethashcode': return () => Math.round(ms * TICKS_PER_MS) % 2_147_483_647;
    case 'gettype': return () => ({
      Name: 'TimeSpan', FullName: 'System.TimeSpan', Namespace: 'System', BaseType: 'System.ValueType',
      IsValueType: true, toString: () => 'System.TimeSpan',
    }) as unknown as PSValue;
    default: return null;
  }
}

function fromUnit(unitMs: number): (value: PSValue) => PSValue {
  return (value) => makeTimeSpan(Number(value) * unitMs) as unknown as PSValue;
}

export function timeSpanStatics(): Record<string, PSValue> {
  return {
    fromdays: fromUnit(MS_PER_DAY),
    fromhours: fromUnit(MS_PER_HOUR),
    fromminutes: fromUnit(MS_PER_MINUTE),
    fromseconds: fromUnit(MS_PER_SECOND),
    frommilliseconds: fromUnit(1),
    fromticks: fromUnit(1 / TICKS_PER_MS),
    zero: makeTimeSpan(0) as unknown as PSValue,
    maxvalue: makeTimeSpan(MAX_TICKS / TICKS_PER_MS) as unknown as PSValue,
    minvalue: makeTimeSpan(-MAX_TICKS / TICKS_PER_MS) as unknown as PSValue,
    ticksperday: MS_PER_DAY * TICKS_PER_MS,
    tickspersecond: MS_PER_SECOND * TICKS_PER_MS,
    ticksperminute: MS_PER_MINUTE * TICKS_PER_MS,
    ticksperhour: MS_PER_HOUR * TICKS_PER_MS,
    tickspermillisecond: TICKS_PER_MS,
    parse: (text: PSValue) => {
      const parsed = parseTimeSpan(String(text));
      if (parsed === null) {
        throw new PSRuntimeError('Exception calling "Parse" with "1" argument(s): "String was not recognized as a valid TimeSpan."');
      }
      return makeTimeSpan(parsed) as unknown as PSValue;
    },
    compare: (a: PSValue, b: PSValue) => {
      const left = timeSpanMillis(a);
      const right = timeSpanMillis(b);
      return left < right ? -1 : left > right ? 1 : 0;
    },
    equals: (a: PSValue, b: PSValue) => timeSpanMillis(a) === timeSpanMillis(b),
  };
}
