/**
 * Cron subsystem — crontab storage, schedule evaluation and job firing.
 *
 * `CronSchedule` parses the classic five-field cron expression (plus the
 * common `@hourly` / `@daily` … macros) and answers whether a job is due
 * at a given instant. `CronJob` binds a schedule to a command and owner.
 * `LinuxCronManager` is the per-machine crontab table consulted by the
 * `crontab` command and by the cron daemon when it fires due jobs.
 */

/** Convenience macros accepted in place of the five schedule fields. */
const CRON_MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

/**
 * Parse one cron field into the concrete set of values it admits.
 * Supports a star, step (star slash N), ranges (a-b), ranges with a step,
 * comma-separated lists and bare numbers. Returns `null` when malformed.
 */
function parseField(field: string, min: number, max: number): Set<number> | null {
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

/** A parsed five-field cron schedule. */
export class CronSchedule {
  private constructor(
    private readonly minutes: ReadonlySet<number>,
    private readonly hours: ReadonlySet<number>,
    private readonly daysOfMonth: ReadonlySet<number>,
    private readonly months: ReadonlySet<number>,
    private readonly daysOfWeek: ReadonlySet<number>,
    /** True when both day-of-month and day-of-week are restricted. */
    private readonly domRestricted: boolean,
    private readonly dowRestricted: boolean,
  ) {}

  /** Parse a schedule expression (`min hour dom mon dow` or a `@macro`). */
  static parse(expr: string): CronSchedule | null {
    const trimmed = expr.trim();
    const expanded = CRON_MACROS[trimmed] ?? trimmed;
    const f = expanded.split(/\s+/);
    if (f.length !== 5) return null;
    const minutes = parseField(f[0], 0, 59);
    const hours = parseField(f[1], 0, 23);
    const daysOfMonth = parseField(f[2], 1, 31);
    const months = parseField(f[3], 1, 12);
    // Day-of-week: 0 and 7 both mean Sunday.
    const daysOfWeek = parseField(f[4], 0, 7);
    if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;
    return new CronSchedule(
      minutes, hours, daysOfMonth, months, daysOfWeek,
      f[2] !== '*', f[4] !== '*',
    );
  }

  /** Whether a job with this schedule should run at the given instant. */
  isDue(at: Date): boolean {
    if (!this.minutes.has(at.getMinutes())) return false;
    if (!this.hours.has(at.getHours())) return false;
    if (!this.months.has(at.getMonth() + 1)) return false;
    const dow = at.getDay();
    const dowMatch = this.daysOfWeek.has(dow) || (dow === 0 && this.daysOfWeek.has(7));
    const domMatch = this.daysOfMonth.has(at.getDate());
    // cron's quirk: when both day fields are restricted the job runs if
    // EITHER matches; otherwise the restricted one (if any) must match.
    if (this.domRestricted && this.dowRestricted) return domMatch || dowMatch;
    if (this.domRestricted) return domMatch;
    if (this.dowRestricted) return dowMatch;
    return true;
  }
}

/** A single crontab entry: a schedule, a command and its owner. */
export class CronJob {
  constructor(
    readonly schedule: CronSchedule,
    readonly command: string,
    readonly user: string,
    readonly rawLine: string,
  ) {}
}

/**
 * Per-machine crontab table. Holds the installed crontab verbatim (so
 * `crontab -l` round-trips faithfully) plus the parsed {@link CronJob}s
 * the cron daemon evaluates.
 */
export class LinuxCronManager {
  private rawContent = '';
  private jobs: CronJob[] = [];

  /** Install (replace) the crontab for `user`, parsing its schedule lines. */
  install(crontabContent: string, user = 'root'): void {
    this.rawContent = crontabContent;
    this.jobs = [];
    for (const raw of crontabContent.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const job = LinuxCronManager.parseLine(line, user);
      if (job) this.jobs.push(job);
    }
  }

  /** The crontab content for `crontab -l`, or `null` when none is set. */
  list(): string | null {
    const body = this.rawContent.split('\n').filter((l) => l.trim().length > 0);
    return body.length > 0 ? body.join('\n') : null;
  }

  /** Drop the crontab entirely (`crontab -r`). */
  remove(): void {
    this.rawContent = '';
    this.jobs = [];
  }

  /** Every parsed job in the current crontab. */
  getJobs(): readonly CronJob[] {
    return this.jobs;
  }

  /** The jobs whose schedule is due to run at `at`. */
  dueJobs(at: Date = new Date()): CronJob[] {
    return this.jobs.filter((j) => j.schedule.isDue(at));
  }

  /** Parse one crontab line (5 schedule fields + command) into a job. */
  private static parseLine(line: string, user: string): CronJob | null {
    const m = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/.exec(line);
    if (!m) return null;
    const schedule = CronSchedule.parse(m[1]);
    if (!schedule) return null;
    return new CronJob(schedule, m[2].trim(), user, line);
  }
}
