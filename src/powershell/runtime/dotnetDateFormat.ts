import { ZonedDate } from '@/network/core/time/ZonedDate';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const STANDARD: Readonly<Record<string, string>> = {
  d: 'M/d/yyyy',
  D: 'dddd, MMMM d, yyyy',
  f: 'dddd, MMMM d, yyyy h:mm tt',
  F: 'dddd, MMMM d, yyyy h:mm:ss tt',
  g: 'M/d/yyyy h:mm tt',
  G: 'M/d/yyyy h:mm:ss tt',
  m: 'MMMM d',
  M: 'MMMM d',
  y: 'MMMM yyyy',
  Y: 'MMMM yyyy',
  t: 'h:mm tt',
  T: 'h:mm:ss tt',
  s: "yyyy'-'MM'-'dd'T'HH':'mm':'ss",
  o: "yyyy'-'MM'-'dd'T'HH':'mm':'ss'.'fffffffK",
  O: "yyyy'-'MM'-'dd'T'HH':'mm':'ss'.'fffffffK",
};

const UNIVERSAL: Readonly<Record<string, string>> = {
  u: "yyyy'-'MM'-'dd HH':'mm':'ss'Z'",
  U: 'dddd, MMMM d, yyyy h:mm:ss tt',
  r: "ddd, dd MMM yyyy HH':'mm':'ss 'GMT'",
  R: "ddd, dd MMM yyyy HH':'mm':'ss 'GMT'",
};

const TOKENS = /'[^']*'|"[^"]*"|\\.|yyyyy|yyyy|yyy|yy|y|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|f{1,7}|F{1,7}|tt|t|zzz|zz|z|K|%/g;

function offsetMinutesOf(d: Date): number {
  return d instanceof ZonedDate ? d.offsetMinutes() : -d.getTimezoneOffset();
}

function isUtcKind(d: Date): boolean {
  return d instanceof ZonedDate && d.zoneOrNull() === null;
}

function signedHours(minutes: number, pad: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(pad, '0')}`;
}

function fractionOf(d: Date, digits: number, trim: boolean): string {
  const raw = String(((d.getTime() % 1000) + 1000) % 1000).padStart(3, '0') + '0000';
  const out = raw.slice(0, digits);
  return trim ? out.replace(/0+$/, '') : out;
}

function formatCustom(d: Date, fmt: string): string {
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  const hour = d.getHours();
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const offset = offsetMinutesOf(d);
  return fmt.replace(TOKENS, (tok) => {
    if (tok[0] === "'" || tok[0] === '"') return tok.slice(1, -1);
    if (tok[0] === '\\') return tok.slice(1);
    if (tok === '%') return '';
    if (tok[0] === 'f') return fractionOf(d, tok.length, false);
    if (tok[0] === 'F') return fractionOf(d, tok.length, true);
    switch (tok) {
      case 'yyyyy': return pad(d.getFullYear(), 5);
      case 'yyyy': return pad(d.getFullYear(), 4);
      case 'yyy': return pad(d.getFullYear(), 3);
      case 'yy': return pad(d.getFullYear() % 100, 2);
      case 'y': return String(d.getFullYear() % 100);
      case 'MMMM': return MONTH_NAMES[d.getMonth()];
      case 'MMM': return MONTH_NAMES[d.getMonth()].slice(0, 3);
      case 'MM': return pad(d.getMonth() + 1, 2);
      case 'M': return String(d.getMonth() + 1);
      case 'dddd': return DAY_NAMES[d.getDay()];
      case 'ddd': return DAY_NAMES[d.getDay()].slice(0, 3);
      case 'dd': return pad(d.getDate(), 2);
      case 'd': return String(d.getDate());
      case 'HH': return pad(hour, 2);
      case 'H': return String(hour);
      case 'hh': return pad(h12, 2);
      case 'h': return String(h12);
      case 'mm': return pad(d.getMinutes(), 2);
      case 'm': return String(d.getMinutes());
      case 'ss': return pad(d.getSeconds(), 2);
      case 's': return String(d.getSeconds());
      case 'tt': return hour < 12 ? 'AM' : 'PM';
      case 't': return hour < 12 ? 'A' : 'P';
      case 'zzz': return `${signedHours(offset, 2)}:${pad(Math.abs(offset) % 60, 2)}`;
      case 'zz': return signedHours(offset, 2);
      case 'z': return signedHours(offset, 1);
      case 'K': return isUtcKind(d) ? 'Z' : `${signedHours(offset, 2)}:${pad(Math.abs(offset) % 60, 2)}`;
      default: return tok;
    }
  });
}

export function formatDotNetDate(d: Date, fmt: string): string {
  if (fmt.length === 1) {
    const universal = UNIVERSAL[fmt];
    if (universal !== undefined) {
      return formatCustom(new ZonedDate(d.getTime(), null), universal);
    }
    const standard = STANDARD[fmt];
    if (standard !== undefined) return formatCustom(d, standard);
  }
  return formatCustom(d, fmt);
}
