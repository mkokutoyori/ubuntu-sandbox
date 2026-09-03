export interface TimeRangeStamp {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export interface TimeRangeAbsolute {
  start?: TimeRangeStamp;
  end?: TimeRangeStamp;
}

export interface TimeRangePeriodic {
  days: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

export interface TimeRange {
  name: string;
  absolute?: TimeRangeAbsolute;
  periodic: TimeRangePeriodic[];
}

export interface TimeRangeDay {
  readonly keyword: string;
  readonly description: string;
  readonly weekdays: ReadonlySet<number>;
}

export const TIME_RANGE_DAYS: readonly TimeRangeDay[] = Object.freeze([
  { keyword: 'Monday',    description: 'Monday',    weekdays: new Set([1]) },
  { keyword: 'Tuesday',   description: 'Tuesday',   weekdays: new Set([2]) },
  { keyword: 'Wednesday', description: 'Wednesday', weekdays: new Set([3]) },
  { keyword: 'Thursday',  description: 'Thursday',  weekdays: new Set([4]) },
  { keyword: 'Friday',    description: 'Friday',    weekdays: new Set([5]) },
  { keyword: 'Saturday',  description: 'Saturday',  weekdays: new Set([6]) },
  { keyword: 'Sunday',    description: 'Sunday',    weekdays: new Set([0]) },
  { keyword: 'daily',     description: 'Every day of the week', weekdays: new Set([0, 1, 2, 3, 4, 5, 6]) },
  { keyword: 'weekdays',  description: 'Monday through Friday', weekdays: new Set([1, 2, 3, 4, 5]) },
  { keyword: 'weekend',   description: 'Saturday and Sunday',   weekdays: new Set([0, 6]) },
]);

const DAY_BY_KEYWORD = new Map(TIME_RANGE_DAYS.map((d) => [d.keyword.toLowerCase(), d]));

export function timeRangeDayKeyword(word: string): string | null {
  return DAY_BY_KEYWORD.get(word.toLowerCase())?.keyword ?? null;
}

export function timeRangeDaySet(days: string): ReadonlySet<number> | null {
  const words = days.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  const union = new Set<number>();
  for (const word of words) {
    const day = DAY_BY_KEYWORD.get(word.toLowerCase());
    if (!day) return null;
    for (const weekday of day.weekdays) union.add(weekday);
  }
  return union;
}

export function isTimeRangeActive(tr: TimeRange, now: Date): boolean {
  if (tr.absolute) {
    const ts = now.getTime();
    if (tr.absolute.start && ts < stampToMs(tr.absolute.start)) return false;
    if (tr.absolute.end && ts > stampToMs(tr.absolute.end)) return false;
  }
  if (tr.periodic.length === 0) return true;

  const weekday = now.getDay();
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  for (const p of tr.periodic) {
    const set = timeRangeDaySet(p.days);
    if (!set || !set.has(weekday)) continue;

    const start = p.startHour * 60 + p.startMinute;
    const end = p.endHour * 60 + p.endMinute;
    if (minuteOfDay >= start && minuteOfDay <= end) return true;
  }
  return false;
}

function stampToMs(stamp: TimeRangeStamp): number {
  return Date.UTC(stamp.year, stamp.month - 1, stamp.day, stamp.hour, stamp.minute);
}

export interface TimeOfDay {
  hour: number;
  minute: number;
}

export function parseTimeOfDay(token: string | undefined): TimeOfDay | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(token ?? '');
  if (!m) return null;

  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function formatTimeOfDay(hour: number, minute: number): string {
  return `${hour}:${minute < 10 ? '0' : ''}${minute}`;
}

export const TIME_RANGE_MONTHS: readonly string[] = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);

export function monthName(month: number): string {
  return TIME_RANGE_MONTHS[month - 1] ?? '';
}

export function parseMonthName(word: string | undefined): number | null {
  const wanted = (word ?? '').toLowerCase();
  if (wanted.length < 3) return null;

  const index = TIME_RANGE_MONTHS.findIndex((m) => m.toLowerCase().startsWith(wanted));
  return index < 0 ? null : index + 1;
}

export const TIME_RANGE_YEAR_MIN = 1993;
export const TIME_RANGE_YEAR_MAX = 2035;

interface StampParse {
  stamp: TimeRangeStamp | null;
  at: number;
}

function parseStamp(words: readonly string[]): StampParse {
  const time = parseTimeOfDay(words[0]);
  if (!time) return { stamp: null, at: 0 };

  if (!/^\d{1,2}$/.test(words[1] ?? '')) return { stamp: null, at: 1 };
  const day = Number(words[1]);
  if (day < 1 || day > 31) return { stamp: null, at: 1 };

  const month = parseMonthName(words[2]);
  if (month === null) return { stamp: null, at: 2 };

  if (!/^\d{4}$/.test(words[3] ?? '')) return { stamp: null, at: 3 };
  const year = Number(words[3]);
  if (year < TIME_RANGE_YEAR_MIN || year > TIME_RANGE_YEAR_MAX) return { stamp: null, at: 3 };

  return { stamp: { year, month, day, hour: time.hour, minute: time.minute }, at: -1 };
}

export interface PeriodicParse {
  clause: TimeRangePeriodic | null;
  at: number;
}

export interface AbsoluteParse {
  clause: TimeRangeAbsolute | null;
  at: number;
}

export function parsePeriodicClause(args: readonly string[]): PeriodicParse {
  const days: string[] = [];
  let i = 0;
  while (i < args.length && parseTimeOfDay(args[i]) === null) {
    const keyword = timeRangeDayKeyword(args[i]);
    if (keyword === null) return { clause: null, at: i };
    days.push(keyword);
    i++;
  }
  if (days.length === 0) return { clause: null, at: 0 };

  const start = parseTimeOfDay(args[i]);
  if (!start) return { clause: null, at: i };
  if (args[i + 1]?.toLowerCase() !== 'to') return { clause: null, at: i + 1 };

  const end = parseTimeOfDay(args[i + 2]);
  if (!end) return { clause: null, at: i + 2 };
  if (args.length > i + 3) return { clause: null, at: i + 3 };

  return {
    at: -1,
    clause: {
      days: days.join(' '),
      startHour: start.hour, startMinute: start.minute,
      endHour: end.hour, endMinute: end.minute,
    },
  };
}

export function parseAbsoluteClause(args: readonly string[]): AbsoluteParse {
  const absolute: TimeRangeAbsolute = {};
  let i = 0;
  while (i < args.length) {
    const which = args[i]?.toLowerCase();
    if (which !== 'start' && which !== 'end') return { clause: null, at: i };
    if (absolute[which] !== undefined) return { clause: null, at: i };

    const parsed = parseStamp(args.slice(i + 1, i + 5));
    if (!parsed.stamp) return { clause: null, at: i + 1 + parsed.at };

    absolute[which] = parsed.stamp;
    i += 5;
  }
  if (!absolute.start && !absolute.end) return { clause: null, at: 0 };
  return { clause: absolute, at: -1 };
}

export function samePeriodic(a: TimeRangePeriodic, b: TimeRangePeriodic): boolean {
  return a.days === b.days
    && a.startHour === b.startHour && a.startMinute === b.startMinute
    && a.endHour === b.endHour && a.endMinute === b.endMinute;
}

export function periodicLine(p: TimeRangePeriodic): string {
  return `periodic ${p.days} ${formatTimeOfDay(p.startHour, p.startMinute)}`
    + ` to ${formatTimeOfDay(p.endHour, p.endMinute)}`;
}

function stampText(stamp: TimeRangeStamp): string {
  return `${formatTimeOfDay(stamp.hour, stamp.minute)} ${stamp.day}`
    + ` ${monthName(stamp.month)} ${stamp.year}`;
}

export function absoluteLine(absolute: TimeRangeAbsolute): string | null {
  const parts: string[] = [];
  if (absolute.start) parts.push(`start ${stampText(absolute.start)}`);
  if (absolute.end) parts.push(`end ${stampText(absolute.end)}`);
  return parts.length > 0 ? `absolute ${parts.join(' ')}` : null;
}

export function timeRangeBodyLines(tr: TimeRange): string[] {
  const lines: string[] = [];
  const absolute = tr.absolute ? absoluteLine(tr.absolute) : null;
  if (absolute) lines.push(absolute);
  for (const p of tr.periodic) lines.push(periodicLine(p));
  return lines;
}
