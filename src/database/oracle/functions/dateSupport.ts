import { simulationNowMs } from '@/network/core/SystemClock';
import type { TimeZone } from '@/network/core/time/TimeZone';
import { offsetMinutesAt, utcMsForLocal } from '@/network/core/time/TimeZoneRegistry';

const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const MONTH_ABBREVIATIONS = MONTH_NAMES.map(m => m.slice(0, 3));
const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const DAY_ABBREVIATIONS = DAY_NAMES.map(d => d.slice(0, 3));

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/**
 * RR century-rollover (Oracle's real default-year token, distinct from YY):
 * a 2-digit value 0-49 rolls forward a century if the current year's own
 * last 2 digits are 50-99, and a value 50-99 rolls back a century if the
 * current year's are 0-49 — otherwise both stay in the current century.
 */
function resolveRRYear(twoDigit: number): number {
  const currentYear = new Date(simulationNowMs()).getUTCFullYear();
  const century = Math.floor(currentYear / 100) * 100;
  const currentYY = currentYear % 100;
  if (twoDigit <= 49) {
    return currentYY <= 49 ? century + twoDigit : century + 100 + twoDigit;
  }
  return currentYY <= 49 ? century - 100 + twoDigit : century + twoDigit;
}

const WALL_TEXT = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)?$/;
const INSTANT_TEXT = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*(Z|[+-]\d{2}:\d{2})$/;

export class WallDate extends Date {}

function wallOfInstant(instantMs: number, offsetMinutes: number): WallDate {
  return new WallDate(instantMs + offsetMinutes * 60_000);
}

export function coerceDateValue(value: unknown, zone: TimeZone | null = null): WallDate | null {
  if (value instanceof WallDate) return new WallDate(value.getTime());
  if (value instanceof Date) return wallOfInstant(value.getTime(), zone === null ? 0 : offsetMinutesAt(zone, value.getTime()));
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (WALL_TEXT.test(text)) {
    const ms = Date.parse(`${text.replace(' ', 'T')}${text.length === 10 ? 'T00:00:00' : ''}Z`);
    return Number.isNaN(ms) ? null : new WallDate(ms);
  }
  const instant = INSTANT_TEXT.exec(text);
  if (instant === null) return null;
  const designator = instant[2];
  const ms = Date.parse(`${instant[1].replace(' ', 'T')}${designator}`);
  if (Number.isNaN(ms)) return null;
  if (designator === 'Z') return wallOfInstant(ms, zone === null ? 0 : offsetMinutesAt(zone, ms));
  const sign = designator.startsWith('-') ? -1 : 1;
  return wallOfInstant(ms, sign * (Number(designator.slice(1, 3)) * 60 + Number(designator.slice(4, 6))));
}

export function isInstantText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && INSTANT_TEXT.test(value.trim());
}

export function wallLiteralText(text: string): string {
  const trimmed = text.trim();
  if (!WALL_TEXT.test(trimmed)) return text;
  return trimmed.length === 10 ? `${trimmed} 00:00:00` : trimmed;
}

export function instantMsOf(value: unknown, zone: TimeZone | null): number | null {
  if (value instanceof WallDate) return zone === null ? value.getTime() : utcMsForLocal(zone, value.getTime());
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (WALL_TEXT.test(text)) {
    const wall = coerceDateValue(text);
    if (wall === null) return null;
    return zone === null ? wall.getTime() : utcMsForLocal(zone, wall.getTime());
  }
  const instant = INSTANT_TEXT.exec(text);
  if (instant === null) return null;
  const ms = Date.parse(`${instant[1].replace(' ', 'T')}${instant[2]}`);
  return Number.isNaN(ms) ? null : ms;
}

export function formatDateValue(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function formatDateWithPattern(d: Date, fmt: string): string {
  let result = fmt;
  result = result.replace(/YYYY/g, String(d.getUTCFullYear()));
  result = result.replace(/YY|RR/g, String(d.getUTCFullYear()).slice(-2));
  result = result.replace(/MONTH/g, MONTH_NAMES[d.getUTCMonth()]);
  result = result.replace(/MON/g, MONTH_ABBREVIATIONS[d.getUTCMonth()]);
  result = result.replace(/MM/g, pad(d.getUTCMonth() + 1));
  result = result.replace(/DD/g, pad(d.getUTCDate()));
  result = result.replace(/DAY/g, DAY_NAMES[d.getUTCDay()]);
  result = result.replace(/DY/g, DAY_ABBREVIATIONS[d.getUTCDay()]);
  result = result.replace(/HH24/g, pad(d.getUTCHours()));
  result = result.replace(/HH/g, pad(d.getUTCHours() % 12 || 12));
  result = result.replace(/MI/g, pad(d.getUTCMinutes()));
  result = result.replace(/SS/g, pad(d.getUTCSeconds()));
  return result;
}

export function parseDateWithPattern(dateStr: string, fmt: string): string {
  const wall = coerceDateValue(dateStr);
  if (wall !== null) return formatDateValue(wall);
  let year = 2000, month = 1, day = 1, hour = 0, min = 0, sec = 0;
  const parts = dateStr.split(/[\s/\-:.,]+/);
  const fmtParts = fmt.toUpperCase().split(/[\s/\-:.,]+/);
  for (let i = 0; i < fmtParts.length && i < parts.length; i++) {
    const v = parseInt(parts[i], 10);
    if (isNaN(v) && fmtParts[i] === 'MON') {
      const idx = MONTH_ABBREVIATIONS.indexOf(parts[i].toUpperCase().slice(0, 3));
      if (idx >= 0) month = idx + 1;
      continue;
    }
    if (isNaN(v)) continue;
    switch (fmtParts[i]) {
      case 'YYYY': year = v; break;
      case 'YY': year = 2000 + v; break;
      case 'RR': year = resolveRRYear(v); break;
      case 'MM': month = v; break;
      case 'DD': day = v; break;
      case 'HH24': case 'HH': hour = v; break;
      case 'MI': min = v; break;
      case 'SS': sec = v; break;
    }
  }
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(min)}:${pad(sec)}`;
}
