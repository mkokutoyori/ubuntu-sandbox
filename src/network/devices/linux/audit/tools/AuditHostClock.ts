import { TimeZone } from '@/network/core/time/TimeZone';
import { partsAt, utcMsForLocal } from '@/network/core/time/TimeZoneRegistry';
import type { LocalTime } from './AuditToolHost';

export interface HostClock {
  localTime(epochSec: number): LocalTime;
  mktime(tm: Omit<LocalTime, 'wday' | 'yday'>): number;
}

export function hostClock(zoneName: string): HostClock {
  const zone = TimeZone.parse(zoneName) ?? TimeZone.UTC;
  return {
    localTime(epochSec: number): LocalTime {
      const p = partsAt(zone, epochSec * 1000);
      const yday = Math.round((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(p.year, 0, 1)) / 86_400_000);
      return { year: p.year, mon: p.month - 1, mday: p.day, hour: p.hour, min: p.minute, sec: p.second, wday: p.weekday, yday };
    },
    mktime(tm): number {
      const local = Date.UTC(tm.year, tm.mon, tm.mday, tm.hour, tm.min, tm.sec);
      return Math.floor(utcMsForLocal(zone, local) / 1000);
    },
  };
}
