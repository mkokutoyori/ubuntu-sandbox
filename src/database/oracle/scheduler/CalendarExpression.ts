import type { TimeZone } from '@/network/core/time/TimeZone';
import { partsAt, utcMsForLocal } from '@/network/core/time/TimeZoneRegistry';

export type CalendarFrequency =
  'YEARLY' | 'MONTHLY' | 'WEEKLY' | 'DAILY' | 'HOURLY' | 'MINUTELY' | 'SECONDLY';

export interface WeekdayRule {
  readonly weekday: number;
  readonly ordinal: number | null;
}

export interface CalendarExpression {
  readonly frequency: CalendarFrequency;
  readonly interval: number;
  readonly months: readonly number[];
  readonly monthDays: readonly number[];
  readonly weekdays: readonly WeekdayRule[];
  readonly hours: readonly number[];
  readonly minutes: readonly number[];
  readonly seconds: readonly number[];
}

const FREQUENCIES: readonly string[] = ['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY', 'MINUTELY', 'SECONDLY'];
const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const UNIT_MS: Readonly<Record<'HOURLY' | 'MINUTELY' | 'SECONDLY', number>> = {
  HOURLY: 3_600_000, MINUTELY: 60_000, SECONDLY: 1_000,
};
const MS_PER_DAY = 86_400_000;
const SEARCH_DAYS = 366 * 8;
const SEARCH_STEPS = 200_000;

function numberList(raw: string): number[] | null {
  const values = raw.split(',').map(token => Number(token.trim()));
  return values.every(Number.isInteger) ? values : null;
}

function monthList(raw: string): number[] | null {
  const values = raw.split(',').map((token) => {
    const trimmed = token.trim().toUpperCase();
    const named = MONTH_NAMES.indexOf(trimmed.slice(0, 3));
    return /^[A-Z]+$/.test(trimmed) ? (named >= 0 ? named + 1 : Number.NaN) : Number(trimmed);
  });
  return values.every(value => Number.isInteger(value) && value >= 1 && value <= 12) ? values : null;
}

function weekdayList(raw: string): WeekdayRule[] | null {
  const rules: WeekdayRule[] = [];
  for (const token of raw.split(',')) {
    const match = /^\s*(-?\d+)?\s*([A-Za-z]{3})\s*$/.exec(token);
    if (match === null) return null;
    const weekday = WEEKDAY_NAMES.indexOf(match[2].toUpperCase());
    if (weekday < 0) return null;
    rules.push({ weekday, ordinal: match[1] === undefined ? null : Number(match[1]) });
  }
  return rules;
}

