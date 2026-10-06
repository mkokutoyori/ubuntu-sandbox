import { TimeZone } from './TimeZone';
import { partsAt, utcMsForLocal } from './TimeZoneRegistry';

export interface GnuDateContext {
  readonly nowMs: number;
  readonly zone: TimeZone | null;
}

const MONTH_NAMES: Readonly<Record<string, number>> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
  june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

const WEEKDAY_NAMES: Readonly<Record<string, number>> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2,
  wednesday: 3, wednes: 3, wed: 3, thursday: 4, thurs: 4, thur: 4, thu: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  next: 1, last: -1, this: 0, first: 1, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
};

const ZONE_OFFSET_MINUTES: Readonly<Record<string, number>> = {
  utc: 0, gmt: 0, ut: 0, z: 0, wet: 0, west: 60, bst: 60, cet: 60, cest: 120, met: 60, mest: 120,
  eet: 120, eest: 180, msk: 180, est: -300, edt: -240, cst: -360, cdt: -300, mst: -420,
  mdt: -360, pst: -480, pdt: -420, akst: -540, akdt: -480, hst: -600, jst: 540, kst: 540,
  nzst: 720, nzdt: 780, sast: 120, cat: 120, eat: 180, wat: 60,
};

type UnitKind = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'fortnight' | 'month' | 'year';

const UNIT_WORDS: Readonly<Record<string, UnitKind>> = {
  second: 'second', seconds: 'second', sec: 'second', secs: 'second',
  minute: 'minute', minutes: 'minute', min: 'minute', mins: 'minute',
  hour: 'hour', hours: 'hour', day: 'day', days: 'day', week: 'week', weeks: 'week',
  fortnight: 'fortnight', fortnights: 'fortnight',
  month: 'month', months: 'month', year: 'year', years: 'year',
};

const WORD = '[a-z]+';
const UNIT_PATTERN = '(seconds?|secs?|minutes?|mins?|hours?|days?|weeks?|fortnights?|months?|years?)\\b';

interface Parsed {
  epochSeconds: number | null;
  year: number | null;
  month: number | null;
  day: number | null;
  time: { hour: number; minute: number; second: number; milli: number } | null;
  weekday: { day: number; ordinal: number } | null;
  years: number;
  months: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  relativeSeen: boolean;
  zoneMinutes: number | null;
}

function emptyParse(): Parsed {
  return {
    epochSeconds: null, year: null, month: null, day: null, time: null, weekday: null,
    years: 0, months: 0, days: 0, hours: 0, minutes: 0, seconds: 0,
    relativeSeen: false, zoneMinutes: null,
  };
}

function addRelative(p: Parsed, unit: UnitKind, amount: number): void {
  p.relativeSeen = true;
  switch (unit) {
    case 'second': p.seconds += amount; break;
    case 'minute': p.minutes += amount; break;
    case 'hour': p.hours += amount; break;
    case 'day': p.days += amount; break;
    case 'week': p.days += 7 * amount; break;
    case 'fortnight': p.days += 14 * amount; break;
    case 'month': p.months += amount; break;
    case 'year': p.years += amount; break;
  }
}

