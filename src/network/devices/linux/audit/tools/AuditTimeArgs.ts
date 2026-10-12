import type { AuditToolHost, DateStyle, LocalTime, ToolOutput } from './AuditToolHost';

const SECONDS_IN_DAY = 24 * 60 * 60;

const KEYWORDS = ['now', 'recent', 'this-hour', 'boot', 'today', 'yesterday', 'this-week', 'week-ago', 'this-month', 'this-year'] as const;
type Keyword = (typeof KEYWORDS)[number];

type Tm = Omit<LocalTime, 'wday' | 'yday'> & { hasYear: boolean };

export function lookupTime(name: string): Keyword | null {
  return (KEYWORDS as readonly string[]).includes(name) ? (name as Keyword) : null;
}

function clearTm(): Tm {
  return { year: 1900, mon: 0, mday: 0, hour: 0, min: 0, sec: 0, hasYear: false };
}

function replaceTime(target: Tm, source: LocalTime): void {
  target.sec = source.sec;
  target.min = source.min;
  target.hour = source.hour;
}

function replaceDate(target: Tm, source: LocalTime): void {
  target.mday = source.mday;
  target.mon = source.mon;
  target.year = source.year;
}

function twoDigitYear(yy: number): number {
  return yy < 69 ? 2000 + yy : 1900 + yy;
}

function strptimeDate(text: string, style: DateStyle, into: Tm): string | null {
  const patterns: Record<DateStyle, RegExp> = {
    mdy2: /^\s*(\d{1,2})\/(\d{1,2})\/(\d{1,2})/,
    mdy4: /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/,
    dmy4: /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/,
  };
  const m = patterns[style].exec(text);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  const c = parseInt(m[3], 10);
  const month = style === 'dmy4' ? b : a;
  const day = style === 'dmy4' ? a : b;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  into.mon = month - 1;
  into.mday = day;
  into.year = style === 'mdy2' ? twoDigitYear(c) : c;
  into.hasYear = true;
  return text.slice(m[0].length);
}

function strptimeTime(text: string, into: Tm): string | null {
  const m = /^\s*(\d{1,2}):(\d{1,2}):(\d{1,2})/.exec(text);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  const se = parseInt(m[3], 10);
  if (h > 23 || mi > 59 || se > 61) return null;
  into.hour = h;
  into.min = mi;
  into.sec = se;
  return text.slice(m[0].length);
}

export class AuditTimeArgs {
  startTime = 0;
  endTime = 0;

  constructor(private readonly host: AuditToolHost, private readonly out: ToolOutput) {}

  private now(): LocalTime {
    return this.host.localTime(this.host.nowSec());
  }

  private applyKeyword(keyword: Keyword, d: Tm): number {
    const nowSec = this.host.nowSec();
    const tv = this.host.localTime(nowSec);
    switch (keyword) {
      case 'now': replaceTime(d, tv); replaceDate(d, tv); break;
      case 'recent': { const t = this.host.localTime(nowSec - 600); replaceTime(d, t); replaceDate(d, t); break; }
      case 'this-hour': d.sec = 0; d.min = 0; d.hour = tv.hour; break;
      case 'boot': {
        const t = this.host.localTime(nowSec - Math.floor(this.host.uptimeSec() + 0.5));
        replaceTime(d, t);
        replaceDate(d, t);
        break;
      }
      case 'today': d.sec = 0; d.min = 0; d.hour = 0; replaceDate(d, tv); break;
      case 'yesterday': d.sec = 0; d.min = 0; d.hour = 0; replaceDate(d, this.host.localTime(nowSec - SECONDS_IN_DAY)); break;
      case 'this-week': d.sec = 0; d.min = 0; d.hour = 0; replaceDate(d, this.host.localTime(nowSec - tv.wday * SECONDS_IN_DAY)); break;
      case 'week-ago': d.sec = 0; d.min = 0; d.hour = 0; replaceDate(d, this.host.localTime(nowSec - 7 * SECONDS_IN_DAY)); break;
      case 'this-month': d.sec = 0; d.min = 0; d.hour = 0; replaceDate(d, tv); d.mday = 1; break;
      case 'this-year': d.sec = 0; d.min = 0; d.hour = 0; replaceDate(d, tv); d.mday = 1; d.mon = 0; break;
    }
    d.hasYear = true;
    return 0;
  }

