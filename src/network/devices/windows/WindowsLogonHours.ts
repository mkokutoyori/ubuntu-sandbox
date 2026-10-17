import { ZonedDate } from '@/network/core/time/ZonedDate';

export const HOURS_PER_WEEK = 168;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const DAY_ALIASES: ReadonlyMap<string, number> = new Map([
  ['su', 0], ['sun', 0], ['sunday', 0],
  ['m', 1], ['mo', 1], ['mon', 1], ['monday', 1],
  ['t', 2], ['tu', 2], ['tue', 2], ['tues', 2], ['tuesday', 2],
  ['w', 3], ['we', 3], ['wed', 3], ['wednesday', 3],
  ['th', 4], ['thu', 4], ['thur', 4], ['thurs', 4], ['thursday', 4],
  ['f', 5], ['fr', 5], ['fri', 5], ['friday', 5],
  ['sa', 6], ['sat', 6], ['saturday', 6],
]);

export type LogonHours = readonly boolean[];

export type LogonHoursParse =
  | { readonly ok: true; readonly hours: LogonHours | null }
  | { readonly ok: false };

const INVALID: LogonHoursParse = { ok: false };

function parseHour(token: string): number | null {
  const match = /^(\d{1,2})(?::00)?(?:(a|p)\.?m\.?)?$/.exec(token.toLowerCase());
  if (match === null) return null;
  let hour = Number(match[1]);
  if (match[2] === undefined) return hour <= 24 ? hour : null;
  if (hour < 1 || hour > 12) return null;
  if (match[2] === 'a') hour = hour === 12 ? 0 : hour;
  else hour = hour === 12 ? 12 : hour + 12;
  return hour;
}

function parseDays(token: string): number[] | null {
  const bounds = token.toLowerCase().split('-');
  if (bounds.length > 2) return null;
  const first = DAY_ALIASES.get(bounds[0]);
  const last = bounds.length === 2 ? DAY_ALIASES.get(bounds[1]) : first;
  if (first === undefined || last === undefined) return null;
  const days: number[] = [];
  for (let day = first; ; day = (day + 1) % 7) {
    days.push(day);
    if (day === last) break;
  }
  return days;
}

function parseHourRange(token: string): [number, number] | null {
  const bounds = token.split('-');
  if (bounds.length > 2 || bounds[0] === '') return null;
  const start = parseHour(bounds[0]);
  const end = bounds.length === 2 ? parseHour(bounds[1]) : start === null ? null : start + 1;
  if (start === null || end === null || start === end) return null;
  return [start, end];
}

export function parseLogonHours(spec: string): LogonHoursParse {
  const text = spec.trim();
  if (text.toLowerCase() === 'all') return { ok: true, hours: null };
  const hours = new Array<boolean>(HOURS_PER_WEEK).fill(false);
  for (const entry of text.split(';').filter((part) => part.trim() !== '')) {
    const days: number[] = [];
    const ranges: Array<[number, number]> = [];
    for (const token of entry.split(',').map((part) => part.trim())) {
      const asDays = /\d/.test(token) ? null : parseDays(token);
      if (asDays !== null) {
        if (ranges.length > 0) return INVALID;
        days.push(...asDays);
        continue;
      }
      const range = parseHourRange(token);
      if (range === null || days.length === 0) return INVALID;
      ranges.push(range);
    }
    if (days.length === 0) return INVALID;
    for (const day of days) {
      for (const [start, end] of ranges.length > 0 ? ranges : [[0, 24] as [number, number]]) {
        const length = (end - start + 24) % 24 || 24;
        for (let step = 0; step < length; step++) hours[(day * 24 + start + step) % HOURS_PER_WEEK] = true;
      }
    }
  }
  return { ok: true, hours };
}

export function logonHoursAllow(hours: LogonHours | undefined, at: number, zone: string | undefined): boolean {
  if (hours === undefined) return true;
  const local = ZonedDate.in(at, zone);
  return hours[local.getDay() * 24 + local.getHours()] === true;
}

function clock(hour: number): string {
  const wrapped = hour % 24;
  const suffix = wrapped < 12 ? 'AM' : 'PM';
  return `${wrapped % 12 === 0 ? 12 : wrapped % 12}:00 ${suffix}`;
}

export function describeLogonHours(hours: LogonHours | undefined): string[] {
  if (hours === undefined) return ['All'];
  if (!hours.includes(true)) return ['None'];
  const runs: string[] = [];
  const start = hours.indexOf(false);
  for (let offset = 0; offset < HOURS_PER_WEEK; offset++) {
    const index = (start + offset) % HOURS_PER_WEEK;
    if (!hours[index]) continue;
    const runStart = index;
    let runEnd = index + 1;
    offset++;
    while (offset < HOURS_PER_WEEK && hours[(start + offset) % HOURS_PER_WEEK]) {
      runEnd++;
      offset++;
    }
    const from = runStart % HOURS_PER_WEEK;
    const to = runEnd % HOURS_PER_WEEK;
    runs.push(`${DAY_NAMES[Math.floor(from / 24)]} ${clock(from % 24)} - ${DAY_NAMES[Math.floor(to / 24)]} ${clock(to % 24)}`);
  }
  return runs;
}
