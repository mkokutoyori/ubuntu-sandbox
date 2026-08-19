export type Weekday =
  | 'sunday' | 'monday' | 'tuesday' | 'wednesday'
  | 'thursday' | 'friday' | 'saturday';

export const WEEKDAYS: readonly Weekday[] = Object.freeze([
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]);

export type ScheduleKind = 'recurring' | 'onetime' | 'group';

export interface ScheduleObject {
  readonly name: string;
  readonly days: readonly Weekday[];
  readonly startMinutes: number;
  readonly endMinutes: number;
  readonly always: boolean;
  readonly predefined: boolean;
  readonly kind: ScheduleKind;
  readonly startAt?: number;
  readonly endAt?: number;
  readonly members?: readonly string[];
}

export const ALWAYS_SCHEDULE: ScheduleObject = Object.freeze({
  name: 'always',
  days: WEEKDAYS,
  startMinutes: 0,
  endMinutes: 24 * 60,
  always: true,
  predefined: true,
  kind: 'recurring',
});

export function parseClock(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function makeSchedule(
  name: string, days: readonly string[], start: string, end: string,
): ScheduleObject | null {
  const startMinutes = parseClock(start);
  const endMinutes = parseClock(end);
  if (startMinutes === null || endMinutes === null) return null;

  const kept = days.filter((day): day is Weekday =>
    (WEEKDAYS as readonly string[]).includes(day));

  return Object.freeze({
    name,
    days: Object.freeze(kept),
    startMinutes,
    endMinutes: endMinutes === 0 ? 24 * 60 : endMinutes,
    always: false,
    predefined: false,
    kind: 'recurring',
  });
}

export function parseFortiMoment(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})\s+(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text.trim());
  if (!match) return null;

  const [, hh, mm, year, month, day] = match;
  const hours = Number.parseInt(hh, 10);
  const minutes = Number.parseInt(mm, 10);
  if (hours > 23 || minutes > 59) return null;

  const monthIndex = Number.parseInt(month, 10) - 1;
  const dayOfMonth = Number.parseInt(day, 10);
  if (monthIndex < 0 || monthIndex > 11 || dayOfMonth < 1 || dayOfMonth > 31) return null;

  return Date.UTC(Number.parseInt(year, 10), monthIndex, dayOfMonth, hours, minutes);
}

export function makeOnetimeSchedule(
  name: string, start: string, end: string,
): ScheduleObject | null {
  const startAt = parseFortiMoment(start);
  const endAt = parseFortiMoment(end);
  if (startAt === null || endAt === null || endAt <= startAt) return null;

  return Object.freeze({
    name,
    days: Object.freeze([]),
    startMinutes: 0,
    endMinutes: 0,
    always: false,
    predefined: false,
    kind: 'onetime' as const,
    startAt,
    endAt,
  });
}

export function makeScheduleGroup(
  name: string, members: readonly string[],
): ScheduleObject {
  return Object.freeze({
    name,
    days: Object.freeze([]),
    startMinutes: 0,
    endMinutes: 0,
    always: false,
    predefined: false,
    kind: 'group' as const,
    members: Object.freeze([...members]),
  });
}

export function scheduleActiveAt(schedule: ScheduleObject, at: number): boolean {
  if (schedule.always) return true;
  if (schedule.kind === 'onetime') {
    return schedule.startAt !== undefined && schedule.endAt !== undefined
      && at >= schedule.startAt && at < schedule.endAt;
  }
  if (schedule.kind === 'group') return false;
  if (schedule.days.length === 0) return false;

  const moment = new Date(at);
  const day = WEEKDAYS[moment.getDay()];
  if (!schedule.days.includes(day)) return false;

  const minutes = moment.getHours() * 60 + moment.getMinutes();
  if (schedule.startMinutes <= schedule.endMinutes) {
    return minutes >= schedule.startMinutes && minutes < schedule.endMinutes;
  }
  return minutes >= schedule.startMinutes || minutes < schedule.endMinutes;
}

export class ScheduleStore {
  private readonly schedules = new Map<string, ScheduleObject>();

  constructor() {
    this.schedules.set(ALWAYS_SCHEDULE.name, ALWAYS_SCHEDULE);
  }

  upsert(schedule: ScheduleObject): boolean {
    const existing = this.schedules.get(schedule.name);
    if (existing?.predefined) return false;

    this.schedules.set(schedule.name, schedule);
    return true;
  }

  remove(name: string): boolean {
    if (this.schedules.get(name)?.predefined) return false;
    return this.schedules.delete(name);
  }

  get(name: string): ScheduleObject | undefined {
    return this.schedules.get(name);
  }

  names(): readonly string[] {
    return [...this.schedules.keys()];
  }

  activeAt(name: string, at: number, seen: ReadonlySet<string> = new Set()): boolean {
    const schedule = this.schedules.get(name);
    if (schedule === undefined || seen.has(name)) return false;

    if (schedule.kind === 'group') {
      const visited = new Set(seen).add(name);
      return (schedule.members ?? []).some(member => this.activeAt(member, at, visited));
    }
    return scheduleActiveAt(schedule, at);
  }
}
