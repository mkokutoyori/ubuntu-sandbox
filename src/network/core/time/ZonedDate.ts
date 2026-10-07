import { TimeZone } from './TimeZone';
import { offsetMinutesAt, partsAt, utcMsForLocal } from './TimeZoneRegistry';

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  milli: number;
}

export class ZonedDate extends Date {
  private readonly zone: TimeZone | null;

  constructor(epochMs: number, zone: TimeZone | string | null) {
    super(epochMs);
    this.zone = typeof zone === 'string' ? TimeZone.parse(zone) : zone;
  }

  static in(epochMs: number, zoneName: string | undefined): ZonedDate {
    return new ZonedDate(epochMs, zoneName === undefined ? null : TimeZone.parse(zoneName));
  }

  zoneOrNull(): TimeZone | null {
    return this.zone;
  }

  offsetMinutes(): number {
    return this.zone === null ? 0 : offsetMinutesAt(this.zone, this.getTime());
  }

  private wall(): Wall {
    const ms = this.getTime();
    const parts = partsAt(this.zone ?? TimeZone.UTC, ms);
    return {
      year: parts.year, month: parts.month, day: parts.day,
      hour: parts.hour, minute: parts.minute, second: parts.second,
      milli: ((ms % 1000) + 1000) % 1000,
    };
  }

  private commit(wall: Wall): number {
    const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.milli);
    return this.setTime(this.zone === null ? naive : utcMsForLocal(this.zone, naive));
  }

  override getFullYear(): number { return this.wall().year; }
  override getMonth(): number { return this.wall().month - 1; }
  override getDate(): number { return this.wall().day; }
  override getDay(): number { return partsAt(this.zone ?? TimeZone.UTC, this.getTime()).weekday; }
  override getHours(): number { return this.wall().hour; }
  override getMinutes(): number { return this.wall().minute; }
  override getSeconds(): number { return this.wall().second; }
  override getTimezoneOffset(): number { return -this.offsetMinutes(); }

  override setFullYear(year: number, month?: number, day?: number): number {
    const w = this.wall();
    return this.commit({ ...w, year, month: month === undefined ? w.month : month + 1, day: day ?? w.day });
  }

  override setMonth(month: number, day?: number): number {
    const w = this.wall();
    return this.commit({ ...w, month: month + 1, day: day ?? w.day });
  }

  override setDate(day: number): number {
    return this.commit({ ...this.wall(), day });
  }

  override setHours(hour: number, minute?: number, second?: number, milli?: number): number {
    const w = this.wall();
    return this.commit({ ...w, hour, minute: minute ?? w.minute, second: second ?? w.second, milli: milli ?? w.milli });
  }

  override setMinutes(minute: number, second?: number, milli?: number): number {
    const w = this.wall();
    return this.commit({ ...w, minute, second: second ?? w.second, milli: milli ?? w.milli });
  }

  override setSeconds(second: number, milli?: number): number {
    const w = this.wall();
    return this.commit({ ...w, second, milli: milli ?? w.milli });
  }

  withInstant(epochMs: number): ZonedDate {
    return new ZonedDate(epochMs, this.zone);
  }
}

export function isZonedDate(value: unknown): value is ZonedDate {
  return value instanceof ZonedDate;
}
