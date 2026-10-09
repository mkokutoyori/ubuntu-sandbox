import { TimeZone } from '@/network/core/time/TimeZone';
import { isDaylightSavingAt, offsetMinutesAt, partsAt } from '@/network/core/time/TimeZoneRegistry';
import { hostClock, type HostClock } from '../audit/tools/AuditHostClock';
import { Tm, strptime } from '../time/Strptime';
import { abreviationA, trouverTimezone } from '../time/TimezoneDatabase';

export const USEC_PER_SEC = 1_000_000;
const USEC_PER_MSEC = 1_000;
const USEC_PER_MINUTE = 60 * USEC_PER_SEC;
const USEC_PER_HOUR = 60 * USEC_PER_MINUTE;
const USEC_PER_DAY = 24 * USEC_PER_HOUR;
const USEC_PER_WEEK = 7 * USEC_PER_DAY;
const USEC_PER_MONTH = 2_629_800 * USEC_PER_SEC;
const USEC_PER_YEAR = 31_557_600 * USEC_PER_SEC;
const USEC_INFINITY = 18_446_744_073_709_551_615n;
const USEC_TIMESTAMP_FORMATTABLE_MAX = 253_402_214_399_000_000;

const MULTIPLIERS: ReadonlyArray<readonly [string, number]> = [
  ['seconds', USEC_PER_SEC], ['second', USEC_PER_SEC], ['sec', USEC_PER_SEC], ['s', USEC_PER_SEC],
  ['minutes', USEC_PER_MINUTE], ['minute', USEC_PER_MINUTE], ['min', USEC_PER_MINUTE],
  ['months', USEC_PER_MONTH], ['month', USEC_PER_MONTH], ['M', USEC_PER_MONTH],
  ['msec', USEC_PER_MSEC], ['ms', USEC_PER_MSEC], ['m', USEC_PER_MINUTE],
  ['hours', USEC_PER_HOUR], ['hour', USEC_PER_HOUR], ['hr', USEC_PER_HOUR], ['h', USEC_PER_HOUR],
  ['days', USEC_PER_DAY], ['day', USEC_PER_DAY], ['d', USEC_PER_DAY],
  ['weeks', USEC_PER_WEEK], ['week', USEC_PER_WEEK], ['w', USEC_PER_WEEK],
  ['years', USEC_PER_YEAR], ['year', USEC_PER_YEAR], ['y', USEC_PER_YEAR],
  ['usec', 1], ['us', 1], ['μs', 1], ['µs', 1],
];

const WHITESPACE = ' \t\n\r';
const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';

export type ParsedTime = { ok: true; usec: number } | { ok: false; errno: 'EINVAL' | 'ERANGE' };

function skipSpaces(text: string, at: number): number {
  while (at < text.length && WHITESPACE.includes(text[at])) at++;
  return at;
}

function extractMultiplier(text: string, at: number): { multiplier: number | null; end: number } {
  for (const [suffix, usec] of MULTIPLIERS) {
    if (text.startsWith(suffix, at)) return { multiplier: usec, end: at + suffix.length };
  }
  return { multiplier: null, end: at };
}

export function parseTime(text: string, defaultUnit: number): ParsedTime {
  let p = skipSpaces(text, 0);
  if (text.startsWith('infinity', p)) {
    const s = skipSpaces(text, p + 'infinity'.length);
    if (s < text.length) return { ok: false, errno: 'EINVAL' };
    return { ok: true, usec: Number.POSITIVE_INFINITY };
  }
  let usec = 0n;
  let something = false;
  for (;;) {
    let multiplier = BigInt(defaultUnit);
    p = skipSpaces(text, p);
    if (p >= text.length) {
      if (!something) return { ok: false, errno: 'EINVAL' };
      break;
    }
    if (text[p] === '-') return { ok: false, errno: 'ERANGE' };
    let e = p;
    if (text[e] === '+') e++;
    const digitsStart = e;
    while (isDigit(text[e])) e++;
    const hasDigits = e > digitsStart;
    const value = hasDigits ? BigInt(text.slice(digitsStart, e)) : 0n;
    if (value > 9223372036854775807n) return { ok: false, errno: 'ERANGE' };
    const fractionStart = e;
    if (text[e] === '.') {
      p = e + 1;
      while (isDigit(text[p])) p++;
    } else if (!hasDigits) return { ok: false, errno: 'EINVAL' };
    else p = e;
    const afterSpaces = skipSpaces(text, p);
    const found = extractMultiplier(text, afterSpaces);
    if (found.multiplier !== null) multiplier = BigInt(found.multiplier);
    if (found.end === p && found.end < text.length) return { ok: false, errno: 'EINVAL' };
    p = found.end;
    if (value >= USEC_INFINITY / multiplier) return { ok: false, errno: 'ERANGE' };
    const k = value * multiplier;
    if (k >= USEC_INFINITY - usec) return { ok: false, errno: 'ERANGE' };
    usec += k;
    something = true;
    if (text[fractionStart] === '.') {
      let m = multiplier / 10n;
      let b = fractionStart + 1;
      for (; isDigit(text[b]); b++, m /= 10n) {
        const piece = BigInt(text.charCodeAt(b) - 48) * m;
        if (piece >= USEC_INFINITY - usec) return { ok: false, errno: 'ERANGE' };
        usec += piece;
      }
      if (b === fractionStart + 1) return { ok: false, errno: 'EINVAL' };
    }
  }
  return { ok: true, usec: Number(usec) };
}

