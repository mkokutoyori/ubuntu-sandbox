import { simulationNowMs } from '@/network/core/SystemClock';
import { TimeZone } from '@/network/core/time/TimeZone';
import { ZonedDate } from '@/network/core/time/ZonedDate';
import { parseGnuDate } from '@/network/core/time/GnuDateInput';
import { isDaylightSavingAt, observesDaylightSaving, offsetMinutesAt, standardOffsetMinutes, utcMsForLocal } from '@/network/core/time/TimeZoneRegistry';
import { WINDOWS_TIME_ZONES, windowsZoneNameAt } from '@/network/core/time/WindowsTimeZones';
import { PSRuntimeError } from './PSRuntime';
import type { PSProviders } from '@/powershell/providers/PSProviders';
import { makeTimeSpan } from '@/powershell/cmdlets/core/DateTimeCmdlets';
import { formatDotNetDate } from './dotnetDateFormat';
import { parseCimDateTime } from '@/network/devices/windows/WmiClasses';
import type { PSValue } from './PSEnvironment';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TICKS_PER_MS = 10_000;
const EPOCH_TICKS_OFFSET_MS = 62_135_596_800_000;

export function machineDate(providers: PSProviders): ZonedDate {
  const instant = providers.scheduledTasks?.now?.()?.getTime() ?? simulationNowMs();
  return ZonedDate.in(instant, providers.identity?.timezone);
}

export function machineZoneOf(providers: PSProviders): TimeZone | null {
  const name = providers.identity?.timezone;
  return name === undefined ? null : TimeZone.parse(name);
}

export function likeDate(model: Date, epochMs: number): Date {
  return model instanceof ZonedDate ? model.withInstant(epochMs) : new Date(epochMs);
}

function wallDate(d: Date, wall: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number; milli?: number }): Date {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour ?? 0, wall.minute ?? 0, wall.second ?? 0, wall.milli ?? 0);
  const zone = d instanceof ZonedDate ? d.zoneOrNull() : null;
  return likeDate(d, zone === null ? naive : utcMsForLocal(zone, naive));
}

function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getFullYear(), 0, 1);
  const today = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((today - start) / 86_400_000) + 1;
}

function wallTicks(d: Date): number {
  const wall = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), ((d.getTime() % 1000) + 1000) % 1000);
  return (wall + EPOCH_TICKS_OFFSET_MS) * TICKS_PER_MS;
}

function timeSpanMs(value: PSValue): number {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, PSValue>;
    return Number(record['TotalMilliseconds'] ?? 0);
  }
  return Number(value);
}

function shifted(d: Date, unit: 'year' | 'month' | 'day', amount: number): Date {
  const copy = likeDate(d, d.getTime());
  if (unit === 'day') copy.setDate(copy.getDate() + amount);
  else if (unit === 'month') copy.setMonth(copy.getMonth() + amount);
  else copy.setFullYear(copy.getFullYear() + amount);
  return copy;
}

