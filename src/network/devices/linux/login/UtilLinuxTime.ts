import type { HostClock } from '../audit/tools/AuditHostClock';
import { strptime, type Tm } from '../time/Strptime';

const USEC_PER_SEC = 1_000_000;
const USEC_PER_MSEC = 1_000;
const USEC_PER_MINUTE = 60 * USEC_PER_SEC;
const USEC_PER_HOUR = 60 * USEC_PER_MINUTE;
const USEC_PER_DAY = 24 * USEC_PER_HOUR;
const USEC_PER_WEEK = 7 * USEC_PER_DAY;
const USEC_PER_MONTH = 2_629_800 * USEC_PER_SEC;
const USEC_PER_YEAR = 31_557_600 * USEC_PER_SEC;

const SUFFIXES: ReadonlyArray<readonly [string, number]> = [
  ['seconds', USEC_PER_SEC], ['second', USEC_PER_SEC], ['sec', USEC_PER_SEC], ['s', USEC_PER_SEC],
  ['minutes', USEC_PER_MINUTE], ['minute', USEC_PER_MINUTE], ['min', USEC_PER_MINUTE],
  ['months', USEC_PER_MONTH], ['month', USEC_PER_MONTH],
  ['msec', USEC_PER_MSEC], ['ms', USEC_PER_MSEC], ['m', USEC_PER_MINUTE],
  ['hours', USEC_PER_HOUR], ['hour', USEC_PER_HOUR], ['hr', USEC_PER_HOUR], ['h', USEC_PER_HOUR],
  ['days', USEC_PER_DAY], ['day', USEC_PER_DAY], ['d', USEC_PER_DAY],
  ['weeks', USEC_PER_WEEK], ['week', USEC_PER_WEEK], ['w', USEC_PER_WEEK],
  ['years', USEC_PER_YEAR], ['year', USEC_PER_YEAR], ['y', USEC_PER_YEAR],
  ['usec', 1], ['us', 1], ['', USEC_PER_SEC],
];

const WEEKDAYS: ReadonlyArray<readonly [string, number]> = [
  ['Sunday', 0], ['Sun', 0], ['Monday', 1], ['Mon', 1], ['Tuesday', 2], ['Tue', 2], ['Wednesday', 3], ['Wed', 3],
  ['Thursday', 4], ['Thu', 4], ['Friday', 5], ['Fri', 5], ['Saturday', 6], ['Sat', 6],
];

export interface BrokenDownTime {
  year: number;
  mon: number;
  mday: number;
  hour: number;
  min: number;
  sec: number;
}

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';

function strtoll(text: string, at: number): { value: number; end: number; overflow: boolean } {
  let i = at;
  while (i < text.length && (isSpace(text[i]) || text[i] === '\f' || text[i] === '\v')) i++;
  let negative = false;
  if (text[i] === '+' || text[i] === '-') {
    negative = text[i] === '-';
    i++;
  }
  const first = i;
  while (isDigit(text[i])) i++;
  if (i === first) return { value: 0, end: at, overflow: false };
  const big = BigInt(text.slice(first, i)) * (negative ? -1n : 1n);
  const overflow = big > 9223372036854775807n || big < -9223372036854775808n;
  return { value: Number(big), end: i, overflow };
}

function parseSec(text: string): number | null {
  let p = 0;
  let result = 0;
  let something = false;
  for (;;) {
    while (p < text.length && ' \t\n\r'.includes(text[p])) p++;
    if (p >= text.length) return something ? result : null;
    const parsed = strtoll(text, p);
    if (parsed.overflow) return null;
    if (parsed.value < 0) return null;
    let end = parsed.end;
    let z = 0;
    let n = 0;
    if (text[end] === '.') {
      const b = end + 1;
      const fraction = strtoll(text, b);
      if (fraction.overflow || fraction.value < 0) return null;
      if (fraction.end === b) return null;
      z = fraction.value;
      n = fraction.end - b;
      end = fraction.end;
    } else if (end === p) return null;
    while (end < text.length && ' \t\n\r'.includes(text[end])) end++;
    let matched = false;
    for (const [suffix, usec] of SUFFIXES) {
      if (text.startsWith(suffix, end)) {
        let k = z * usec;
        for (; n > 0; n--) k = Math.trunc(k / 10);
        result += parsed.value * usec + k;
        p = end + suffix.length;
        something = true;
        matched = true;
        break;
      }
    }
    if (!matched) return null;
  }
}

function parseSubseconds(text: string): number | null {
  if (text[0] !== '.' && text[0] !== ',') return null;
  let factor = USEC_PER_SEC / 10;
  let result = 0;
  for (let i = 1; i < text.length; i++) {
    if (!isDigit(text[i]) || factor < 1) return null;
    result += (text.charCodeAt(i) - 48) * factor;
    factor = Math.trunc(factor / 10);
  }
  return result;
}