  private toEpoch(d: Tm): number {
    return this.host.mktime({ year: d.year, mon: d.mon, mday: d.mday, hour: d.hour, min: d.min, sec: d.sec });
  }

  private timeText(ti: string): string {
    return ti.length <= 5 ? `${ti}:00` : ti;
  }

  start(da: string | null, ti: string | null): number {
    const d = clearTm();
    let skipToSet = false;
    if (da === null) {
      const n = this.now();
      replaceTime(d, n);
      replaceDate(d, n);
      d.hasYear = true;
    } else {
      const keyword = lookupTime(da);
      if (keyword === null) {
        const rest = strptimeDate(da, this.host.dateStyle(), d);
        if (rest === null) {
          this.out.eprintf(`Invalid start date (${da}). Month, Day, and Year are required.\n`);
          return 1;
        }
        if (rest !== '') {
          this.out.eprintf(`Error parsing start date (${da})\n`);
          return 1;
        }
        this.startTime = this.toEpoch(d);
      } else {
        this.applyKeyword(keyword, d);
        if ((keyword === 'recent' || keyword === 'now' || keyword === 'this-hour' || keyword === 'boot')
          && (ti === null || ti === '00:00:00')) skipToSet = true;
      }
    }
    if (!skipToSet) {
      if (ti !== null) {
        const rest = strptimeTime(this.timeText(ti), d);
        if (rest === null) {
          this.out.eprintf(`Invalid start time (${ti}). Hour, Minute, and Second are required.\n`);
          return 1;
        }
        if (rest !== '') {
          this.out.eprintf(`Error parsing start time (${ti})\n`);
          return 1;
        }
      } else {
        Object.assign(d, clearTm());
      }
      if (d.year - 1900 < 104) {
        this.out.eprintf(`Error - year is ${d.year}\n`);
        return -1;
      }
    }
    this.startTime = this.toEpoch(d);
    if (this.startTime === -1) {
      this.out.eprintf('Error converting start time\n');
      return -1;
    }
    return 0;
  }

  end(da: string | null, ti: string | null): number {
    const d = clearTm();
    let skipToSet = false;
    if (da === null) {
      const n = this.now();
      replaceTime(d, n);
      replaceDate(d, n);
      d.hasYear = true;
    } else {
      const keyword = lookupTime(da);
      if (keyword === null) {
        const rest = strptimeDate(da, this.host.dateStyle(), d);
        if (rest === null) {
          this.out.eprintf(`Invalid end date (${da}). Month, Day, and Year are required.\n`);
          return 1;
        }
        if (rest !== '') {
          this.out.eprintf(`Error parsing end date (${da})\n`);
          return 1;
        }
        this.endTime = this.toEpoch(d);
      } else {
        this.applyKeyword(keyword, d);
        if ((keyword === 'recent' || keyword === 'now' || keyword === 'this-hour' || keyword === 'boot')
          && (ti === null || ti === '00:00:00')) skipToSet = true;
        if (keyword === 'today') {
          const n = this.now();
          replaceTime(d, n);
          replaceDate(d, n);
          if (ti === null || ti === '00:00:00') skipToSet = true;
        }
      }
    }
    if (!skipToSet) {
      if (ti !== null) {
        const rest = strptimeTime(this.timeText(ti), d);
        if (rest === null) {
          this.out.eprintf(`Invalid end time (${ti}). Hour, Minute, and Second are required.\n`);
          return 1;
        }
        if (rest !== '') {
          this.out.eprintf(`Error parsing end time (${ti})\n`);
          return 1;
        }
      } else {
        const n = this.now();
        d.hour = n.hour;
        d.min = n.min;
        d.sec = n.sec;
      }
      if (d.year - 1900 < 104) {
        this.out.eprintf(`Error - year is ${d.year}\n`);
        return -1;
      }
    }
    this.endTime = this.toEpoch(d);
    if (this.endTime === -1) {
      this.out.eprintf('Error converting end time\n');
      return -1;
    }
    return 0;
  }
}
