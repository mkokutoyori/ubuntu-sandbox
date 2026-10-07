import { simulationNowMs } from '@/network/core/SystemClock';
import { TimeZone } from '@/network/core/time/TimeZone';
import { offsetMinutesAt } from '@/network/core/time/TimeZoneRegistry';
import { formatOracleOffset, type OracleTimeZoneSpec } from './OracleTimeZone';

export interface OracleHostClock {
  nowMs(): number;
  zoneName(): string;
}

export const DEFAULT_HOST_CLOCK: OracleHostClock = {
  nowMs: () => simulationNowMs(),
  zoneName: () => 'UTC',
};

export function hostZoneOf(clock: OracleHostClock): TimeZone {
  return TimeZone.parse(clock.zoneName()) ?? TimeZone.UTC;
}

export function hostOffsetSpec(clock: OracleHostClock): OracleTimeZoneSpec {
  return { kind: 'offset', minutes: offsetMinutesAt(hostZoneOf(clock), clock.nowMs()) };
}

export function hostOffsetLabel(clock: OracleHostClock): string {
  return formatOracleOffset(offsetMinutesAt(hostZoneOf(clock), clock.nowMs()));
}

export interface OracleClockReading {
  sysdate: string;
  currentDate: string;
  systimestamp: string;
  currentTimestamp: string;
  localTimestamp: string;
  dbTimeZone: string;
  sessionTimeZone: string;
}

const DAY_ABBREVIATIONS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_ABBREVIATIONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function hostWallDate(clock: OracleHostClock, atMs: number = clock.nowMs()): Date {
  return new Date(atMs + offsetMinutesAt(hostZoneOf(clock), atMs) * 60_000);
}

export function hostBannerDate(clock: OracleHostClock): string {
  const wall = hostWallDate(clock);
  const day = String(wall.getUTCDate()).padStart(2, '0');
  return `${DAY_ABBREVIATIONS[wall.getUTCDay()]} ${MONTH_ABBREVIATIONS[wall.getUTCMonth()]} ${day} ${wall.getUTCFullYear()}`;
}

export function hostWallTime(clock: OracleHostClock): string {
  return hostWallDate(clock).toISOString().slice(11, 19);
}

export function hostWallIso(clock: OracleHostClock): string {
  return hostWallDate(clock).toISOString().slice(0, -1);
}
