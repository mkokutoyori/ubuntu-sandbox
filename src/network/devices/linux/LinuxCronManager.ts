import { CronSchedule, CronJob } from './cron/CronSchedule';
import { parseCrontab } from './cron/CrontabParser';

export { CronSchedule, CronJob } from './cron/CronSchedule';
export type { CrontabEntry, ParsedCrontab } from './cron/CrontabParser';

interface CrontabTable {
  raw: string;
  env: Record<string, string>;
  jobs: CronJob[];
}

export class LinuxCronManager {
  private readonly tables = new Map<string, CrontabTable>();
  private lastUser: string | null = null;

  install(crontabContent: string, user = 'root'): void {
    const parsed = parseCrontab(crontabContent, { withUser: false });
    const jobs = parsed.entries.map((e) =>
      new CronJob(e.schedule, e.command, user, e.rawLine, e.env, `crontabs/${user}`));
    this.tables.set(user, { raw: crontabContent, env: parsed.env, jobs });
    this.lastUser = user;
  }

  private resolveUser(user?: string): string {
    return user ?? this.lastUser ?? 'root';
  }

  list(user?: string): string | null {
    const table = this.tables.get(this.resolveUser(user));
    if (!table) return null;
    const body = table.raw.split('\n').filter((l) => l.trim().length > 0);
    return body.length > 0 ? body.join('\n') : null;
  }

  has(user: string): boolean {
    return this.tables.has(user);
  }

  remove(user?: string): void {
    const u = this.resolveUser(user);
    this.tables.delete(u);
    if (this.lastUser === u) this.lastUser = null;
  }

  getJobs(user?: string): readonly CronJob[] {
    return this.tables.get(this.resolveUser(user))?.jobs ?? [];
  }

  getEnv(user?: string): Record<string, string> {
    return this.tables.get(this.resolveUser(user))?.env ?? {};
  }

  users(): string[] {
    return [...this.tables.keys()];
  }

  allJobs(): CronJob[] {
    const out: CronJob[] = [];
    for (const table of this.tables.values()) out.push(...table.jobs);
    return out;
  }

  dueJobs(at: Date = new Date()): CronJob[] {
    return this.allJobs().filter((j) => !j.schedule.isReboot && j.schedule.isDue(at));
  }

  rebootJobs(): CronJob[] {
    return this.allJobs().filter((j) => j.schedule.isReboot);
  }
}
