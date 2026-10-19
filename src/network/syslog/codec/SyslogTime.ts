export type OffsetMode = '' | '+' | '-' | 'Z';

export type SyslogTimeType = 0 | 1 | 2;

export interface SyslogTime {
  readonly timeType: SyslogTimeType;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly secfrac: number;
  readonly secfracPrecision: number;
  readonly offsetMode: OffsetMode;
  readonly offsetHour: number;
  readonly offsetMinute: number;
}

export const TIME_TYPE_RFC3164: SyslogTimeType = 1;
export const TIME_TYPE_RFC5424: SyslogTimeType = 2;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTH_LOOKUP: Readonly<Record<string, number>> = Object.fromEntries(
  MONTH_NAMES.map((name, index) => [name.toLowerCase(), index + 1]),
);

export const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const MONTH_FULL_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
] as const;
export const WEEKDAY_FULL_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export function monthName(month: number): string {
  return MONTH_NAMES[(month - 1) % 12];
}

export function offsetSeconds(time: SyslogTime): number {
  const magnitude = time.offsetHour * 3600 + time.offsetMinute * 60;
  return time.offsetMode === '-' ? -magnitude : time.offsetMode === '+' ? magnitude : 0;
}

export function syslogTimeFromEpochMs(epochMs: number, offsetMinutes: number, secfracPrecision = 6, timeType: SyslogTimeType = TIME_TYPE_RFC5424): SyslogTime {
  const shifted = new Date(epochMs + offsetMinutes * 60_000);
  const magnitude = Math.abs(offsetMinutes);
  const microseconds = Math.floor((((epochMs % 1000) + 1000) % 1000) * 1000);
  const precision = Math.max(0, Math.min(6, secfracPrecision));
  return {
    timeType,
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    secfrac: precision === 0 ? 0 : Math.floor(microseconds / 10 ** (6 - precision)),
    secfracPrecision: precision,
    offsetMode: offsetMinutes < 0 ? '-' : '+',
    offsetHour: Math.floor(magnitude / 60),
    offsetMinute: magnitude % 60,
  };
}

export function syslogTimeToEpochMs(time: SyslogTime): number {
  const utcFields = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  const fractionMs = time.secfracPrecision === 0
    ? 0
    : Math.floor((time.secfrac / 10 ** Math.min(6, time.secfracPrecision)) * 1000);
  return utcFields - offsetSeconds(time) * 1000 + fractionMs;
}

export function syslogTimeToUnixSeconds(time: SyslogTime): number {
  if (time.year < 1970 || time.year > 2100) return 0;
  return Math.floor((Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second) - offsetSeconds(time) * 1000) / 1000);
}

export function weekdayNumber(time: SyslogTime): number {
  return new Date(Date.UTC(time.year, time.month - 1, time.day)).getUTCDay();
}

export function ordinalDay(time: SyslogTime): number {
  const start = Date.UTC(time.year, 0, 1);
  return Math.floor((Date.UTC(time.year, time.month - 1, time.day) - start) / 86_400_000);
}

export function weekNumber(time: SyslogTime): number {
  const jan1 = new Date(Date.UTC(time.year, 0, 1)).getUTCDay();
  const week = Math.floor((ordinalDay(time) + 6) / 7);
  return weekdayNumber(time) < jan1 ? week + 1 : week;
}

function weeksInYear(year: number): number {
  const p = (value: number): number => (value + Math.floor(value / 4) - Math.floor(value / 100) + Math.floor(value / 400)) % 7;
  return p(year) === 4 || p(year - 1) === 3 ? 53 : 52;
}

export function isoWeek(time: SyslogTime): { week: number; year: number } {
  let dayOfWeek = weekdayNumber(time);
  if (dayOfWeek === 0) dayOfWeek = 7;
  let week = Math.floor((10 + ordinalDay(time) + 1 - dayOfWeek) / 7);
  let year = time.year;
  if (week === 0) {
    week = weeksInYear(time.year - 1);
    year = time.year - 1;
  } else if (week > weeksInYear(time.year)) {
    week = 1;
    year = time.year + 1;
  }
  return { week, year };
}

function twoDigits(value: number): string {
  return String(Math.floor(value) % 100).padStart(2, '0');
}

function fourDigits(value: number): string {
  return String(Math.floor(value) % 10000).padStart(4, '0');
}

export function formatSecFrac(time: SyslogTime): string {
  if (time.secfracPrecision <= 0) return '0';
  const precision = Math.min(6, time.secfracPrecision);
  return String(time.secfrac).padStart(precision, '0').slice(-precision);
}

