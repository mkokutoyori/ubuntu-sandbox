import { describe, it, expect, beforeEach } from 'vitest';
import { CronSchedule, CronJob, LinuxCronManager } from '@/network/devices/linux/LinuxCronManager';
import { parseCrontab } from '@/network/devices/linux/cron/CrontabParser';
import { cronAllowed } from '@/network/devices/linux/cron/CronPermissions';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

describe('CronSchedule — parsing', () => {
  it('CM-01 parses a five-field expression and rejects malformed ones', () => {
    expect(CronSchedule.parse('0 0 * * *')).not.toBeNull();
    expect(CronSchedule.parse('* * * *')).toBeNull();
    expect(CronSchedule.parse('99 0 * * *')).toBeNull();
    expect(CronSchedule.parse('')).toBeNull();
  });

  it('CM-02 a star schedule is always due (non-reboot)', () => {
    const s = CronSchedule.parse('* * * * *')!;
    expect(s.isDue(new Date(2026, 4, 22, 13, 37))).toBe(true);
    expect(s.isReboot).toBe(false);
  });

  it('CM-03 honours a specific minute and hour', () => {
    const s = CronSchedule.parse('30 9 * * *')!;
    expect(s.isDue(new Date(2026, 4, 22, 9, 30))).toBe(true);
    expect(s.isDue(new Date(2026, 4, 22, 9, 31))).toBe(false);
  });

  it('CM-04 supports steps, ranges and lists', () => {
    expect(CronSchedule.parse('*/15 * * * *')!.isDue(new Date(2026, 0, 1, 0, 45))).toBe(true);
    expect(CronSchedule.parse('0 9-17 * * *')!.isDue(new Date(2026, 0, 1, 12, 0))).toBe(true);
    expect(CronSchedule.parse('0 0 * * 1,3,5')!.isDue(new Date(2026, 0, 5, 0, 0))).toBe(true);
  });

  it('CM-05 expands @daily / @hourly / @weekly / @monthly / @yearly macros', () => {
    expect(CronSchedule.parse('@hourly')!.isDue(new Date(2026, 0, 1, 7, 0))).toBe(true);
    expect(CronSchedule.parse('@daily')!.isDue(new Date(2026, 0, 1, 0, 0))).toBe(true);
    expect(CronSchedule.parse('@daily')!.isDue(new Date(2026, 0, 1, 1, 0))).toBe(false);
    expect(CronSchedule.parse('@weekly')!.isDue(new Date(2026, 0, 4, 0, 0))).toBe(true); // Sunday
    expect(CronSchedule.parse('@monthly')!.isDue(new Date(2026, 0, 1, 0, 0))).toBe(true);
    expect(CronSchedule.parse('@yearly')!.isDue(new Date(2026, 0, 1, 0, 0))).toBe(true);
  });

  it('CM-06 @reboot is never time-due but is flagged', () => {
    const s = CronSchedule.parse('@reboot')!;
    expect(s.isReboot).toBe(true);
    expect(s.isDue(new Date(2026, 0, 1, 0, 0))).toBe(false);
  });

  it('CM-07 accepts month and weekday names', () => {
    expect(CronSchedule.parse('0 0 1 jan *')!.isDue(new Date(2026, 0, 1, 0, 0))).toBe(true);
    expect(CronSchedule.parse('0 0 1 jan *')!.isDue(new Date(2026, 1, 1, 0, 0))).toBe(false);
    expect(CronSchedule.parse('0 0 * * mon')!.isDue(new Date(2026, 0, 5, 0, 0))).toBe(true); // Mon
    expect(CronSchedule.parse('0 0 * * sun')!.isDue(new Date(2026, 0, 4, 0, 0))).toBe(true);
  });

  it('CM-08 treats weekday 7 and 0 both as Sunday', () => {
    expect(CronSchedule.parse('0 0 * * 7')!.isDue(new Date(2026, 0, 4, 0, 0))).toBe(true);
    expect(CronSchedule.parse('0 0 * * 0')!.isDue(new Date(2026, 0, 4, 0, 0))).toBe(true);
  });

  it('CM-09 name ranges and stepped ranges', () => {
    expect(CronSchedule.parse('0 0 * * mon-fri')!.isDue(new Date(2026, 0, 6, 0, 0))).toBe(true); // Tue
    expect(CronSchedule.parse('0 0 * * mon-fri')!.isDue(new Date(2026, 0, 4, 0, 0))).toBe(false); // Sun
    expect(CronSchedule.parse('0 0-23/6 * * *')!.isDue(new Date(2026, 0, 1, 12, 0))).toBe(true);
  });
});

