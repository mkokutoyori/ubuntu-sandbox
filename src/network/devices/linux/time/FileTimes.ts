import { TimeZone } from '../../../core/time/TimeZone';
import { utcMsForLocal } from '../../../core/time/TimeZoneRegistry';
import { parseGnuDate } from '../../../core/time/GnuDateInput';
import { formatLocalTime } from '../system/SystemInfo';

const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;

export type LsTimeStyle = 'full-iso' | 'long-iso' | 'iso' | 'locale' | { readonly format: string };

export function parseLsTimeStyle(raw: string): LsTimeStyle | null {
  if (raw.startsWith('+')) return { format: raw.slice(1) };
  if (raw === 'full-iso' || raw === 'long-iso' || raw === 'iso' || raw === 'locale') return raw;
  return null;
}

export function formatLsTime(
  style: LsTimeStyle | null, atMs: number, zone: string | undefined, nowMs: number,
): string {
  const recent = nowMs - atMs < SIX_MONTHS_MS && atMs - nowMs < SIX_MONTHS_MS;
  if (style === null || style === 'locale') {
    return formatLocalTime(recent ? '%b %e %H:%M' : '%b %e  %Y', atMs, zone);
  }
  if (style === 'full-iso') return formatLocalTime('%Y-%m-%d %H:%M:%S.%N %z', atMs, zone);
  if (style === 'long-iso') return formatLocalTime('%Y-%m-%d %H:%M', atMs, zone);
  if (style === 'iso') return formatLocalTime(recent ? '%m-%d %H:%M' : '%Y-%m-%d', atMs, zone);
  return formatLocalTime(style.format, atMs, zone);
}

export function formatStatTime(atMs: number, zone: string | undefined): string {
  return formatLocalTime('%Y-%m-%d %H:%M:%S.%N %z', atMs, zone);
}

const TOUCH_STAMP = /^(?:(\d{2})?(\d{2}))?(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{2}))?$/;

export function parseTouchStamp(token: string, zone: string | undefined, nowMs: number): number | null {
  const match = TOUCH_STAMP.exec(token);
  if (match === null) return null;
  const fuseau = zone === undefined ? null : TimeZone.parse(zone);
  const currentYear = new Date(nowMs).getUTCFullYear();
  let year = currentYear;
  if (match[2] !== undefined) {
    const yy = Number(match[2]);
    year = match[1] !== undefined ? Number(match[1]) * 100 + yy : (yy < 69 ? 2000 + yy : 1900 + yy);
  }
  const month = Number(match[3]);
  const day = Number(match[4]);
  const hour = Number(match[5]);
  const minute = Number(match[6]);
  const second = match[7] === undefined ? 0 : Number(match[7]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 61) return null;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  return fuseau === null ? wall : utcMsForLocal(fuseau, wall);
}

export function parseTouchDate(spec: string, zone: string | undefined, nowMs: number): number | null {
  const fuseau = zone === undefined ? null : TimeZone.parse(zone);
  return parseGnuDate(spec, { nowMs, zone: fuseau });
}
