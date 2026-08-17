export type Weekday =
  | 'sunday' | 'monday' | 'tuesday' | 'wednesday'
  | 'thursday' | 'friday' | 'saturday';

export const WEEKDAYS: readonly Weekday[] = Object.freeze([
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]);

export interface ScheduleObject {
  readonly name: string;
  readonly days: readonly Weekday[];
  readonly startMinutes: number;
  readonly endMinutes: number;
  readonly always: boolean;
  readonly predefined: boolean;
}

export const ALWAYS_SCHEDULE: ScheduleObject = Object.freeze({
  name: 'always',
  days: WEEKDAYS,
  startMinutes: 0,
  endMinutes: 24 * 60,
  always: true,
  predefined: true,
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
  });
}

export function scheduleActiveAt(schedule: ScheduleObject, at: number): boolean {
  if (schedule.always) return true;
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

  activeAt(name: string, at: number): boolean {
    const schedule = this.schedules.get(name);
    return schedule === undefined ? false : scheduleActiveAt(schedule, at);
  }
}