export function parseSec(text: string): ParsedTime {
  return parseTime(text, USEC_PER_SEC);
}

export type TimestampStyle = 'pretty' | 'us' | 'utc' | 'us-utc' | 'date' | 'unix';

export interface Zone {
  readonly name: string;
  localTime: HostClock['localTime'];
  mktime(tm: Tm): number;
  abbreviationAt(epochSec: number): string;
  standardAndDaylightNames(): readonly [string, string];
}

export interface SystemdClock {
  readonly local: Zone;
  readonly utc: Zone;
  zoneByName(name: string): Zone | null;
}

function glibcMktime(zone: TimeZone): (tm: Tm) => number {
  let utcOffsetGuess = 0;
  const localSeconds = (t: number): number => {
    const p = partsAt(zone, t * 1000);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  };
  return tm => {
    const requested = Date.UTC(tm.year, tm.mon, tm.mday, tm.hour, tm.min, tm.sec) / 1000;
    let t = requested - utcOffsetGuess;
    let t1 = t;
    let t2 = t;
    let dst2 = false;
    for (let guard = 0; guard < 48; guard++) {
      const isdst = isDaylightSavingAt(zone, t * 1000);
      const gt = t + (requested - localSeconds(t));
      if (t === gt) break;
      if (t === t1 && t !== t2 && dst2 <= isdst) break;
      t1 = t2;
      t2 = t;
      t = gt;
      dst2 = isdst;
    }
    utcOffsetGuess = requested - t;
    return t;
  };
}

function makeZone(zone: TimeZone, requestedName: string): Zone {
  const utc = zone.name === 'UTC';
  return {
    name: zone.name,
    localTime: hostClock(zone.name).localTime,
    mktime: utc ? tm => Date.UTC(tm.year, tm.mon, tm.mday, tm.hour, tm.min, tm.sec) / 1000 : glibcMktime(zone),
    abbreviationAt: epochSec => (utc ? 'UTC' : abreviationA(requestedName, epochSec * 1000)),
    standardAndDaylightNames: () => {
      if (utc) return ['UTC', 'UTC'];
      const tabulated = trouverTimezone(requestedName);
      return [tabulated?.abbr ?? abreviationA(requestedName, Date.UTC(2000, 0, 1)), tabulated?.abbrDst ?? tabulated?.abbr ?? abreviationA(requestedName, Date.UTC(2000, 6, 1))];
    },
  };
}

export function systemdClock(zoneName: string): SystemdClock {
  const local = makeZone(TimeZone.parse(zoneName) ?? TimeZone.UTC, zoneName);
  const utc = makeZone(TimeZone.UTC, 'UTC');
  return {
    local,
    utc,
    zoneByName: name => {
      if (!isZoneFileName(name)) return null;
      const zone = TimeZone.parse(name);
      return zone === null ? null : makeZone(zone, name);
    },
  };
}

function isZoneFileName(name: string): boolean {
  if (name === '' || name.startsWith('/') || name.includes('..') || name.endsWith('/')) return false;
  return /^[A-Za-z0-9._+\-/]+$/.test(name) && name.length <= 256;
}

const WEEKDAY_ABBREVIATIONS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad2 = (value: number): string => String(value).padStart(2, '0');