export function dateMember(d: Date, member: string): PSValue {
  const add = (ms: number) => (n: PSValue) => likeDate(d, d.getTime() + Number(n) * ms) as unknown as PSValue;
  switch (member) {
    case 'year': return d.getFullYear();
    case 'month': return d.getMonth() + 1;
    case 'day': return d.getDate();
    case 'hour': return d.getHours();
    case 'minute': return d.getMinutes();
    case 'second': return d.getSeconds();
    case 'millisecond': return ((d.getTime() % 1000) + 1000) % 1000;
    case 'dayofweek': return DAY_NAMES[d.getDay()];
    case 'dayofyear': return dayOfYear(d);
    case 'ticks': return wallTicks(d);
    case 'kind': return d instanceof ZonedDate && d.zoneOrNull() === null ? 'Utc' : 'Local';
    case 'date': return wallDate(d, { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }) as unknown as PSValue;
    case 'timeofday': return makeTimeSpan(((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * 1000 + (((d.getTime() % 1000) + 1000) % 1000)) as unknown as PSValue;
    case 'tostring': return (fmt?: PSValue) =>
      fmt !== undefined && fmt !== null && String(fmt) !== ''
        ? formatDotNetDate(d, String(fmt))
        : formatDotNetDate(d, 'G');
    case 'tolongdatestring': return () => formatDotNetDate(d, 'D');
    case 'toshortdatestring': return () => formatDotNetDate(d, 'd');
    case 'tolongtimestring': return () => formatDotNetDate(d, 'T');
    case 'toshorttimestring': return () => formatDotNetDate(d, 't');
    case 'touniversaltime': return () => new ZonedDate(d.getTime(), null) as unknown as PSValue;
    case 'tolocaltime': return () => likeDate(d, d.getTime()) as unknown as PSValue;
    case 'isdaylightsavingtime': return () => {
      const zone = d instanceof ZonedDate ? d.zoneOrNull() : null;
      return zone !== null && isDaylightSavingAt(zone, d.getTime());
    };
    case 'adddays': return (n: PSValue) => shifted(d, 'day', Number(n)) as unknown as PSValue;
    case 'addmonths': return (n: PSValue) => shifted(d, 'month', Number(n)) as unknown as PSValue;
    case 'addyears': return (n: PSValue) => shifted(d, 'year', Number(n)) as unknown as PSValue;
    case 'addhours': return add(3_600_000);
    case 'addminutes': return add(60_000);
    case 'addseconds': return add(1000);
    case 'addmilliseconds': return add(1);
    case 'addticks': return add(1 / TICKS_PER_MS);
    case 'subtract': return (other: PSValue) => (other instanceof Date
      ? makeTimeSpan(d.getTime() - other.getTime())
      : likeDate(d, d.getTime() - timeSpanMs(other))) as unknown as PSValue;
    case 'compareto': return (other: PSValue) => Math.sign(d.getTime() - (other as Date).getTime());
    case 'equals': return (other: PSValue) => other instanceof Date && other.getTime() === d.getTime();
    case 'gettime': return () => d.getTime();
    default: return null;
  }
}

export function parseDateTime(text: string, providers: PSProviders): Date | null {
  const now = machineDate(providers);
  const instant = parseGnuDate(text, { nowMs: now.getTime(), zone: machineZoneOf(providers) });
  return instant === null ? null : now.withInstant(instant);
}

export function dateTimeStatics(providers: PSProviders): Record<string, PSValue> {
  const now = () => machineDate(providers);
  const zone = machineZoneOf(providers);
  const build = (n: number[]) => {
    const [year = 1, month = 1, day = 1, hour = 0, minute = 0, second = 0, milli = 0] = n;
    const naive = Date.UTC(year, month - 1, day, hour, minute, second, milli);
    return ZonedDate.in(zone === null ? naive : utcMsForLocal(zone, naive), providers.identity?.timezone);
  };
  return {
    get now() { return now() as unknown as PSValue; },
    get utcnow() { return new ZonedDate(now().getTime(), null) as unknown as PSValue; },
    get today() {
      const d = now();
      return wallDate(d, { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }) as unknown as PSValue;
    },
    new: (...a: PSValue[]) => build(a.map(Number)) as unknown as PSValue,
    parse: (s: PSValue) => parseDateTime(String(s), providers) as unknown as PSValue,
    parseexact: (s: PSValue) => parseDateTime(String(s), providers) as unknown as PSValue,
    tryparse: (s: PSValue) => parseDateTime(String(s), providers) as unknown as PSValue,
    daysinmonth: (y: PSValue, m: PSValue) => new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate(),
    isleapyear: (y: PSValue) => { const n = Number(y); return (n % 4 === 0 && n % 100 !== 0) || n % 400 === 0; },
    minvalue: new Date(-62_135_596_800_000) as unknown as PSValue,
    maxvalue: new Date(253_402_300_799_999) as unknown as PSValue,
  } as Record<string, PSValue>;
}

export function adoptMachineDates(value: PSValue, providers: PSProviders): PSValue {
  const zoneName = providers.identity?.timezone;
  const seen = new WeakSet<object>();
  const walk = (node: PSValue): PSValue => {
    if (node instanceof ZonedDate) return node;
    if (node instanceof Date) return ZonedDate.in(node.getTime(), zoneName) as unknown as PSValue;
    if (node === null || typeof node !== 'object' || typeof node === 'function') return node;
    if (seen.has(node)) return node;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = walk(node[i]);
      return node;
    }
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) return node;
    const record = node as Record<string, PSValue>;
    for (const key of Object.keys(record)) record[key] = walk(record[key]);
    return node;
  };
  return walk(value);
}