export function formatTimestamp3339(time: SyslogTime): string {
  const head = `${fourDigits(time.year)}-${twoDigits(time.month)}-${twoDigits(time.day)}T${twoDigits(time.hour)}:${twoDigits(time.minute)}:${twoDigits(time.second)}`;
  const fraction = time.secfracPrecision > 0 ? `.${formatSecFrac(time)}` : '';
  const zone = time.offsetMode === 'Z' ? 'Z' : `${time.offsetMode}${twoDigits(time.offsetHour)}:${twoDigits(time.offsetMinute)}`;
  return head + fraction + zone;
}

export function formatTimestamp3164(time: SyslogTime, buggyDay = false): string {
  const dayTens = Math.floor(time.day / 10) % 10;
  const day = (buggyDay || dayTens > 0 ? String(dayTens) : ' ') + String(time.day % 10);
  return `${monthName(time.month)} ${day} ${twoDigits(time.hour)}:${twoDigits(time.minute)}:${twoDigits(time.second)}`;
}

export function formatTimestampMySql(time: SyslogTime): string {
  return `${fourDigits(time.year)}${twoDigits(time.month)}${twoDigits(time.day)}${twoDigits(time.hour)}${twoDigits(time.minute)}${twoDigits(time.second)}`;
}

export function formatTimestampPgSql(time: SyslogTime): string {
  return `${fourDigits(time.year)}-${twoDigits(time.month)}-${twoDigits(time.day)} ${twoDigits(time.hour)}:${twoDigits(time.minute)}:${twoDigits(time.second)}`;
}

export function formatTimestampUnix(time: SyslogTime): string {
  return String(syslogTimeToUnixSeconds(time));
}

export function formatTimestampOffset(time: SyslogTime): string {
  return time.offsetMode === 'Z' || time.offsetMode === '' ? '+00:00' : `${time.offsetMode}${twoDigits(time.offsetHour)}:${twoDigits(time.offsetMinute)}`;
}

interface Cursor {
  text: string;
  position: number;
}

function parseInteger(cursor: Cursor): number {
  let value = 0;
  while (cursor.position < cursor.text.length && cursor.text[cursor.position] >= '0' && cursor.text[cursor.position] <= '9' && value < 214748363) {
    value = value * 10 + (cursor.text.charCodeAt(cursor.position) - 48);
    cursor.position++;
  }
  return value;
}

export interface ParsedTimestamp {
  readonly time: SyslogTime;
  readonly consumed: number;
}

export function parseTimestamp3339(text: string): ParsedTimestamp | null {
  const cursor: Cursor = { text, position: 0 };
  const year = parseInteger(cursor);
  if (cursor.position >= text.length || text[cursor.position++] !== '-' || year < 0 || year >= 2100) return null;
  const month = parseInteger(cursor);
  if (month < 1 || month > 12) return null;
  if (cursor.position >= text.length || text[cursor.position++] !== '-') return null;
  const day = parseInteger(cursor);
  if (day < 1 || day > 31) return null;
  if (cursor.position >= text.length || text[cursor.position++] !== 'T') return null;
  const hour = parseInteger(cursor);
  if (hour < 0 || hour > 23) return null;
  if (cursor.position >= text.length || text[cursor.position++] !== ':') return null;
  const minute = parseInteger(cursor);
  if (minute < 0 || minute > 59) return null;
  if (cursor.position >= text.length || text[cursor.position++] !== ':') return null;
  const second = parseInteger(cursor);
  if (second < 0 || second > 60) return null;

  let secfrac = 0;
  let secfracPrecision = 0;
  if (cursor.position < text.length && text[cursor.position] === '.') {
    cursor.position++;
    const start = cursor.position;
    secfrac = parseInteger(cursor);
    secfracPrecision = cursor.position - start;
  }
  if (cursor.position >= text.length) return null;

  let offsetMode: OffsetMode;
  let offsetHour = 0;
  let offsetMinute = 0;
  const zone = text[cursor.position];
  if (zone === 'Z') {
    cursor.position++;
    offsetMode = 'Z';
  } else if (zone === '+' || zone === '-') {
    offsetMode = zone;
    cursor.position++;
    offsetHour = parseInteger(cursor);
    if (offsetHour < 0 || offsetHour > 23) return null;
    if (cursor.position >= text.length || text[cursor.position] !== ':') return null;
    cursor.position++;
    offsetMinute = parseInteger(cursor);
    if (offsetMinute < 0 || offsetMinute > 59) return null;
  } else {
    return null;
  }
  if (cursor.position < text.length) {
    if (text[cursor.position] !== ' ') return null;
    cursor.position++;
  }
  return {
    time: { timeType: TIME_TYPE_RFC5424, year, month, day, hour, minute, second, secfrac, secfracPrecision, offsetMode, offsetHour, offsetMinute },
    consumed: cursor.position,
  };
}

