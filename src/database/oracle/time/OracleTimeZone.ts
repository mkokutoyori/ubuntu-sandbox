import { TimeZone } from '@/network/core/time/TimeZone';
import { offsetMinutesAt } from '@/network/core/time/TimeZoneRegistry';

export type OracleTimeZoneSpec =
  | { readonly kind: 'region'; readonly zone: TimeZone }
  | { readonly kind: 'offset'; readonly minutes: number };

const OFFSET = /^([+-])(\d{1,2}):(\d{2})$/;

export const UTC_SPEC: OracleTimeZoneSpec = Object.freeze({ kind: 'offset', minutes: 0 });

export function parseOracleTimeZone(raw: string): OracleTimeZoneSpec | null {
  const value = raw.trim().replace(/^'|'$/g, '').trim();
  if (value.length === 0) return null;

  const offset = OFFSET.exec(value);
  if (offset) {
    const hours = Number.parseInt(offset[2], 10);
    const minutes = Number.parseInt(offset[3], 10);
    if (hours > 14 || minutes > 59) return null;
    const total = hours * 60 + minutes;
    return { kind: 'offset', minutes: offset[1] === '-' ? -total : total };
  }

  const zone = TimeZone.parse(value);
  return zone === null ? null : { kind: 'region', zone };
}

export function oracleZoneLabel(spec: OracleTimeZoneSpec): string {
  if (spec.kind === 'region') return spec.zone.name;
  return formatOracleOffset(spec.minutes);
}

export function formatOracleOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function oracleOffsetMinutes(spec: OracleTimeZoneSpec, atMs: number): number {
  return spec.kind === 'offset' ? spec.minutes : offsetMinutesAt(spec.zone, atMs);
}

function shifted(atMs: number, offsetMin: number): Date {
  return new Date(atMs + offsetMin * 60_000);
}

export function oracleDateText(atMs: number, offsetMin: number): string {
  return shifted(atMs, offsetMin).toISOString().slice(0, 19).replace('T', ' ');
}

export function oracleTimestampText(atMs: number, offsetMin: number): string {
  const stamp = shifted(atMs, offsetMin).toISOString().slice(0, 23).replace('T', ' ');
  return `${stamp} ${formatOracleOffset(offsetMin)}`;
}