export function cimRowToObject(row: Record<string, string>, providers: PSProviders): Record<string, PSValue> {
  const zone = providers.identity?.timezone;
  const out: Record<string, PSValue> = {};
  for (const [key, value] of Object.entries(row)) {
    const instant = typeof value === 'string' ? parseCimDateTime(value) : null;
    out[key] = instant === null ? value : (ZonedDate.in(instant, zone) as unknown as PSValue);
  }
  return out;
}

function zoneInfoObject(entry: { id: string; iana: string; nom: string }, atMs: number): Record<string, PSValue> {
  const zone = TimeZone.parse(entry.iana);
  const standard = zone === null ? 0 : standardOffsetMinutes(zone, atMs);
  const signed = `${standard < 0 ? '-' : '+'}${String(Math.floor(Math.abs(standard) / 60)).padStart(2, '0')}:${String(Math.abs(standard) % 60).padStart(2, '0')}`;
  const observes = zone !== null && observesDaylightSaving(zone, atMs);
  return {
    Id: entry.id,
    DisplayName: `(UTC${signed}) ${entry.nom}`,
    StandardName: windowsZoneNameAt(entry.iana, Date.UTC(new Date(atMs).getUTCFullYear(), 0, 1)),
    DaylightName: observes ? windowsZoneNameAt(entry.iana, Date.UTC(new Date(atMs).getUTCFullYear(), 6, 1)) : entry.id,
    BaseUtcOffset: makeTimeSpan(standard * 60_000),
    SupportsDaylightSavingTime: observes,
    GetUtcOffset: (when: PSValue) => makeTimeSpan(zone === null ? 0 : offsetMinutesAt(zone, (when as Date).getTime()) * 60_000),
    IsDaylightSavingTime: (when: PSValue) => zone !== null && isDaylightSavingAt(zone, (when as Date).getTime()),
    IANA: entry.iana,
  } as Record<string, PSValue>;
}

export function timeZoneInfoStatics(providers: PSProviders): Record<string, PSValue> {
  const now = () => machineDate(providers).getTime();
  const current = (): Record<string, PSValue> => {
    const iana = providers.identity?.timezone ?? 'Etc/UTC';
    const entry = WINDOWS_TIME_ZONES.find((z) => z.iana === iana) ?? WINDOWS_TIME_ZONES[0];
    return zoneInfoObject(entry, now());
  };
  const byId = (id: string): Record<string, PSValue> | null => {
    const entry = WINDOWS_TIME_ZONES.find((z) => z.id.toLowerCase() === id.toLowerCase());
    return entry === undefined ? null : zoneInfoObject(entry, now());
  };
  const convert = (when: PSValue, target: PSValue, direction: 'fromUtc' | 'toUtc'): PSValue => {
    const date = when as Date;
    const iana = String((target as Record<string, PSValue>)['IANA'] ?? 'Etc/UTC');
    const zone = TimeZone.parse(iana);
    if (direction === 'fromUtc') return ZonedDate.in(date.getTime(), iana) as unknown as PSValue;
    const naive = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds());
    return new ZonedDate(zone === null ? naive : utcMsForLocal(zone, naive), null) as unknown as PSValue;
  };
  return {
    get local() { return current() as PSValue; },
    get utc() { return byId('UTC') as PSValue; },
    findsystemtimezonebyid: (id: PSValue) => {
      const found = byId(String(id));
      if (found === null) throw new PSRuntimeError(`Exception calling "FindSystemTimeZoneById" with "1" argument(s): "The time zone ID '${String(id)}' was not found on the local computer."`);
      return found as PSValue;
    },
    getsystemtimezones: () => WINDOWS_TIME_ZONES.map((z) => zoneInfoObject(z, now())) as PSValue,
    converttimefromutc: (when: PSValue, target: PSValue) => convert(when, target, 'fromUtc'),
    converttimetoutc: (when: PSValue, source: PSValue) => convert(when, source, 'toUtc'),
  } as Record<string, PSValue>;
}
