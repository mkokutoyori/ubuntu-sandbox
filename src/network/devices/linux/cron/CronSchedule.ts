const CRON_MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function substituteNames(field: string, names?: Record<string, number>): string | null {
  if (!/[a-z]/i.test(field)) return field;
  if (!names) return null;
  let ok = true;
  const out = field.toLowerCase().replace(/[a-z]+/g, (token) => {
    const value = names[token];
    if (value === undefined) { ok = false; return token; }
    return String(value);
  });
  return ok ? out : null;
}

function parseField(rawField: string, min: number, max: number, names?: Record<string, number>): Set<number> | null {
  const field = substituteNames(rawField, names);
  if (field === null) return null;
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number.parseInt(stepRaw, 10);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = Number.parseInt(a, 10);
      hi = Number.parseInt(b, 10);
    } else {
      lo = Number.parseInt(range, 10);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      return null;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values.size > 0 ? values : null;
}

export class CronSchedule {
  private constructor(
    private readonly minutes: ReadonlySet<number>,
    private readonly hours: ReadonlySet<number>,
    private readonly daysOfMonth: ReadonlySet<number>,
    private readonly months: ReadonlySet<number>,
    private readonly daysOfWeek: ReadonlySet<number>,
    private readonly domRestricted: boolean,
    private readonly dowRestricted: boolean,
    readonly isReboot: boolean,
  ) {}

  static reboot(): CronSchedule {
    const none = new Set<number>();
    return new CronSchedule(none, none, none, none, none, false, false, true);
  }

  static parse(expr: string): CronSchedule | null {
    const trimmed = expr.trim().toLowerCase();
    if (trimmed === '@reboot') return CronSchedule.reboot();
    const expanded = CRON_MACROS[trimmed] ?? expr.trim();
    const f = expanded.split(/\s+/);
    if (f.length !== 5) return null;
    const minutes = parseField(f[0], 0, 59);
    const hours = parseField(f[1], 0, 23);
    const daysOfMonth = parseField(f[2], 1, 31);
    const months = parseField(f[3], 1, 12, MONTH_NAMES);
    const daysOfWeek = parseField(f[4], 0, 7, DOW_NAMES);
    if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;
    const normalizedDow = new Set<number>(daysOfWeek);
    if (normalizedDow.has(7)) normalizedDow.add(0);
    return new CronSchedule(
      minutes, hours, daysOfMonth, months, normalizedDow,
      f[2] !== '*', f[4] !== '*', false,
    );
  }

  isDue(at: Date): boolean {
    if (this.isReboot) return false;
    if (!this.minutes.has(at.getMinutes())) return false;
    if (!this.hours.has(at.getHours())) return false;
    if (!this.months.has(at.getMonth() + 1)) return false;
    const dow = at.getDay();
    const dowMatch = this.daysOfWeek.has(dow);
    const domMatch = this.daysOfMonth.has(at.getDate());
    if (this.domRestricted && this.dowRestricted) return domMatch || dowMatch;
    if (this.domRestricted) return domMatch;
    if (this.dowRestricted) return dowMatch;
    return true;
  }
}

export class CronJob {
  constructor(
    readonly schedule: CronSchedule,
    readonly command: string,
    readonly user: string,
    readonly rawLine: string,
    readonly env: Record<string, string> = {},
    readonly source: string = '',
  ) {}
}