function meridianHour(hour: number, meridian: string | undefined): number | null {
  if (meridian === undefined) return hour <= 23 ? hour : null;
  if (hour < 1 || hour > 12) return null;
  const pm = meridian.startsWith('p');
  return (hour % 12) + (pm ? 12 : 0);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function expandYear(value: string): number {
  const year = Number(value);
  if (value.length > 2) return year;
  return year < 69 ? 2000 + year : 1900 + year;
}

class Scanner {
  private rest: string;

  constructor(text: string) {
    this.rest = text;
  }

  get remaining(): string { return this.rest; }

  done(): boolean { return this.rest.length === 0; }

  skipSeparators(): void {
    this.rest = this.rest.replace(/^[\s,]+/, '');
  }

  take(pattern: RegExp): RegExpExecArray | null {
    const match = pattern.exec(this.rest);
    if (match === null) return null;
    this.rest = this.rest.slice(match[0].length);
    return match;
  }

  peek(pattern: RegExp): RegExpExecArray | null {
    return pattern.exec(this.rest);
  }

  advance(length: number): void {
    this.rest = this.rest.slice(length);
  }
}

function takeTime(scan: Scanner, p: Parsed): boolean {
  const clock = scan.take(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(?:\s*([ap])\.?m\.?)?(?![\d:])/);
  if (clock !== null) {
    const hour = meridianHour(Number(clock[1]), clock[5]);
    const minute = Number(clock[2]);
    const second = clock[3] === undefined ? 0 : Number(clock[3]);
    if (hour === null || minute > 59 || second > 60 || p.time !== null) return false;
    const milli = clock[4] === undefined ? 0 : Math.floor(Number(`0.${clock[4]}`) * 1000);
    p.time = { hour, minute, second, milli };
    return true;
  }
  const bare = scan.take(/^(\d{1,2})\s*([ap])\.?m\.?\b/);
  if (bare !== null) {
    const hour = meridianHour(Number(bare[1]), bare[2]);
    if (hour === null || p.time !== null) return false;
    p.time = { hour, minute: 0, second: 0, milli: 0 };
    return true;
  }
  return false;
}

function takeNumericDate(scan: Scanner, p: Parsed): boolean | null {
  const iso = scan.peek(/^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/);
  const slashYmd = scan.peek(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?!\d)/);
  const slashMdy = scan.peek(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?!\d)/);
  const slashMd = scan.peek(/^(\d{1,2})\/(\d{1,2})(?![\d/])/);
  const basic = scan.peek(/^(\d{4})(\d{2})(\d{2})(?!\d)/);
  let year: number | null = null;
  let month: number;
  let day: number;
  let consumed: string;
  if (iso !== null || slashYmd !== null) {
    const m = (iso ?? slashYmd)!;
    year = Number(m[1]); month = Number(m[2]); day = Number(m[3]); consumed = m[0];
  } else if (slashMdy !== null) {
    month = Number(slashMdy[1]); day = Number(slashMdy[2]); year = expandYear(slashMdy[3]);
    consumed = slashMdy[0];
  } else if (slashMd !== null) {
    month = Number(slashMd[1]); day = Number(slashMd[2]); consumed = slashMd[0];
  } else if (basic !== null) {
    year = Number(basic[1]); month = Number(basic[2]); day = Number(basic[3]); consumed = basic[0];
  } else {
    return null;
  }
  if (p.month !== null || p.day !== null) return false;
  scan.advance(consumed.length);
  p.year = year;
  p.month = month;
  p.day = day;
  return true;
}

function takeMonthFirst(scan: Scanner, p: Parsed): boolean {
  const named = scan.take(new RegExp(`^(${Object.keys(MONTH_NAMES).sort((a, b) => b.length - a.length).join('|')})\\b\\.?`));
  if (named === null) return false;
  if (p.month !== null) return false;
  p.month = MONTH_NAMES[named[1]];
  const day = scan.take(/^\s*(\d{1,2})(?:st|nd|rd|th)?(?![\d:])/);
  if (day !== null) p.day = Number(day[1]);
  else p.day = 1;
  const year = scan.take(/^,?\s*(\d{4})(?![\d:])/);
  if (year !== null) p.year = Number(year[1]);
  return true;
}