export function formatTimestamp(usec: number, style: TimestampStyle, clock: SystemdClock): string | null {
  if (!Number.isFinite(usec) || usec <= 0) return null;
  if (style === 'unix') return `@${Math.floor(usec / USEC_PER_SEC)}`;
  const utc = style === 'utc' || style === 'us-utc' || style === 'date';
  const withMicroseconds = style === 'us' || style === 'us-utc';
  if (usec > USEC_TIMESTAMP_FORMATTABLE_MAX) {
    const placeholders: Record<string, string> = {
      pretty: '--- XXXX-XX-XX XX:XX:XX',
      us: '--- XXXX-XX-XX XX:XX:XX.XXXXXX',
      utc: '--- XXXX-XX-XX XX:XX:XX UTC',
      'us-utc': '--- XXXX-XX-XX XX:XX:XX.XXXXXX UTC',
      date: '--- XXXX-XX-XX',
    };
    return placeholders[style];
  }
  const seconds = Math.floor(usec / USEC_PER_SEC);
  const tm = (utc ? clock.utc : clock.local).localTime(seconds);
  let text = `${WEEKDAY_ABBREVIATIONS[tm.wday]} ${String(tm.year).padStart(4, '0')}-${pad2(tm.mon + 1)}-${pad2(tm.mday)}`;
  if (style === 'date') return text;
  text += ` ${pad2(tm.hour)}:${pad2(tm.min)}:${pad2(tm.sec)}`;
  if (withMicroseconds) text += `.${String(usec % USEC_PER_SEC).padStart(6, '0')}`;
  if (utc) return `${text} UTC`;
  const abbreviation = clock.local.abbreviationAt(seconds);
  return abbreviation === '' ? text : `${text} ${abbreviation}`;
}

const DAY_NAMES: ReadonlyArray<readonly [string, number]> = [
  ['Sunday', 0], ['Sun', 0], ['Monday', 1], ['Mon', 1], ['Tuesday', 2], ['Tue', 2], ['Wednesday', 3], ['Wed', 3],
  ['Thursday', 4], ['Thu', 4], ['Friday', 5], ['Fri', 5], ['Saturday', 6], ['Sat', 6],
];

function weekdayOf(tm: Tm): number {
  return new Date(Date.UTC(tm.year, tm.mon, tm.mday)).getUTCDay();
}

function parseFractionalPart(text: string, at: number, digits: number): { value: number; end: number } | null {
  let value = 0;
  let i = at;
  let count = 0;
  for (; count < digits; count++, i++) {
    if (!isDigit(text[i])) {
      if (count === 0) return null;
      for (; count < digits; count++) value *= 10;
      break;
    }
    value = value * 10 + (text.charCodeAt(i) - 48);
  }
  if (text[i] !== undefined && text[i] >= '5' && text[i] <= '9') value++;
  while (isDigit(text[i])) i++;
  return { value, end: i };
}

interface ParseOptions {
  maxLength: number | null;
  utc: boolean;
  gmtoff: number;
  zone: Zone;
  nowUsec: number;
}

