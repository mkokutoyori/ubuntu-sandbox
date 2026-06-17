import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Vfs {
  writeFile(p: string, c: string, uid: number, gid: number, umask: number, append?: boolean): boolean;
  readFile(p: string): string | null;
  exists(p: string): boolean;
}
function vfsOf(pc: LinuxPC): Vfs {
  return (pc as unknown as { executor: { vfs: Vfs } }).executor.vfs;
}
const future = new Date(2030, 0, 1, 12, 0);

let pc: LinuxPC;
beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
});

describe('cron integration — crontab command + VFS', () => {
  it('CI-01 install via stdin round-trips through crontab -l and the spool file', async () => {
    await pc.executeCommand('echo "*/5 * * * * /bin/echo hi" | crontab -');
    expect(await pc.executeCommand('crontab -l')).toContain('*/5 * * * * /bin/echo hi');
    expect(vfsOf(pc).readFile('/var/spool/cron/crontabs/user')).toContain('/bin/echo hi');
  });

  it('CI-02 crontab -r removes the crontab and its spool file', async () => {
    await pc.executeCommand('echo "* * * * * /bin/true" | crontab -');
    await pc.executeCommand('crontab -r');
    expect(await pc.executeCommand('crontab -l')).toContain('no crontab for');
    expect(vfsOf(pc).exists('/var/spool/cron/crontabs/user')).toBe(false);
  });

  it('CI-03 installs from a named file', async () => {
    await pc.executeCommand('echo "0 0 * * * /bin/daily" > /tmp/mycron');
    await pc.executeCommand('crontab /tmp/mycron');
    expect(await pc.executeCommand('crontab -l')).toContain('/bin/daily');
  });

  it('CI-04 install from a missing file errors', async () => {
    const out = await pc.executeCommand('crontab /tmp/nope');
    expect(out).toContain('No such file or directory');
  });
});

describe('cron integration — permissions', () => {
  it('CI-05 cron.deny blocks a listed user', async () => {
    vfsOf(pc).writeFile('/etc/cron.deny', 'user\n', 0, 0, 0o022);
    expect(await pc.executeCommand('crontab -l')).toContain('not allowed to use this program');
  });

  it('CI-06 cron.allow restricts to listed users', async () => {
    vfsOf(pc).writeFile('/etc/cron.allow', 'root\n', 0, 0, 0o022);
    expect(await pc.executeCommand('crontab -l')).toContain('not allowed to use this program');
  });

  it('CI-07 -u for another user without privilege is refused', async () => {
    expect(await pc.executeCommand('crontab -u root -l')).toContain('must be privileged');
  });

  it('CI-08 -u for an unknown user is refused', async () => {
    expect(await pc.executeCommand('sudo crontab -u ghost -l')).toContain("user 'ghost' unknown");
  });
});

describe('cron integration — daemon execution', () => {
  it('CI-09 a due job runs and is logged as CMD', async () => {
    await pc.executeCommand('echo "* * * * * /bin/true" | crontab -');
    pc.cronTick(future);
    expect(await pc.executeCommand('grep CMD /var/log/syslog')).toContain('/bin/true');
  });

  it('CI-10 a due job mails its output to the owner', async () => {
    await pc.executeCommand('echo "* * * * * echo cron-output-line" | crontab -');
    pc.cronTick(future);
    const mail = vfsOf(pc).readFile('/var/mail/user');
    expect(mail).toContain('cron-output-line');
    expect(mail).toMatch(/Cron <user@/);
  });

  it('CI-11 MAILTO="" suppresses cron mail delivery', async () => {
    vfsOf(pc).writeFile('/tmp/cf', 'MAILTO=""\n* * * * * echo noise\n', 1000, 1000, 0o022);
    await pc.executeCommand('crontab /tmp/cf');
    const before = vfsOf(pc).readFile('/var/mail/user') ?? '';
    pc.cronTick(future);
    const after = vfsOf(pc).readFile('/var/mail/user') ?? '';
    expect(after).toBe(before);
    expect(after).not.toContain('noise');
  });

  it('CI-12 the job sees cron environment (LOGNAME)', async () => {
    await pc.executeCommand('echo "* * * * * echo \\$LOGNAME > /tmp/who" | crontab -');
    pc.cronTick(future);
    expect(await pc.executeCommand('cat /tmp/who')).toContain('user');
  });

  it('CI-13 a stopped cron service does not run jobs', async () => {
    await pc.executeCommand('echo "* * * * * touch /tmp/should-not-exist" | crontab -');
    await pc.executeCommand('systemctl stop cron');
    pc.cronTick(future);
    expect(vfsOf(pc).exists('/tmp/should-not-exist')).toBe(false);
  });

  it('CI-14 @reboot jobs run when cron (re)starts', async () => {
    await pc.executeCommand('echo "@reboot touch /tmp/booted" | crontab -');
    await pc.executeCommand('systemctl stop cron');
    pc.cronTick(future);
    await pc.executeCommand('systemctl start cron');
    pc.cronTick(new Date(2030, 0, 1, 12, 1));
    expect(vfsOf(pc).exists('/tmp/booted')).toBe(true);
  });
});

describe('cron integration — run-parts and periodic directories', () => {
  it('CI-15 run-parts executes every script in a directory', async () => {
    await pc.executeCommand('mkdir -p /tmp/parts');
    await pc.executeCommand('echo "touch /tmp/part-ran" > /tmp/parts/job1');
    await pc.executeCommand('run-parts /tmp/parts');
    expect(vfsOf(pc).exists('/tmp/part-ran')).toBe(true);
  });

  it('CI-16 run-parts --test lists without executing', async () => {
    await pc.executeCommand('mkdir -p /tmp/parts2');
    await pc.executeCommand('echo "touch /tmp/nope2" > /tmp/parts2/job1');
    const out = await pc.executeCommand('run-parts --test /tmp/parts2');
    expect(out).toContain('/tmp/parts2/job1');
    expect(vfsOf(pc).exists('/tmp/nope2')).toBe(false);
  });

  it('CI-17 a script in /etc/cron.daily runs via the system crontab at 06:25', async () => {
    vfsOf(pc).writeFile('/etc/cron.daily/report', 'touch /tmp/daily-ran\n', 0, 0, 0o022);
    pc.cronTick(new Date(2030, 0, 1, 6, 25));
    expect(vfsOf(pc).exists('/tmp/daily-ran')).toBe(true);
  });

  it('CI-18 an /etc/cron.d entry runs with its declared user', async () => {
    vfsOf(pc).writeFile('/etc/cron.d/job', '* * * * * root echo crond-line > /tmp/crond-out\n', 0, 0, 0o022);
    pc.cronTick(future);
    expect(await pc.executeCommand('cat /tmp/crond-out')).toContain('crond-line');
  });
});
