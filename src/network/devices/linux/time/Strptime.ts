import type { HostClock } from '../audit/tools/AuditHostClock';

export interface Tm {
  year: number;
  mon: number;
  mday: number;
  hour: number;
  min: number;
  sec: number;
  gmtoff?: number;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';

function takeNumber(text: string, at: number, low: number, high: number, digits: number): { value: number; end: number } | null {
  let i = at;
  while (text[i] === ' ') i++;
  if (!isDigit(text[i])) return null;
  let value = 0;
  let taken = 0;
  while (taken < digits && isDigit(text[i])) {
    value = value * 10 + (text.charCodeAt(i) - 48);
    i++;
    taken++;
  }
  if (value < low || value > high) return null;
  return { value, end: i };
}

function takeMonthName(text: string, at: number): { month: number; end: number } | null {
  const rest = text.slice(at).toLowerCase();
  for (let month = 0; month < MONTH_NAMES.length; month++) {
    const full = MONTH_NAMES[month].toLowerCase();
    if (rest.startsWith(full)) return { month, end: at + full.length };
  }
  for (let month = 0; month < MONTH_NAMES.length; month++) {
    const abbreviated = MONTH_NAMES[month].slice(0, 3).toLowerCase();
    if (rest.startsWith(abbreviated)) return { month, end: at + 3 };
  }
  return null;
}

function takeOffset(text: string, at: number): { gmtoff: number; end: number } | null {
  let i = at;
  while (i < text.length && isSpace(text[i])) i++;
  if (text[i] === 'Z') return { gmtoff: 0, end: i + 1 };
  if (text[i] !== '+' && text[i] !== '-') return null;
  const negative = text[i++] === '-';
  let value = 0;
  let digits = 0;
  while (digits < 4 && isDigit(text[i])) {
    value = value * 10 + (text.charCodeAt(i++) - 48);
    digits++;
    if (text[i] === ':' && digits === 2 && isDigit(text[i + 1])) i++;
  }
  if (digits === 2) value *= 100;
  else if (digits !== 4) return null;
  else if (value % 100 >= 60) return null;
  const gmtoff = Math.trunc(value / 100) * 3600 + (value % 100) * 60;
  return { gmtoff: negative ? -gmtoff : gmtoff, end: i };
}

export function strptime(text: string, format: string, tm: Tm, clock: Pick<HostClock, 'localTime'>): number {
  let at = 0;
  for (let f = 0; f < format.length; f++) {
    const ch = format[f];
    if (ch === '%') {
      const directive = format[++f];
      if (directive === 's') {
        let i = at;
        while (text[i] === ' ') i++;
        const first = i;
        while (isDigit(text[i])) i++;
        if (i === first) return -1;
        const seconds = Number(text.slice(first, i));
        const local = clock.localTime(seconds);
        tm.year = local.year;
        tm.mon = local.mon;
        tm.mday = local.mday;
        tm.hour = local.hour;
        tm.min = local.min;
        tm.sec = local.sec;
        at = i;
        continue;
      }
      if (directive === 'b' || directive === 'B' || directive === 'h') {
        while (text[at] === ' ') at++;
        const named = takeMonthName(text, at);
        if (named === null) return -1;
        tm.mon = named.month;
        at = named.end;
        continue;
      }
      if (directive === 'z') {
        const offset = takeOffset(text, at);
        if (offset === null) return -1;
        tm.gmtoff = offset.gmtoff;
        at = offset.end;
        continue;
      }
      const spec: Record<string, [number, number, number]> = {
        y: [0, 99, 2], Y: [0, 9999, 4], m: [1, 12, 2], d: [1, 31, 2], H: [0, 23, 2], M: [0, 59, 2], S: [0, 61, 2],
      };
      const entry = spec[directive];
      if (entry === undefined) return -1;
      const taken = takeNumber(text, at, entry[0], entry[1], entry[2]);
      if (taken === null) return -1;
      at = taken.end;
      if (directive === 'y') tm.year = 1900 + (taken.value >= 69 ? taken.value : taken.value + 100);
      else if (directive === 'Y') tm.year = taken.value;
      else if (directive === 'm') tm.mon = taken.value - 1;
      else if (directive === 'd') tm.mday = taken.value;
      else if (directive === 'H') tm.hour = taken.value;
      else if (directive === 'M') tm.min = taken.value;
      else tm.sec = taken.value;
    } else if (isSpace(ch)) {
      while (at < text.length && isSpace(text[at])) at++;
    } else {
      if (text[at] !== ch) return -1;
      at++;
    }
  }
  return at;
}
