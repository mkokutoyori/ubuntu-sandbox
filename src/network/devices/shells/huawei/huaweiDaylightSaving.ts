const TIME_OF_DAY = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const CALENDAR_DAY = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

const ORDINALS = ['first', 'second', 'third', 'fourth', 'last'];
const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface VrpDaylightRule {
  readonly zoneName: string;
  readonly kind: 'recurring' | 'date';
  readonly start: string;
  readonly end: string;
  readonly offsetMin: number;
}

export interface VrpDaylightParse {
  readonly rule: VrpDaylightRule | null;
  readonly badToken?: string;
}

const isOrdinal = (word: string): boolean => ORDINALS.includes(word.toLowerCase());
const isWeekday = (word: string): boolean => WEEKDAYS.includes(word.slice(0, 3).toLowerCase());
const isMonth = (word: string): boolean => MONTHS.includes(word.slice(0, 3).toLowerCase());

function labelledWeekday(word: string): string {
  return WEEKDAY_LABELS[WEEKDAYS.indexOf(word.slice(0, 3).toLowerCase())];
}

function labelledMonth(word: string): string {
  return MONTH_LABELS[MONTHS.indexOf(word.slice(0, 3).toLowerCase())];
}

function recurringBound(time: string, spec: readonly string[]): string | null {
  if (spec.length !== 3) return null;
  if (!isOrdinal(spec[0]) || !isWeekday(spec[1]) || !isMonth(spec[2])) return null;
  return `${spec[0].toLowerCase()} ${labelledWeekday(spec[1])} ${labelledMonth(spec[2])} ${time}`;
}

function datedBound(time: string, day: string): string | null {
  const parsed = CALENDAR_DAY.exec(day);
  if (!parsed) return null;
  const month = Number.parseInt(parsed[2], 10);
  const dayOfMonth = Number.parseInt(parsed[3], 10);
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return null;
  return `${dayOfMonth} ${MONTH_LABELS[month - 1]} ${parsed[1]} ${time}`;
}

function offsetMinutes(word: string): number | null {
  const asMinutes = /^\d+$/.test(word) ? Number.parseInt(word, 10) : Number.NaN;
  if (Number.isInteger(asMinutes) && asMinutes >= 1 && asMinutes <= 1440) return asMinutes;

  const asClock = TIME_OF_DAY.exec(word);
  if (!asClock) return null;
  const total = Number.parseInt(asClock[1], 10) * 60 + Number.parseInt(asClock[2], 10);
  return total >= 1 ? total : null;
}

export function parseVrpDaylightSaving(args: readonly string[]): VrpDaylightParse {
  const zoneName = args[0];
  if (zoneName === undefined) return { rule: null };

  const mode = (args[1] ?? '').toLowerCase();
  if (mode !== 'repeating' && mode !== 'one-year') {
    return { rule: null, badToken: args[1] ?? zoneName };
  }

  const rest = args.slice(2);
  if (mode === 'one-year') {
    if (rest.length !== 5) return { rule: null, badToken: rest[rest.length - 1] ?? mode };
    if (!TIME_OF_DAY.test(rest[0])) return { rule: null, badToken: rest[0] };
    if (!TIME_OF_DAY.test(rest[2])) return { rule: null, badToken: rest[2] };
    const start = datedBound(rest[0], rest[1]);
    const end = datedBound(rest[2], rest[3]);
    const offsetMin = offsetMinutes(rest[4]);
    if (start === null) return { rule: null, badToken: rest[1] };
    if (end === null) return { rule: null, badToken: rest[3] };
    if (offsetMin === null) return { rule: null, badToken: rest[4] };
    return { rule: { zoneName, kind: 'date', start, end, offsetMin } };
  }

  if (rest.length !== 9) return { rule: null, badToken: rest[rest.length - 1] ?? mode };
  if (!TIME_OF_DAY.test(rest[0])) return { rule: null, badToken: rest[0] };
  if (!TIME_OF_DAY.test(rest[4])) return { rule: null, badToken: rest[4] };
  const start = recurringBound(rest[0], rest.slice(1, 4));
  const end = recurringBound(rest[4], rest.slice(5, 8));
  const offsetMin = offsetMinutes(rest[8]);
  if (start === null) return { rule: null, badToken: rest.slice(1, 4).find((w) => !isOrdinal(w) && !isWeekday(w) && !isMonth(w)) ?? rest[1] };
  if (end === null) return { rule: null, badToken: rest.slice(5, 8).find((w) => !isOrdinal(w) && !isWeekday(w) && !isMonth(w)) ?? rest[5] };
  if (offsetMin === null) return { rule: null, badToken: rest[8] };
  return { rule: { zoneName, kind: 'recurring', start, end, offsetMin } };
}

function vrpBound(written: string, kind: 'recurring' | 'date'): string {
  const tokens = written.trim().split(/\s+/);
  if (tokens.length !== 4) return written;
  if (kind === 'date') {
    const month = MONTH_LABELS.indexOf(tokens[1]) + 1;
    const day = Number.parseInt(tokens[0], 10);
    return `${tokens[3]} ${tokens[2]}-${String(month).padStart(2, '0')}`
      + `-${String(day).padStart(2, '0')}`;
  }
  return `${tokens[3]} ${tokens[0]} ${tokens[1]} ${tokens[2]}`;
}

export function renderVrpDaylightSaving(config: {
  summerTimezone: string; summerKind: 'recurring' | 'date';
  daylightStart: string; daylightEnd: string; daylightOffsetMin: number;
}): string {
  const mode = config.summerKind === 'date' ? 'one-year' : 'repeating';
  return `clock daylight-saving-time ${config.summerTimezone} ${mode}`
    + ` ${vrpBound(config.daylightStart, config.summerKind)}`
    + ` ${vrpBound(config.daylightEnd, config.summerKind)}`
    + ` ${config.daylightOffsetMin}`;
}
