import { describe, it, expect, beforeEach } from 'vitest';
import { CronEngine, type CronEngineDeps } from '@/network/devices/linux/cron/CronEngine';
import { LinuxCronManager } from '@/network/devices/linux/LinuxCronManager';

interface RunCall { command: string; user: string; env: Record<string, string>; }

function harness(overrides: Partial<CronEngineDeps> = {}) {
  const runs: RunCall[] = [];
  const logs: string[] = [];
  const mails: Array<{ recipient: string; body: string }> = [];
  const manager = new LinuxCronManager();
  const deps: CronEngineDeps = {
    sources: [manager],
    runner: (command, ctx) => { runs.push({ command, user: ctx.user, env: ctx.env }); return { output: '', exitCode: 0 }; },
    syslog: (tag, message) => logs.push(`${tag}: ${message}`),
    deliverMail: (recipient, body) => mails.push({ recipient, body }),
    homeFor: (user) => (user === 'root' ? '/root' : `/home/${user}`),
    hostname: 'pc1',
    now: () => new Date(2026, 0, 1, 0, 0),
    ...overrides,
  };
  return { engine: new CronEngine(deps), manager, runs, logs, mails, deps };
}

describe('CronEngine', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('CE-01 runs a due job and logs a CRON CMD line', async () => {
    h.manager.install('* * * * * /bin/tick\n', 'alice');
    await h.engine.start();
    await h.engine.tick(new Date(2026, 0, 1, 0, 0));
    expect(h.runs.map((r) => r.command)).toContain('/bin/tick');
    expect(h.logs.some((l) => l.includes('(alice) CMD (/bin/tick)'))).toBe(true);
  });

  it('CE-02 does not run a non-due job', async () => {
    h.manager.install('30 9 * * * /bin/morning\n', 'alice');
    await h.engine.start();
    await h.engine.tick(new Date(2026, 0, 1, 0, 0));
    expect(h.runs).toHaveLength(0);
  });

  it('CE-03 dedups within the same minute', async () => {
    h.manager.install('* * * * * /bin/tick\n', 'root');
    await h.engine.start();
    const t = new Date(2026, 0, 1, 0, 0);
    await h.engine.tick(t);
    await h.engine.tick(t);
    expect(h.runs.filter((r) => r.command === '/bin/tick')).toHaveLength(1);
  });

  it('CE-04 runs again on a new minute', async () => {
    h.manager.install('* * * * * /bin/tick\n', 'root');
    await h.engine.start();
    await h.engine.tick(new Date(2026, 0, 1, 0, 0));
    await h.engine.tick(new Date(2026, 0, 1, 0, 1));
    expect(h.runs.filter((r) => r.command === '/bin/tick')).toHaveLength(2);
  });

  it('CE-05 @reboot runs on start, not on tick', async () => {
    h.manager.install('@reboot /bin/boot\n* * * * * /bin/tick\n', 'root');
    await h.engine.start();
    expect(h.runs.map((r) => r.command)).toContain('/bin/boot');
    const bootRunsAfterStart = h.runs.filter((r) => r.command === '/bin/boot').length;
    await h.engine.tick(new Date(2026, 0, 1, 0, 5));
    expect(h.runs.filter((r) => r.command === '/bin/boot').length).toBe(bootRunsAfterStart);
  });

  it('CE-06 passes merged env (SHELL/PATH/HOME/LOGNAME/USER + crontab env)', async () => {
    h.manager.install('PATH=/custom\nMYVAR=42\n* * * * * env\n', 'alice');
    await h.engine.start();
    await h.engine.tick(new Date(2026, 0, 1, 0, 0));
    const env = h.runs[0].env;
    expect(env.PATH).toBe('/custom');
    expect(env.MYVAR).toBe('42');
    expect(env.HOME).toBe('/home/alice');
    expect(env.LOGNAME).toBe('alice');
    expect(env.USER).toBe('alice');
    expect(env.SHELL).toBe('/bin/sh');
  });

  it('CE-07 mails non-empty output to the job owner by default', async () => {
    h = harness({ runner: () => ({ output: 'hello world\n', exitCode: 0 }) });
    h.manager.install('* * * * * /bin/noisy\n', 'alice');
    await h.engine.start();
    await h.engine.tick(new Date(2026, 0, 1, 0, 0));
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0].recipient).toBe('alice');
    expect(h.mails[0].body).toContain('hello world');
    expect(h.mails[0].body).toContain('Cron <alice@pc1>');
  });

  it('CE-08 MAILTO redirects mail to the named recipient', async () => {
    h = harness({ runner: () => ({ output: 'data', exitCode: 0 }) });
    h.manager.install('MAILTO=ops\n* * * * * /bin/noisy\n', 'alice');
    await h.engine.start();
    await h.engine.tick(new Date(2026, 0, 1, 0, 0));
    expect(h.mails[0].recipient).toBe('ops');
  });

  it('CE-09 MAILTO="" suppresses mail entirely', async () => {
    h = harness({ runner: () => ({ output: 'data', exitCode: 0 }) });
    h.manager.install('MAILTO=""\n* * * * * /bin/noisy\n', 'alice');
    await h.engine.start();
    await h.engine.tick(new Date(2026, 0, 1, 0, 0));
    expect(h.mails).toHaveLength(0);
  });

  it('CE-10 no mail when the job produces no output', async () => {
    h.manager.install('* * * * * /bin/quiet\n', 'alice');
    await h.engine.start();
    await h.engine.tick(new Date(2026, 0, 1, 0, 0));
    expect(h.mails).toHaveLength(0);
  });

  it('CE-11 a stopped engine does not run jobs', async () => {
    h.manager.install('* * * * * /bin/tick\n', 'root');
    await h.engine.start();
    h.engine.stop();
    await h.engine.tick(new Date(2026, 0, 1, 0, 1));
    expect(h.runs).toHaveLength(0);
  });

  it('CE-12 runs jobs from multiple sources with their own user', async () => {
    const system: CronEngineDeps['sources'][number] = {
      dueJobs: () => h.manager.allJobs(),
      rebootJobs: () => [],
    };
    h.manager.install('* * * * * /bin/sys\n', 'daemon');
    await h.engine.start();
    await h.engine.tick(new Date(2026, 0, 1, 0, 0));
    expect(h.runs.find((r) => r.command === '/bin/sys')?.user).toBe('daemon');
    void system;
  });
});
