import { TimeZone } from './TimeZone';

export interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly weekday: number;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: TimeZone): Intl.DateTimeFormat {
  const known = formatters.get(zone.name);
  if (known) return known;

  const created = new Intl.DateTimeFormat('en-US', {
    timeZone: zone.name, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  formatters.set(zone.name, created);
  return created;
}

export function partsAt(zone: TimeZone, atMs: number): LocalParts {
  const parts = formatterFor(zone).formatToParts(new Date(atMs));
  const field = (type: string): string =>
    parts.find(part => part.type === type)?.value ?? '';
  const number = (type: string): number => Number.parseInt(field(type), 10) || 0;

  return Object.freeze({
    year: number('year'),
    month: number('month'),
    day: number('day'),
    hour: number('hour') % 24,
    minute: number('minute'),
    second: number('second'),
    weekday: WEEKDAYS[field('weekday')] ?? 0,
  });
}

export function offsetMinutesAt(zone: TimeZone, atMs: number): number {
  const local = partsAt(zone, atMs);
  const asUtc = Date.UTC(
    local.year, local.month - 1, local.day,
    local.hour, local.minute, local.second,
  );
  return Math.round((asUtc - Math.floor(atMs / 1000) * 1000) / 60_000);
}

export function localMsAt(zone: TimeZone, atMs: number): number {
  return atMs + offsetMinutesAt(zone, atMs) * 60_000;
}

export function utcMsForLocal(zone: TimeZone, localMs: number): number {
  const guess = localMs - offsetMinutesAt(zone, localMs) * 60_000;
  return localMs - offsetMinutesAt(zone, guess) * 60_000;
}

export function standardOffsetMinutes(zone: TimeZone, atMs: number): number {
  const year = partsAt(zone, atMs).year;
  return Math.min(
    offsetMinutesAt(zone, Date.UTC(year, 0, 1)),
    offsetMinutesAt(zone, Date.UTC(year, 6, 1)),
  );
}

export function isDaylightSavingAt(zone: TimeZone, atMs: number): boolean {
  return offsetMinutesAt(zone, atMs) > standardOffsetMinutes(zone, atMs);
}

export function observesDaylightSaving(zone: TimeZone, atMs: number): boolean {
  const year = partsAt(zone, atMs).year;
  return offsetMinutesAt(zone, Date.UTC(year, 0, 1))
    !== offsetMinutesAt(zone, Date.UTC(year, 6, 1));
}