export function parseCalendarExpression(text: string): CalendarExpression | null {
  const fields = new Map<string, string>();
  for (const clause of text.split(';')) {
    if (clause.trim().length === 0) continue;
    const pair = /^\s*([A-Za-z]+)\s*=\s*(.+?)\s*$/.exec(clause);
    if (pair === null) return null;
    fields.set(pair[1].toUpperCase(), pair[2]);
  }
  const frequency = fields.get('FREQ')?.toUpperCase();
  if (frequency === undefined || !FREQUENCIES.includes(frequency)) return null;
  const known = new Set(['FREQ', 'INTERVAL', 'BYMONTH', 'BYMONTHDAY', 'BYDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND']);
  for (const key of fields.keys()) if (!known.has(key)) return null;

  const interval = fields.has('INTERVAL') ? Number(fields.get('INTERVAL')) : 1;
  if (!Number.isInteger(interval) || interval < 1) return null;

  const months = fields.has('BYMONTH') ? monthList(fields.get('BYMONTH')!) : [];
  const monthDays = fields.has('BYMONTHDAY') ? numberList(fields.get('BYMONTHDAY')!) : [];
  const weekdays = fields.has('BYDAY') ? weekdayList(fields.get('BYDAY')!) : [];
  const hours = fields.has('BYHOUR') ? numberList(fields.get('BYHOUR')!) : [];
  const minutes = fields.has('BYMINUTE') ? numberList(fields.get('BYMINUTE')!) : [];
  const seconds = fields.has('BYSECOND') ? numberList(fields.get('BYSECOND')!) : [];
  if (months === null || monthDays === null || weekdays === null || hours === null || minutes === null || seconds === null) return null;
  if (hours.some(h => h < 0 || h > 23) || minutes.some(m => m < 0 || m > 59) || seconds.some(s => s < 0 || s > 59)) return null;
  if (monthDays.some(d => d === 0 || d < -31 || d > 31)) return null;
  return { frequency: frequency as CalendarFrequency, interval, months, monthDays, weekdays, hours, minutes, seconds };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function matchesWeekday(rule: WeekdayRule, year: number, month: number, day: number, weekday: number): boolean {
  if (rule.weekday !== weekday) return false;
  if (rule.ordinal === null) return true;
  if (rule.ordinal > 0) return Math.ceil(day / 7) === rule.ordinal;
  return Math.ceil((daysInMonth(year, month) - day + 1) / 7) === -rule.ordinal;
}

function epochDay(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

function dayEligible(
  expression: CalendarExpression,
  reference: { year: number; month: number; day: number; weekday: number },
  year: number, month: number, day: number, weekday: number,
): boolean {
  const { frequency, interval, months, monthDays, weekdays } = expression;
  const dayNumber = epochDay(year, month, day);
  const referenceDay = epochDay(reference.year, reference.month, reference.day);
  if (frequency === 'DAILY' && (dayNumber - referenceDay) % interval !== 0) return false;
  if (frequency === 'WEEKLY') {
    const weekStart = (n: number, w: number): number => n - ((w + 6) % 7);
    const weeks = (weekStart(dayNumber, weekday) - weekStart(referenceDay, reference.weekday)) / 7;
    if (weeks % interval !== 0) return false;
  }
  if (frequency === 'MONTHLY' && ((year - reference.year) * 12 + month - reference.month) % interval !== 0) return false;
  if (frequency === 'YEARLY' && (year - reference.year) % interval !== 0) return false;

  const effectiveMonths = months.length > 0 ? months : frequency === 'YEARLY' ? [reference.month] : [];
  if (effectiveMonths.length > 0 && !effectiveMonths.includes(month)) return false;

  const last = daysInMonth(year, month);
  const dayMatches = (days: readonly number[]): boolean =>
    days.some(d => (d > 0 ? d === day : last + d + 1 === day));
  if (monthDays.length > 0 && !dayMatches(monthDays)) return false;
  if (weekdays.length > 0 && !weekdays.some(rule => matchesWeekday(rule, year, month, day, weekday))) return false;
  if (monthDays.length === 0 && weekdays.length === 0) {
    if (frequency === 'WEEKLY') return weekday === reference.weekday;
    if (frequency === 'MONTHLY' || frequency === 'YEARLY') return day === reference.day;
  }
  return true;
}

export function nextOccurrenceAfter(
  expression: CalendarExpression,
  afterMs: number,
  referenceMs: number,
  zone: TimeZone,
): number | null {
  const reference = partsAt(zone, referenceMs);
  const unit = expression.frequency === 'HOURLY' || expression.frequency === 'MINUTELY' || expression.frequency === 'SECONDLY'
    ? UNIT_MS[expression.frequency] : null;

  if (unit !== null) {
    const step = unit * expression.interval;
    let candidate = referenceMs + Math.max(0, Math.floor((afterMs - referenceMs) / step)) * step;
    for (let i = 0; i < SEARCH_STEPS; i++, candidate += step) {
      if (candidate <= afterMs) continue;
      const parts = partsAt(zone, candidate);
      if (expression.hours.length > 0 && !expression.hours.includes(parts.hour)) continue;
      if (expression.minutes.length > 0 && !expression.minutes.includes(parts.minute)) continue;
      if (expression.seconds.length > 0 && !expression.seconds.includes(parts.second)) continue;
      if (expression.months.length > 0 && !expression.months.includes(parts.month)) continue;
      if (expression.weekdays.length > 0
        && !expression.weekdays.some(rule => matchesWeekday(rule, parts.year, parts.month, parts.day, parts.weekday))) continue;
      if (expression.monthDays.length > 0
        && !expression.monthDays.some(d => (d > 0 ? d === parts.day : daysInMonth(parts.year, parts.month) + d + 1 === parts.day))) continue;
      return candidate;
    }
    return null;
  }

  const hours = expression.hours.length > 0 ? [...expression.hours].sort((a, b) => a - b) : [reference.hour];
  const minutes = expression.minutes.length > 0 ? [...expression.minutes].sort((a, b) => a - b) : [reference.minute];
  const seconds = expression.seconds.length > 0 ? [...expression.seconds].sort((a, b) => a - b) : [reference.second];
  const start = partsAt(zone, afterMs);
  for (let offset = 0; offset < SEARCH_DAYS; offset++) {
    const dayMs = Date.UTC(start.year, start.month - 1, start.day + offset);
    const day = new Date(dayMs);
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth() + 1;
    const dayOfMonth = day.getUTCDate();
    const weekday = day.getUTCDay();
    if (!dayEligible(expression, reference, year, month, dayOfMonth, weekday)) continue;
    for (const hour of hours) for (const minute of minutes) for (const second of seconds) {
      const instant = utcMsForLocal(zone, Date.UTC(year, month - 1, dayOfMonth, hour, minute, second));
      if (instant > afterMs) return instant;
    }
  }
  return null;
}