export function parseTimestamp(input: string, nowSec: number, clock: HostClock): number | null {
  const initial = clock.localTime(nowSec);
  let tm: Tm = { year: initial.year, mon: initial.mon, mday: initial.mday, hour: initial.hour, min: initial.min, sec: initial.sec };
  let plus = 0;
  let minus = 0;
  let ret = 0;
  let weekday = -1;
  let t = input;

  const finish = (): number | null => {
    const x = clock.mktime(tm);
    if (!Number.isFinite(x)) return null;
    if (weekday >= 0 && clock.localTime(x).wday !== weekday) return null;
    ret += x * USEC_PER_SEC;
    ret += plus;
    ret = ret > minus ? ret - minus : 0;
    return ret;
  };

  if (t === 'now') return finish();
  if (t === 'today') {
    tm.hour = tm.min = tm.sec = 0;
    return finish();
  }
  if (t === 'yesterday') {
    tm.mday--;
    tm.hour = tm.min = tm.sec = 0;
    return finish();
  }
  if (t === 'tomorrow') {
    tm.mday++;
    tm.hour = tm.min = tm.sec = 0;
    return finish();
  }
  if (t[0] === '+') {
    const value = parseSec(t.slice(1));
    if (value === null) return null;
    plus = value;
    return finish();
  }
  if (t[0] === '-') {
    const value = parseSec(t.slice(1));
    if (value === null) return null;
    minus = value;
    return finish();
  }
  if (t[0] === '@') {
    const rest = t.slice(1);
    const consumed = strptime(rest, '%s', tm, clock);
    if (consumed >= 0 && consumed === rest.length) return finish();
    if (consumed >= 0) {
      const sub = parseSubseconds(rest.slice(consumed));
      if (sub !== null) {
        ret = sub;
        return finish();
      }
    }
    return null;
  }
  if (t.endsWith(' ago')) {
    const value = parseSec(t.slice(0, t.length - 4));
    if (value === null) return null;
    minus = value;
    return finish();
  }

  for (const [name, number] of WEEKDAYS) {
    if (!t.toLowerCase().startsWith(name.toLowerCase())) continue;
    if (t[name.length] !== ' ') continue;
    weekday = number;
    t = t.slice(name.length + 1);
    break;
  }

  const copy: Tm = { ...tm };
  const attempt = (format: string, afterSeconds: 'keep' | 'zeroSeconds' | 'zeroTime', allowSubseconds: boolean): number | null | undefined => {
    tm = { ...copy };
    const consumed = strptime(t, format, tm, clock);
    if (consumed < 0) return undefined;
    if (consumed === t.length) {
      if (afterSeconds === 'zeroSeconds') tm.sec = 0;
      if (afterSeconds === 'zeroTime') tm.hour = tm.min = tm.sec = 0;
      return finish();
    }
    if (allowSubseconds) {
      const sub = parseSubseconds(t.slice(consumed));
      if (sub !== null) {
        ret = sub;
        return finish();
      }
    }
    return undefined;
  };

  const formats: Array<[string, 'keep' | 'zeroSeconds' | 'zeroTime', boolean]> = [
    ['%y-%m-%d %H:%M:%S', 'keep', true],
    ['%Y-%m-%d %H:%M:%S', 'keep', true],
    ['%Y-%m-%dT%H:%M:%S', 'keep', true],
    ['%y-%m-%d %H:%M', 'zeroSeconds', false],
    ['%Y-%m-%d %H:%M', 'zeroSeconds', false],
    ['%y-%m-%d', 'zeroTime', false],
    ['%Y-%m-%d', 'zeroTime', false],
    ['%H:%M:%S', 'keep', true],
    ['%H:%M', 'zeroSeconds', false],
    ['%Y%m%d%H%M%S', 'keep', true],
  ];
  for (const [format, after, subseconds] of formats) {
    const outcome = attempt(format, after, subseconds);
    if (outcome !== undefined) return outcome;
  }
  return null;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

export function ctimeText(epochSec: number, clock: HostClock): string {
  const tm = clock.localTime(epochSec);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[tm.wday]} ${months[tm.mon]} ${String(tm.mday).padStart(2, ' ')} ${pad2(tm.hour)}:${pad2(tm.min)}:${pad2(tm.sec)} ${tm.year}`;
}

export function isoTimestamp(epochSec: number, clock: HostClock): string {
  const tm = clock.localTime(epochSec);
  const offsetSeconds = Math.round(Date.UTC(tm.year, tm.mon, tm.mday, tm.hour, tm.min, tm.sec) / 1000) - epochSec;
  const minutes = Math.trunc(offsetSeconds / 60);
  const zoneHour = Math.trunc(minutes / 60);
  const zoneMinute = Math.abs(minutes % 60);
  const signed = `${zoneHour < 0 ? '-' : '+'}${pad2(Math.abs(zoneHour))}`;
  return `${String(tm.year).padStart(4, ' ')}-${pad2(tm.mon + 1)}-${pad2(tm.mday)}T${pad2(tm.hour)}:${pad2(tm.min)}:${pad2(tm.sec)}${signed}:${pad2(zoneMinute)}`;
}
