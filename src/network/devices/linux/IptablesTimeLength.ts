const WEEK_DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const DAY_SECONDS = 24 * 60 * 60;
const MAX_DAYTIME = DAY_SECONDS - 1;
const ALL_WEEKDAYS = 0b11111110;
const ALL_MONTHDAYS = 0xfffffffe;

export interface TimeWindow {
  readonly start: number;
  readonly stop: number;
  readonly weekdays: number;
  readonly monthdays: number;
  readonly dateStart: number;
  readonly dateStop: number;
  readonly kernelTz: boolean;
}

function invalidTime(text: string): string {
  return `invalid time "${text}" specified, should be hh:mm[:ss] format and within the boundaries`;
}

export function parseDaytime(text: string): number | string {
  const match = /^(\d+):(\d+)(?::(\d+))?$/.exec(text);
  if (match === null) return invalidTime(text);
  const [hour, minute, second] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  return hour > 23 || minute > 59 || second > 59 ? invalidTime(text) : hour * 3600 + minute * 60 + second;
}

function parseWeekdays(text: string): number | string {
  let mask = 0;
  for (const item of text.split(',')) {
    const named = WEEK_DAYS.findIndex((day, index) => index > 0 && day.toLowerCase() === item.toLowerCase());
    const numbered = /^[1-7]$/.test(item) ? Number(item) : -1;
    const day = named > 0 ? named : numbered;
    if (day < 1) return `invalid weekday "${item}" specified, should be one of Mon,Tue,Wed,Thu,Fri,Sat,Sun or 1-7`;
    mask |= 1 << day;
  }
  return mask;
}

function parseMonthdays(text: string): number | string {
  let mask = 0;
  for (const item of text.split(',')) {
    const day = /^\d+$/.test(item) ? Number(item) : 0;
    if (day < 1 || day > 31) return `invalid day "${item}" specified, should be between 1 and 31`;
    mask |= 1 << day;
  }
  return mask >>> 0;
}

function parseDate(text: string): number | string {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2})(?::(\d{2})(?::(\d{2}))?)?)?)?)?$/.exec(text);
  if (match === null) return `invalid date "${text}" specified, should be ISO 8601: YYYY[-MM[-DD[Thh[:mm[:ss]]]]]`;
  const [year, month, day, hour, minute, second] = [match[1], match[2] ?? '1', match[3] ?? '1', match[4] ?? '0', match[5] ?? '0', match[6] ?? '0'].map(Number);
  return Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1000);
}

export function parseTimeWindow(options: ReadonlyMap<string, string>, negated: ReadonlySet<string>): TimeWindow | string {
  const start = options.has('--timestart') ? parseDaytime(options.get('--timestart') ?? '') : 0;
  if (typeof start === 'string') return start;
  const stop = options.has('--timestop') ? parseDaytime(options.get('--timestop') ?? '') : MAX_DAYTIME;
  if (typeof stop === 'string') return stop;
  let weekdays = ALL_WEEKDAYS;
  if (options.has('--weekdays')) {
    const parsed = parseWeekdays(options.get('--weekdays') ?? '');
    if (typeof parsed === 'string') return parsed;
    weekdays = negated.has('--weekdays') ? (parsed ^ ALL_WEEKDAYS) : parsed;
  }
  let monthdays = ALL_MONTHDAYS;
  if (options.has('--monthdays')) {
    const parsed = parseMonthdays(options.get('--monthdays') ?? '');
    if (typeof parsed === 'string') return parsed;
    monthdays = negated.has('--monthdays') ? ((parsed ^ ALL_MONTHDAYS) >>> 0) : parsed;
  }
  const dateStart = options.has('--datestart') ? parseDate(options.get('--datestart') ?? '') : 0;
  if (typeof dateStart === 'string') return dateStart;
  const dateStop = options.has('--datestop') ? parseDate(options.get('--datestop') ?? '') : Number.MAX_SAFE_INTEGER;
  if (typeof dateStop === 'string') return dateStop;
  return { start, stop, weekdays, monthdays, dateStart, dateStop, kernelTz: options.has('--kerneltz') };
}

export function timeWindowHolds(window: TimeWindow, nowMs: number): boolean {
  const seconds = Math.floor(nowMs / 1000);
  if (seconds < window.dateStart || seconds > window.dateStop) return false;
  const moment = new Date(nowMs);
  const daytime = moment.getUTCHours() * 3600 + moment.getUTCMinutes() * 60 + moment.getUTCSeconds();
  if (window.start < window.stop) {
    if (daytime < window.start || daytime > window.stop) return false;
  } else if (daytime < window.start && daytime > window.stop) {
    return false;
  }
  const weekday = moment.getUTCDay() === 0 ? 7 : moment.getUTCDay();
  if ((window.weekdays & (1 << weekday)) === 0) return false;
  return (window.monthdays & (1 << moment.getUTCDate())) !== 0;
}

function clock(seconds: number): string {
  const part = (value: number): string => String(value).padStart(2, '0');
  return `${part(Math.floor(seconds / 3600))}:${part(Math.floor((seconds % 3600) / 60))}:${part(seconds % 60)}`;
}

function dateText(seconds: number): string {
  const d = new Date(seconds * 1000);
  const part = (value: number): string => String(value).padStart(2, '0');
  return `${d.getUTCFullYear()}-${part(d.getUTCMonth() + 1)}-${part(d.getUTCDate())} ${part(d.getUTCHours())}:${part(d.getUTCMinutes())}:${part(d.getUTCSeconds())}`;
}

function ordinal(day: number): string {
  const suffix = day % 10 === 1 ? 'st' : day % 10 === 2 ? 'nd' : day % 10 === 3 ? 'rd' : 'th';
  return `${day}${suffix}`;
}

export function timeWindowListing(window: TimeWindow): string {
  const parts = ['TIME'];
  if (window.start !== 0 || window.stop !== MAX_DAYTIME) parts.push(`from ${clock(window.start)} to ${clock(window.stop)}`);
  if (window.weekdays !== ALL_WEEKDAYS) {
    parts.push(`on ${WEEK_DAYS.filter((_, day) => day > 0 && (window.weekdays & (1 << day)) !== 0).join(',')}`);
  }
  if (window.monthdays !== ALL_MONTHDAYS) {
    const days = Array.from({ length: 31 }, (_, index) => index + 1).filter((day) => (window.monthdays & (1 << day)) !== 0);
    parts.push(`on ${days.map(ordinal).join(',')}`);
  }
  if (window.dateStart !== 0) parts.push(`starting from ${dateText(window.dateStart)}`);
  if (window.dateStop !== Number.MAX_SAFE_INTEGER) parts.push(`until date ${dateText(window.dateStop)}`);
  if (!window.kernelTz) parts.push('UTC');
  return parts.join(' ');
}

export interface LengthRange {
  readonly min: number;
  readonly max: number;
}

export function parseLengthRange(text: string): LengthRange | string {
  const match = /^(\d+)(?::(\d+))?$/.exec(text);
  if (match === null) return `length: invalid length "${text}"`;
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  return min > max ? `length: invalid length "${text}"` : { min, max };
}

export function lengthListing(range: LengthRange, inverted: boolean): string {
  return `length ${inverted ? '!' : ''}${range.min === range.max ? range.min : `${range.min}:${range.max}`}`;
}
