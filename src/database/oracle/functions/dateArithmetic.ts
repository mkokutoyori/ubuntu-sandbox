import { OracleError } from '../../engine/types/DatabaseError';
import { utcMsForLocal } from '@/network/core/time/TimeZoneRegistry';
import {
  formatOracleOffset, oracleOffsetMinutes, parseOracleTimeZone, type OracleTimeZoneSpec,
} from '../time/OracleTimeZone';

const MS_PER_DAY = 86_400_000;

const DAY_NUMBERS: Readonly<Record<string, number>> = {
  SUNDAY: 0, SUN: 0, MONDAY: 1, MON: 1, TUESDAY: 2, TUE: 2,
  WEDNESDAY: 3, WED: 3, THURSDAY: 4, THU: 4, FRIDAY: 5, FRI: 5,
  SATURDAY: 6, SAT: 6,
};

const NEW_TIME_OFFSETS_MINUTES: Readonly<Record<string, number>> = {
  AST: -240, ADT: -180, BST: -660, BDT: -600, CST: -360, CDT: -300,
  EST: -300, EDT: -240, GMT: 0, HST: -600, HDT: -540, MST: -420,
  MDT: -360, NST: -210, PST: -480, PDT: -420, YST: -540, YDT: -480,
};

function wall(y: number, m: number, d: number, h = 0, mi = 0, s = 0, ms = 0): Date {
  return new Date(Date.UTC(y, m, d, h, mi, s, ms));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function isLastDayOfMonth(d: Date): boolean {
  return d.getUTCDate() === daysInMonth(d.getUTCFullYear(), d.getUTCMonth());
}

function secondsOfDay(d: Date): number {
  return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
}

export function truncateDate(d: Date, unitArg: string | null): Date {
  const unit = unitArg === null ? 'DD' : unitArg.toUpperCase();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const dow = d.getUTCDay();
  switch (unit) {
    case 'YYYY': case 'YEAR': case 'YY': case 'Y':
      return wall(y, 0, 1);
    case 'Q':
      return wall(y, Math.floor(m / 3) * 3, 1);
    case 'MM': case 'MONTH': case 'MON':
      return wall(y, m, 1);
    case 'DAY': case 'D': case 'DY':
      return wall(y, m, day - dow);
    case 'IW':
      return wall(y, m, day - ((dow + 6) % 7));
    case 'W':
      return wall(y, m, day - ((day - 1) % 7));
    case 'WW': {
      const daysSinceJanFirst = Math.floor((d.getTime() - wall(y, 0, 1).getTime()) / MS_PER_DAY);
      return wall(y, m, day - (daysSinceJanFirst % 7));
    }
    case 'HH': case 'HH12': case 'HH24':
      return wall(y, m, day, d.getUTCHours());
    case 'MI':
      return wall(y, m, day, d.getUTCHours(), d.getUTCMinutes());
    default:
      return wall(y, m, day);
  }
}

export function addMonths(d: Date, months: number): Date {
  const whole = Math.trunc(months);
  const target = d.getUTCMonth() + whole;
  const year = d.getUTCFullYear() + Math.floor(target / 12);
  const month = ((target % 12) + 12) % 12;
  const last = daysInMonth(year, month);
  const day = isLastDayOfMonth(d) ? last : Math.min(d.getUTCDate(), last);
  return wall(year, month, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

export function monthsBetween(a: Date, b: Date): number {
  const months = (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth());
  if (a.getUTCDate() === b.getUTCDate() || (isLastDayOfMonth(a) && isLastDayOfMonth(b))) return months;
  const days = a.getUTCDate() - b.getUTCDate();
  return months + (days + (secondsOfDay(a) - secondsOfDay(b)) / 86_400) / 31;
}

export function nextDay(d: Date, dayName: string): Date | null {
  const target = DAY_NUMBERS[dayName.toUpperCase().trim()];
  if (target === undefined) return null;
  const delta = ((target - d.getUTCDay() + 7) % 7) || 7;
  return new Date(d.getTime() + delta * MS_PER_DAY);
}

export function lastDay(d: Date): Date {
  return wall(d.getUTCFullYear(), d.getUTCMonth(), daysInMonth(d.getUTCFullYear(), d.getUTCMonth()),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

export function extractField(d: Date, fieldArg: string): number | null {
  switch (fieldArg.toUpperCase()) {
    case 'YEAR': return d.getUTCFullYear();
    case 'MONTH': return d.getUTCMonth() + 1;
    case 'DAY': return d.getUTCDate();
    case 'HOUR': return d.getUTCHours();
    case 'MINUTE': return d.getUTCMinutes();
    case 'SECOND': return d.getUTCSeconds();
    default: return null;
  }
}

export function newTime(d: Date, fromZone: string, toZone: string): Date {
  const from = NEW_TIME_OFFSETS_MINUTES[fromZone.toUpperCase().trim()];
  const to = NEW_TIME_OFFSETS_MINUTES[toZone.toUpperCase().trim()];
  if (from === undefined || to === undefined) {
    throw new OracleError(1857, 'not a valid time zone');
  }
  return new Date(d.getTime() + (to - from) * 60_000);
}

const TIMESTAMP_TEXT = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(\.\d+)?$/;

function offsetAtWall(spec: OracleTimeZoneSpec, wallMs: number): number {
  if (spec.kind === 'offset') return spec.minutes;
  return oracleOffsetMinutes(spec, utcMsForLocal(spec.zone, wallMs));
}

export function attachTimeZone(wallText: string, zoneText: string): string {
  const spec = parseOracleTimeZone(zoneText);
  if (spec === null) throw new OracleError(1882, 'timezone region not found');
  const match = TIMESTAMP_TEXT.exec(wallText.trim().replace('T', ' '));
  if (match === null) throw new OracleError(1830, 'date format picture ends before converting entire input string');
  const wallMs = Date.parse(`${match[1].replace(' ', 'T')}Z`);
  return `${match[1]}${match[2] ?? '.000'} ${formatOracleOffset(offsetAtWall(spec, wallMs))}`;
}

export function extractUtc(zonedText: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(\.\d+)?\s*([+-])(\d{2}):(\d{2})$/.exec(zonedText.trim());
  if (match === null) return null;
  const offset = (match[3] === '-' ? -1 : 1) * (Number(match[4]) * 60 + Number(match[5]));
  const utc = new Date(Date.parse(`${match[1].replace(' ', 'T')}Z`) - offset * 60_000);
  return `${utc.toISOString().slice(0, 19).replace('T', ' ')}${match[2] ?? '.000'}`;
}