export interface Timestamp3164Options {
  readonly detectYearAfterTimestamp?: boolean;
  readonly timeZoneNames?: ReadonlyMap<string, { mode: '+' | '-'; hour: number; minute: number }>;
  readonly parseTimeZone?: boolean;
}

export function parseTimestamp3164(text: string, base: SyslogTime, options: Timestamp3164Options = {}): ParsedTimestamp | null {
  if (text.length < 3) return null;
  const cursor: Cursor = { text, position: 0 };
  let year = 0;
  if (text[0] >= '0' && text[0] <= '9') {
    year = parseInteger(cursor);
    if (year < 1970 || year > 2100 || text[cursor.position] !== ' ') return null;
    cursor.position++;
  }
  const monthText = text.slice(cursor.position, cursor.position + 3).toLowerCase();
  const month = MONTH_LOOKUP[monthText];
  if (month === undefined) return null;
  cursor.position += 3;
  if (cursor.position >= text.length || text[cursor.position++] !== ' ') return null;
  if (text[cursor.position] === ' ') cursor.position++;
  const day = parseInteger(cursor);
  if (day < 1 || day > 31) return null;
  if (cursor.position >= text.length || text[cursor.position++] !== ' ') return null;
  let hour = parseInteger(cursor);
  if (year === 0 && hour > 1970 && hour < 2100) {
    year = hour;
    if (cursor.position >= text.length || text[cursor.position++] !== ' ') return null;
    hour = parseInteger(cursor);
  }
  if (hour < 0 || hour > 23) return null;
  if (cursor.position >= text.length || text[cursor.position++] !== ':') return null;
  const minute = parseInteger(cursor);
  if (minute < 0 || minute > 59) return null;
  if (cursor.position >= text.length || text[cursor.position++] !== ':') return null;
  const second = parseInteger(cursor);
  if (second < 0 || second > 60) return null;

  let secfrac = 0;
  let secfracPrecision = 0;
  if (cursor.position < text.length && text[cursor.position] === '.') {
    cursor.position++;
    const start = cursor.position;
    secfrac = parseInteger(cursor);
    secfracPrecision = cursor.position - start;
  }

  let offsetMode: OffsetMode = base.offsetMode;
  let offsetHour = base.offsetHour;
  let offsetMinute = base.offsetMinute;
  if (options.parseTimeZone === true && text.length - cursor.position > 2 && text[cursor.position] === ' ') {
    cursor.position++;
    const start = cursor.position;
    while (cursor.position < text.length && cursor.position - start < 15 && text[cursor.position] !== ':' && text[cursor.position] !== ' ') cursor.position++;
    const zone = options.timeZoneNames?.get(text.slice(start, cursor.position));
    if (zone !== undefined) {
      offsetMode = zone.mode;
      offsetHour = zone.hour;
      offsetMinute = zone.minute;
    }
  }
  if (options.detectYearAfterTimestamp === true && year === 0 && text.length - cursor.position > 5 && text[cursor.position] === ' ') {
    let candidate = 0;
    for (let index = 1; index < 5; index++) {
      const digit = text[cursor.position + index];
      if (digit === undefined || digit < '0' || digit > '9') break;
      candidate = 10 * candidate + (digit.charCodeAt(0) - 48);
    }
    if (text.length - cursor.position > 6 && text[cursor.position + 5] !== ' ') candidate = 0;
    if (candidate >= 2000 && candidate < 2100) {
      year = candidate;
      cursor.position += 5;
    }
  }
  if (cursor.position < text.length && text[cursor.position] === ':') cursor.position++;
  if (cursor.position < text.length) {
    if (text[cursor.position] !== ' ') return null;
    cursor.position++;
  }
  return {
    time: {
      timeType: TIME_TYPE_RFC3164,
      year: year > 0 ? year : base.year,
      month, day, hour, minute, second, secfrac, secfracPrecision, offsetMode, offsetHour, offsetMinute,
    },
    consumed: cursor.position,
  };
}