describe('parseCrontab — content parsing', () => {
  it('CM-10 separates comments, blanks, env and jobs (user mode)', () => {
    const r = parseCrontab('# header\n\nSHELL=/bin/bash\nPATH=/usr/bin:/bin\n* * * * * /bin/true\n', { withUser: false });
    expect(r.env.SHELL).toBe('/bin/bash');
    expect(r.env.PATH).toBe('/usr/bin:/bin');
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].command).toBe('/bin/true');
    expect(r.errors).toHaveLength(0);
  });

  it('CM-11 strips quotes from env values and supports MAILTO', () => {
    const r = parseCrontab('MAILTO="alice"\nHOME=\'/root\'\n0 * * * * echo hi\n', { withUser: false });
    expect(r.env.MAILTO).toBe('alice');
    expect(r.env.HOME).toBe('/root');
  });

  it('CM-12 records malformed schedule lines as errors', () => {
    const r = parseCrontab('99 99 * * * /bin/bad\n* * * * * /bin/ok\n', { withUser: false });
    expect(r.errors.length).toBe(1);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].command).toBe('/bin/ok');
  });

  it('CM-13 parses system mode with a user field (/etc/crontab, cron.d)', () => {
    const r = parseCrontab('17 *\t* * *\troot\tcd / && run-parts /etc/cron.hourly\n', { withUser: true });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].user).toBe('root');
    expect(r.entries[0].command).toBe('cd / && run-parts /etc/cron.hourly');
  });

  it('CM-14 parses @reboot and other macros with a command', () => {
    const r = parseCrontab('@reboot /usr/bin/startup\n@daily /usr/bin/rotate\n', { withUser: false });
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0].schedule.isReboot).toBe(true);
    expect(r.entries[1].schedule.isReboot).toBe(false);
  });

  it('CM-15 per-job env snapshot follows declaration order', () => {
    const r = parseCrontab('A=1\n* * * * * one\nA=2\n* * * * * two\n', { withUser: false });
    expect(r.entries[0].env.A).toBe('1');
    expect(r.entries[1].env.A).toBe('2');
  });

  it('CM-16 system macro line carries the user field', () => {
    const r = parseCrontab('@daily backup /usr/bin/backup.sh\n', { withUser: true });
    expect(r.entries[0].user).toBe('backup');
    expect(r.entries[0].command).toBe('/usr/bin/backup.sh');
    expect(r.entries[0].schedule.isReboot).toBe(false);
  });
});

describe('LinuxCronManager — per-user table (backward compatible)', () => {
  it('CM-17 installs, lists and removes a crontab (legacy single-arg semantics)', () => {
    const cron = new LinuxCronManager();
    cron.install('* * * * * /bin/true\n# c\n', 'alice');
    expect(cron.list()).toContain('* * * * * /bin/true');
    expect(cron.getJobs()).toHaveLength(1);
    cron.remove();
    expect(cron.list()).toBeNull();
  });

  it('CM-18 selects jobs due at an instant (legacy)', () => {
    const cron = new LinuxCronManager();
    cron.install('30 9 * * * /bin/morning\n0 * * * * /bin/hourly\n', 'bob');
    const due = cron.dueJobs(new Date(2026, 4, 22, 9, 30));
    expect(due.map((j: CronJob) => j.command)).toContain('/bin/morning');
    expect(due.map((j: CronJob) => j.command)).not.toContain('/bin/hourly');
  });

  it('CM-19 keeps independent per-user tables', () => {
    const cron = new LinuxCronManager();
    cron.install('* * * * * /bin/alice\n', 'alice');
    cron.install('* * * * * /bin/bob\n', 'bob');
    expect(cron.list('alice')).toContain('/bin/alice');
    expect(cron.list('bob')).toContain('/bin/bob');
    cron.remove('alice');
    expect(cron.list('alice')).toBeNull();
    expect(cron.list('bob')).toContain('/bin/bob');
  });

  it('CM-20 dueJobs aggregates across users and tags each job with its user', () => {
    const cron = new LinuxCronManager();
    cron.install('* * * * * /bin/alice\n', 'alice');
    cron.install('* * * * * /bin/bob\n', 'bob');
    const due = cron.dueJobs(new Date(2026, 0, 1, 0, 0));
    const owners = new Set(due.map((j) => j.user));
    expect(owners.has('alice')).toBe(true);
    expect(owners.has('bob')).toBe(true);
  });

  it('CM-21 exposes per-crontab environment and reboot jobs', () => {
    const cron = new LinuxCronManager();
    cron.install('MAILTO=ops\n@reboot /bin/boot\n* * * * * /bin/tick\n', 'root');
    expect(cron.getEnv('root').MAILTO).toBe('ops');
    expect(cron.rebootJobs().map((j) => j.command)).toContain('/bin/boot');
    expect(cron.dueJobs(new Date(2026, 0, 1, 0, 0)).map((j) => j.command)).not.toContain('/bin/boot');
  });

  it('CM-22 jobs carry the env of their crontab', () => {
    const cron = new LinuxCronManager();
    cron.install('PATH=/custom/bin\n* * * * * env\n', 'alice');
    expect(cron.getJobs('alice')[0].env?.PATH).toBe('/custom/bin');
  });
});

describe('cronAllowed — cron.allow / cron.deny', () => {
  let vfs: VirtualFileSystem;
  beforeEach(() => { vfs = new VirtualFileSystem(); });

  it('CM-23 root is always allowed', () => {
    expect(cronAllowed('root', vfs)).toBe(true);
  });

  it('CM-24 with no allow/deny files, everyone is allowed', () => {
    expect(cronAllowed('alice', vfs)).toBe(true);
  });

  it('CM-25 cron.allow restricts to listed users', () => {
    vfs.writeFile('/etc/cron.allow', 'alice\n', 0, 0, 0o022);
    expect(cronAllowed('alice', vfs)).toBe(true);
    expect(cronAllowed('bob', vfs)).toBe(false);
  });

  it('CM-26 cron.deny blocks listed users when no allow file exists', () => {
    vfs.writeFile('/etc/cron.deny', 'bob\n', 0, 0, 0o022);
    expect(cronAllowed('alice', vfs)).toBe(true);
    expect(cronAllowed('bob', vfs)).toBe(false);
  });

  it('CM-27 cron.allow takes precedence over cron.deny', () => {
    vfs.writeFile('/etc/cron.allow', 'alice\n', 0, 0, 0o022);
    vfs.writeFile('/etc/cron.deny', 'alice\n', 0, 0, 0o022);
    expect(cronAllowed('alice', vfs)).toBe(true);
  });
});
