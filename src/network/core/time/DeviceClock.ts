import { partsAtOffset } from './TimeZoneRegistry';

export type SummerTimeKind = 'recurring' | 'date';

export interface DeviceClockReading {
  readonly localMs: number;
  readonly zoneName: string;
  readonly offsetMin: number;
  readonly inSummer: boolean;
}

export const DEFAULT_SUMMER_OFFSET_MIN = 60;

const US_DEFAULT_START = 'first Sun Apr 2:00';
const US_DEFAULT_END = 'last Sun Oct 2:00';

const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, last: 5,
};

function monthIndex(word: string): number {
  return MONTHS.indexOf(word.slice(0, 3).toLowerCase());
}

function weekdayIndex(word: string): number {
  return WEEKDAYS.indexOf(word.slice(0, 3).toLowerCase());
}

function ordinalOf(word: string): number {
  const lower = word.toLowerCase();
  if (ORDINALS[lower] !== undefined) return ORDINALS[lower];
  const numeric = Number.parseInt(word, 10);
  return Number.isInteger(numeric) ? numeric : 0;
}

function minutesOfDay(text: string): number {
  const [hours, minutes] = text.split(':').map((part) => Number.parseInt(part, 10));
  return hours * 60 + minutes;
}

function nthWeekdayOfMonth(
  year: number, month: number, weekday: number, ordinal: number,
): number {
  if (ordinal >= 5) {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const lastWeekday = new Date(Date.UTC(year, month, lastDay)).getUTCDay();
    return lastDay - ((lastWeekday - weekday + 7) % 7);
  }
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((weekday - firstWeekday + 7) % 7) + (ordinal - 1) * 7;
}

function recurringBoundMs(tokens: readonly string[], year: number): number | null {
  if (tokens.length !== 4) return null;
  const ordinal = ordinalOf(tokens[0]);
  const weekday = weekdayIndex(tokens[1]);
  const month = monthIndex(tokens[2]);
  if (ordinal < 1 || weekday < 0 || month < 0) return null;

  const day = nthWeekdayOfMonth(year, month, weekday, ordinal);
  return Date.UTC(year, month, day) + minutesOfDay(tokens[3]) * 60_000;
}

function datedBoundMs(tokens: readonly string[]): number | null {
  if (tokens.length !== 4) return null;
  const leadingMonth = monthIndex(tokens[0]);
  const month = leadingMonth >= 0 ? leadingMonth : monthIndex(tokens[1]);
  const day = Number.parseInt(leadingMonth >= 0 ? tokens[1] : tokens[0], 10);
  const year = Number.parseInt(tokens[2], 10);
  if (month < 0 || !Number.isInteger(day) || !Number.isInteger(year)) return null;

  return Date.UTC(year, month, day) + minutesOfDay(tokens[3]) * 60_000;
}

function boundMs(
  kind: SummerTimeKind, written: string, year: number, fallback: string,
): number | null {
  const tokens = (written.trim().length > 0 ? written : fallback).trim().split(/\s+/);
  return kind === 'date' ? datedBoundMs(tokens) : recurringBoundMs(tokens, year);
}

export interface SummerTimeSetting {
  readonly zoneName: string;
  readonly kind: SummerTimeKind;
  readonly start: string;
  readonly end: string;
  readonly offsetMin: number;
}

export interface DeviceClockConfig {
  readonly timezone: string;
  readonly offsetMin: number;
  readonly summerTimezone: string;
  readonly summerKind: SummerTimeKind;
  readonly daylightStart: string;
  readonly daylightEnd: string;
  readonly daylightOffsetMin: number;
}

export function summerTimeOf(config: DeviceClockConfig): SummerTimeSetting | null {
  if (config.summerTimezone.length === 0) return null;
  return {
    zoneName: config.summerTimezone,
    kind: config.summerKind,
    start: config.daylightStart,
    end: config.daylightEnd,
    offsetMin: config.daylightOffsetMin,
  };
}

function withinWindow(
  startMs: number, endMs: number, standardMs: number, summerMs: number,
): boolean {
  if (startMs <= endMs) return standardMs >= startMs && summerMs < endMs;
  return standardMs >= startMs || summerMs < endMs;
}

export function clockReadingAt(
  config: DeviceClockConfig, atMs: number,
): DeviceClockReading {
  const standardOffset = config.offsetMin;
  const standard: DeviceClockReading = {
    localMs: atMs + standardOffset * 60_000,
    zoneName: config.timezone,
    offsetMin: standardOffset,
    inSummer: false,
  };

  const summer = summerTimeOf(config);
  if (!summer) return standard;

  const year = partsAtOffset(standardOffset, atMs).year;
  const startMs = boundMs(summer.kind, summer.start, year, US_DEFAULT_START);
  const endMs = boundMs(summer.kind, summer.end, year, US_DEFAULT_END);
  if (startMs === null || endMs === null) return standard;

  const summerMs = standard.localMs + summer.offsetMin * 60_000;
  if (!withinWindow(startMs, endMs, standard.localMs, summerMs)) return standard;

  return {
    localMs: summerMs,
    zoneName: summer.zoneName,
    offsetMin: standardOffset + summer.offsetMin,
    inSummer: true,
  };
}

export class DeviceClockStore {
  private config: DeviceClockConfig = {
    timezone: 'UTC',
    offsetMin: 0,
    summerTimezone: '',
    summerKind: 'recurring',
    daylightStart: '',
    daylightEnd: '',
    daylightOffsetMin: DEFAULT_SUMMER_OFFSET_MIN,
  };

  get(): DeviceClockConfig { return this.config; }

  setStandard(timezone: string, offsetMin: number): void {
    this.config = { ...this.config, timezone, offsetMin };
  }

  clearStandard(): void {
    this.config = { ...this.config, timezone: 'UTC', offsetMin: 0 };
  }

  setSummer(setting: SummerTimeSetting): void {
    this.config = {
      ...this.config,
      summerTimezone: setting.zoneName,
      summerKind: setting.kind,
      daylightStart: setting.start,
      daylightEnd: setting.end,
      daylightOffsetMin: setting.offsetMin,
    };
  }

  clearSummer(): void {
    this.config = {
      ...this.config,
      summerTimezone: '',
      summerKind: 'recurring',
      daylightStart: '',
      daylightEnd: '',
      daylightOffsetMin: DEFAULT_SUMMER_OFFSET_MIN,
    };
  }

  readingAt(atMs: number): DeviceClockReading {
    return clockReadingAt(this.config, atMs);
  }
}

export function rfc5424Timestamp(localMs: number, offsetMin: number): string {
  const local = new Date(localMs);
  const pad = (value: number, width = 2): string =>
    String(value).padStart(width, '0');
  const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}`
    + `-${pad(local.getUTCDate())}`;
  const clock = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
    + `:${pad(local.getUTCSeconds())}.${pad(local.getUTCMilliseconds(), 3)}`;
  if (offsetMin === 0) return `${date}T${clock}Z`;

  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return `${date}T${clock}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