function parseTimestampImpl(input: string, options: ParseOptions): number | null {
  const zone = options.zone;
  let t = input;
  const { utc, gmtoff } = options;
  const withTz = options.maxLength !== null;
  if (options.maxLength !== null) {
    if (options.maxLength === 0) return null;
    t = t.slice(0, options.maxLength);
  }
  if (utc) {
    if (Math.abs(gmtoff) * USEC_PER_SEC > USEC_PER_DAY) return null;
  } else if (gmtoff !== 0) return null;

  if (t[0] === '@' && !withTz) {
    const parsed = parseSec(t.slice(1));
    return parsed.ok ? parsed.usec : null;
  }

  let usec = options.nowUsec;
  let plus = 0;
  let minus = 0;
  let fractional = 0;

  const finish = (): number | null => {
    usec += plus;
    if (usec < minus) return null;
    usec -= minus;
    if (usec > USEC_TIMESTAMP_FORMATTABLE_MAX) return null;
    return usec;
  };

  if (!withTz) {
    if (t === 'now') return finish();
    if (t[0] === '+' || t[0] === '-') {
      const parsed = parseSec(t.slice(1));
      if (!parsed.ok) return null;
      if (t[0] === '+') plus = parsed.usec;
      else minus = parsed.usec;
      return finish();
    }
    if (t.endsWith(' ago') || t.endsWith(' left')) {
      const ago = t.endsWith(' ago');
      const parsed = parseSec(t.slice(0, t.length - 5 + (ago ? 1 : 0)));
      if (!parsed.ok) return null;
      if (ago) minus = parsed.usec;
      else plus = parsed.usec;
      return finish();
    }
  }

  const nowSec = Math.floor(usec / USEC_PER_SEC);
  const local = zone.localTime(nowSec);
  let tm: Tm = { year: local.year, mon: local.mon, mday: local.mday, hour: local.hour, min: local.min, sec: local.sec };
  let weekday = -1;

  const fromTm = (): number | null => {
    if (weekday >= 0 && weekdayOf(tm) !== weekday) return null;
    let shift = 0;
    let adjusted: Tm = tm;
    let pluswork = 0;
    let minuswork = 0;
    if (gmtoff < 0) {
      pluswork = -gmtoff * USEC_PER_SEC;
      if (tm.year === 1969 && tm.mon === 11 && tm.mday === 31) {
        adjusted = { ...tm, year: 1970, mon: 0, mday: 1 };
        shift = USEC_PER_DAY;
      }
    } else minuswork = gmtoff * USEC_PER_SEC;
    const sec = zone.mktime(adjusted);
    if (!Number.isFinite(sec) || sec < 0) return null;
    usec = sec * USEC_PER_SEC + fractional;
    plus = pluswork;
    minus = minuswork + shift;
    return finish();
  };

  if (t === 'today') {
    tm.hour = tm.min = tm.sec = 0;
    return fromTm();
  }
  if (t === 'yesterday') {
    tm.mday--;
    tm.hour = tm.min = tm.sec = 0;
    return fromTm();
  }
  if (t === 'tomorrow') {
    tm.mday++;
    tm.hour = tm.min = tm.sec = 0;
    return fromTm();
  }

  for (const [name, number] of DAY_NAMES) {
    if (t.length > name.length && t.slice(0, name.length).toLowerCase() === name.toLowerCase() && t[name.length] === ' ') {
      weekday = number;
      t = t.slice(name.length + 1);
      break;
    }
  }

  const copy: Tm = { ...tm };
  type Zeroing = 'none' | 'seconds' | 'time';
  const attempts: Array<[string, Zeroing, boolean]> = [
    ['%y-%m-%d %H:%M:%S', 'none', true],
    ['%Y-%m-%d %H:%M:%S', 'none', true],
    ['%Y-%m-%dT%H:%M:%S', 'none', true],
    ['%b %d %H:%M:%S', 'none', true],
    ['%y-%m-%d %H:%M', 'seconds', false],
    ['%Y-%m-%d %H:%M', 'seconds', false],
    ['%Y-%m-%dT%H:%M', 'seconds', false],
    ['%y-%m-%d', 'time', false],
    ['%Y-%m-%d', 'time', false],
    ['%H:%M:%S', 'none', true],
    ['%H:%M', 'seconds', false],
  ];
  for (const [format, zeroing, allowFraction] of attempts) {
    tm = { ...copy };
    const consumed = strptime(t, format, tm, zone);
    if (consumed < 0) continue;
    if (consumed === t.length) {
      if (zeroing === 'seconds') tm.sec = 0;
      if (zeroing === 'time') tm.hour = tm.min = tm.sec = 0;
      return fromTm();
    }
    if (allowFraction && t[consumed] === '.') {
      const parsed = parseFractionalPart(t, consumed + 1, 6);
      if (parsed === null || parsed.end !== t.length) return null;
      fractional = parsed.value;
      return fromTm();
    }
  }
  return null;
}

function offsetFromSuffix(text: string, clock: SystemdClock): number | null {
  const tm: Tm = { year: 1970, mon: 0, mday: 1, hour: 0, min: 0, sec: 0 };
  const consumed = strptime(text, '%z', tm, clock.local);
  return consumed >= 0 && consumed === text.length ? (tm.gmtoff ?? 0) : null;
}

export function parseTimestamp(text: string, nowUsec: number, clock: SystemdClock): number | null {
  const impl = (maxLength: number | null, utc: boolean, gmtoff: number, zone: Zone): number | null =>
    parseTimestampImpl(text, { maxLength, utc, gmtoff, zone, nowUsec });
  const length = text.length;
  if (length > 2 && text[length - 1] === 'Z' && text[length - 2] !== ' ') return impl(length - 1, true, 0, clock.utc);
  if (length > 7 && (text[length - 6] === '+' || text[length - 6] === '-') && text[length - 7] !== ' ') {
    const offset = offsetFromSuffix(text.slice(length - 6), clock);
    if (offset !== null) return impl(length - 6, true, offset, clock.utc);
  }
  const space = text.lastIndexOf(' ');
  if (space < 0) return impl(null, false, 0, clock.local);
  const tz = text.slice(space + 1);
  if (tz === 'UTC') return impl(space, true, 0, clock.utc);
  const offset = offsetFromSuffix(tz, clock);
  if (offset !== null) return impl(space, true, offset, clock.utc);
  const named = clock.zoneByName(tz);
  if (named === null) return withLocalTzName(text, space + 1, false, clock, impl);
  if (clock.local.name === named.name) return withLocalTzName(text, space + 1, true, clock, impl);
  return impl(space, false, 0, named);
}

function withLocalTzName(
  text: string, tzOffset: number, validZone: boolean, clock: SystemdClock,
  impl: (maxLength: number | null, utc: boolean, gmtoff: number, zone: Zone) => number | null,
): number | null {
  for (const name of clock.local.standardAndDaylightNames()) {
    if (name !== '' && text.slice(tzOffset) === name) return impl(tzOffset - 1, false, 0, clock.local);
  }
  return impl(validZone ? tzOffset - 1 : null, false, 0, clock.local);
}