function takeDayFirst(scan: Scanner, p: Parsed): boolean {
  const names = Object.keys(MONTH_NAMES).sort((a, b) => b.length - a.length).join('|');
  const match = scan.take(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?[\\s-]*(${names})\\b\\.?(?:[\\s,-]*(\\d{4})(?![\\d:]))?`));
  if (match === null) return false;
  if (p.month !== null) return false;
  p.day = Number(match[1]);
  p.month = MONTH_NAMES[match[2]];
  if (match[3] !== undefined) p.year = Number(match[3]);
  return true;
}

function takeSignedRelative(scan: Scanner, p: Parsed): boolean {
  const match = scan.take(new RegExp(`^([+-])\\s*(\\d+)\\s*${UNIT_PATTERN}(\\s+ago\\b)?`));
  if (match === null) return false;
  let amount = Number(match[2]) * (match[1] === '-' ? -1 : 1);
  if (match[4] !== undefined) amount = -amount;
  addRelative(p, UNIT_WORDS[match[3]], amount);
  return true;
}

function takeUnsignedRelative(scan: Scanner, p: Parsed): boolean {
  const match = scan.take(new RegExp(`^(\\d+)\\s*${UNIT_PATTERN}(\\s+ago\\b)?`));
  if (match === null) return false;
  let amount = Number(match[1]);
  if (match[3] !== undefined) amount = -amount;
  addRelative(p, UNIT_WORDS[match[2]], amount);
  return true;
}

function takeZoneOffset(scan: Scanner, p: Parsed): boolean {
  if (p.time === null || p.zoneMinutes !== null) return false;
  const match = scan.take(/^\s*([+-])(\d{2}):?(\d{2})(?![\d])/);
  if (match === null) return false;
  p.zoneMinutes = (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
  return true;
}

function takeBareNumber(scan: Scanner, p: Parsed): boolean {
  const match = scan.take(/^(\d{3,4})(?![\d:])/);
  if (match === null) return false;
  const digits = match[1];
  if (p.month !== null && p.year === null && digits.length === 4) {
    p.year = Number(digits);
    return true;
  }
  if (p.time !== null) return false;
  const hour = Number(digits.slice(0, digits.length - 2));
  const minute = Number(digits.slice(-2));
  if (hour > 23 || minute > 59) return false;
  p.time = { hour, minute, second: 0, milli: 0 };
  return true;
}

function takeWord(scan: Scanner, p: Parsed, pendingOrdinal: { value: number | null }): boolean {
  const word = scan.take(new RegExp(`^(${WORD})\\.?`));
  if (word === null) return false;
  const text = word[1];
  const ordinal = pendingOrdinal.value;
  pendingOrdinal.value = null;
  if (text in ORDINAL_WORDS) {
    pendingOrdinal.value = ORDINAL_WORDS[text];
    return true;
  }
  if (ordinal !== null && text in UNIT_WORDS) {
    addRelative(p, UNIT_WORDS[text], ordinal);
    return true;
  }
  if (text in WEEKDAY_NAMES) {
    p.weekday = { day: WEEKDAY_NAMES[text], ordinal: ordinal ?? 0 };
    return true;
  }
  if (ordinal !== null) return false;
  switch (text) {
    case 'now': p.relativeSeen = true; return true;
    case 'today': p.relativeSeen = true; return true;
    case 'tomorrow': addRelative(p, 'day', 1); return true;
    case 'yesterday': addRelative(p, 'day', -1); return true;
    case 't': return true;
    default: break;
  }
  if (text in ZONE_OFFSET_MINUTES && p.zoneMinutes === null) {
    p.zoneMinutes = ZONE_OFFSET_MINUTES[text];
    return true;
  }
  return false;
}

function parseItems(text: string): Parsed | null {
  const p = emptyParse();
  const scan = new Scanner(text.trim().toLowerCase());
  const ordinal: { value: number | null } = { value: null };
  scan.skipSeparators();
  const epoch = scan.take(/^@(-?\d+)(?:[.,]\d+)?\s*$/);
  if (epoch !== null) {
    p.epochSeconds = Number(epoch[1]);
    return p;
  }
  let guard = 0;
  while (!scan.done()) {
    if (guard++ > 64) return null;
    const date = takeNumericDate(scan, p);
    if (date === false) return null;
    const ok = date === true
      || takeTime(scan, p)
      || takeZoneOffset(scan, p)
      || takeSignedRelative(scan, p)
      || takeUnsignedRelative(scan, p)
      || takeDayFirst(scan, p)
      || takeMonthFirst(scan, p)
      || takeBareNumber(scan, p)
      || takeWord(scan, p, ordinal);
    if (!ok) return null;
    scan.skipSeparators();
  }
  if (ordinal.value !== null) return null;
  return p;
}

export function parseGnuDate(spec: string, context: GnuDateContext): number | null {
  const p = parseItems(spec);
  if (p === null) return null;
  if (p.epochSeconds !== null) return p.epochSeconds * 1000;
  const zone = context.zone;
  const now = zone === null
    ? partsAt(TimeZone.UTC, context.nowMs)
    : partsAt(zone, context.nowMs);
  const dateGiven = p.month !== null;
  const timeKept = p.time !== null || (p.relativeSeen && !dateGiven && p.weekday === null);
  const year = p.year ?? now.year;
  const month = p.month ?? now.month;
  const day = p.day ?? now.day;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  const time = p.time ?? (timeKept
    ? { hour: now.hour, minute: now.minute, second: now.second, milli: new Date(context.nowMs).getUTCMilliseconds() }
    : { hour: 0, minute: 0, second: 0, milli: 0 });
  let wall = Date.UTC(
    year + p.years, month - 1 + p.months, day + p.days,
    time.hour + p.hours, time.minute + p.minutes, time.second + p.seconds, time.milli,
  );
  if (p.weekday !== null && !dateGiven) {
    const current = new Date(wall).getUTCDay();
    const { day: target, ordinal } = p.weekday;
    const shift = ((target - current + 7) % 7)
      + 7 * (ordinal - (ordinal > 0 && current !== target ? 1 : 0));
    wall += shift * 86_400_000;
  }
  if (p.zoneMinutes !== null) return wall - p.zoneMinutes * 60_000;
  return zone === null ? wall : utcMsForLocal(zone, wall);
}
