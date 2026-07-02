import { CronJob } from './CronSchedule';
import { parseCrontab } from './CrontabParser';
import type { CronSource } from './CronEngine';

interface SystemCronFs {
  readFile(path: string): string | null;
  listDirectory(path: string): Array<{ name: string }> | null;
}

export class SystemCron implements CronSource {
  constructor(private readonly vfs: SystemCronFs) {}

  private collect(): CronJob[] {
    const jobs: CronJob[] = [];
    this.addFile('/etc/crontab', jobs);
    const dir = this.vfs.listDirectory('/etc/cron.d');
    if (dir) {
      for (const entry of [...dir].sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.')) continue;
        this.addFile(`/etc/cron.d/${entry.name}`, jobs);
      }
    }
    return jobs;
  }

  private addFile(path: string, out: CronJob[]): void {
    const content = this.vfs.readFile(path);
    if (content === null) return;
    const parsed = parseCrontab(content, { withUser: true });
    for (const e of parsed.entries) {
      out.push(new CronJob(e.schedule, e.command, e.user ?? 'root', e.rawLine, e.env, path));
    }
  }

  dueJobs(at: Date): CronJob[] {
    return this.collect().filter((j) => !j.schedule.isReboot && j.schedule.isDue(at));
  }

  rebootJobs(): CronJob[] {
    return this.collect().filter((j) => j.schedule.isReboot);
  }
}
