/**
 * Cron subsystem + firewall block-logging enhancements.
 *
 * Covers:
 *   CF-01  CronSchedule expression parsing & due evaluation
 *   CF-02  LinuxCronManager crontab table + due-job selection
 *   CF-03  Installing a crontab logs to /var/log/syslog when cron runs
 *   CF-04  ufw-blocked SSH is recorded in /var/log/ufw.log
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CronSchedule, CronJob, LinuxCronManager } from '@/network/devices/linux/LinuxCronManager';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════════
// CF-01 — CronSchedule
// ═══════════════════════════════════════════════════════════════════════

describe('CF-01 — CronSchedule parsing and due evaluation', () => {
  it('parses a five-field expression and rejects malformed ones', () => {
    expect(CronSchedule.parse('0 0 * * *')).not.toBeNull();
    expect(CronSchedule.parse('* * * *')).toBeNull();
    expect(CronSchedule.parse('99 0 * * *')).toBeNull();
  });

  it('a star-everywhere schedule is always due', () => {
    const s = CronSchedule.parse('* * * * *')!;
    expect(s.isDue(new Date(2026, 4, 22, 13, 37))).toBe(true);
  });

  it('honours a specific minute and hour', () => {
    const s = CronSchedule.parse('30 9 * * *')!;
    expect(s.isDue(new Date(2026, 4, 22, 9, 30))).toBe(true);
    expect(s.isDue(new Date(2026, 4, 22, 9, 31))).toBe(false);
    expect(s.isDue(new Date(2026, 4, 22, 10, 30))).toBe(false);
  });

  it('supports steps, ranges and lists', () => {
    expect(CronSchedule.parse('*/15 * * * *')!.isDue(new Date(2026, 0, 1, 0, 45))).toBe(true);
    expect(CronSchedule.parse('*/15 * * * *')!.isDue(new Date(2026, 0, 1, 0, 46))).toBe(false);
    expect(CronSchedule.parse('0 9-17 * * *')!.isDue(new Date(2026, 0, 1, 12, 0))).toBe(true);
    expect(CronSchedule.parse('0 0 * * 1,3,5')!.isDue(new Date(2026, 0, 5, 0, 0))).toBe(true); // Mon
  });

  it('expands @daily / @hourly macros', () => {
    expect(CronSchedule.parse('@hourly')!.isDue(new Date(2026, 0, 1, 7, 0))).toBe(true);
    expect(CronSchedule.parse('@daily')!.isDue(new Date(2026, 0, 1, 0, 0))).toBe(true);
    expect(CronSchedule.parse('@daily')!.isDue(new Date(2026, 0, 1, 1, 0))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CF-02 — LinuxCronManager
// ═══════════════════════════════════════════════════════════════════════

describe('CF-02 — LinuxCronManager crontab table', () => {
  it('installs, lists and removes a crontab', () => {
    const cron = new LinuxCronManager();
    cron.install('* * * * * /bin/true\n# a comment\n', 'alice');
    // `crontab -l` echoes the file verbatim, comments included; only the
    // schedule lines become executable jobs.
    expect(cron.list()).toContain('* * * * * /bin/true');
    expect(cron.getJobs()).toHaveLength(1);
    cron.remove();
    expect(cron.list()).toBeNull();
  });

  it('selects the jobs due at a given instant', () => {
    const cron = new LinuxCronManager();
    cron.install('30 9 * * * /bin/morning\n0 * * * * /bin/hourly\n', 'bob');
    const due = cron.dueJobs(new Date(2026, 4, 22, 9, 30));
    expect(due.map((j: CronJob) => j.command)).toContain('/bin/morning');
    expect(due.map((j: CronJob) => j.command)).not.toContain('/bin/hourly');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CF-03 — crontab install logs to syslog
// ═══════════════════════════════════════════════════════════════════════

describe('CF-03 — cron logs a reload / firing to syslog', () => {
  it('installing a crontab while cron runs logs a RELOAD, and ticking logs the CMD', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('echo "* * * * * /bin/true" | crontab -');
    let out = await pc.executeCommand('tail -100 /var/log/syslog');
    expect(out).toMatch(/cron\[\d+\]/i);
    expect(out).toMatch(/RELOAD \(crontabs\/\w+\)/);

    pc.cronTick(new Date(2030, 0, 1, 12, 0));
    out = await pc.executeCommand('tail -100 /var/log/syslog');
    expect(out).toMatch(/CRON\[\d+\]: \(\w+\) CMD \(\/bin\/true\)/);
  });

  it('no syslog cron line once the cron service is stopped', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('systemctl stop cron');
    await pc.executeCommand('echo "* * * * * /bin/true" | crontab -');
    pc.cronTick(new Date(2030, 0, 1, 12, 0));
    const out = await pc.executeCommand('tail -100 /var/log/syslog');
    expect(out).not.toContain('/bin/true');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CF-04 — firewall block logging
// ═══════════════════════════════════════════════════════════════════════

describe('CF-04 — ufw records blocked SSH in /var/log/ufw.log', () => {
  function buildPair() {
    const pc1 = new LinuxPC('linux-pc', 'pc1');
    const pc2 = new LinuxPC('linux-pc', 'pc2');
    const sw = new GenericSwitch('switch', 'sw');
    new Cable(pc1.getPorts()[0], sw.getPorts()[0]);
    new Cable(pc2.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    pc1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
    pc2.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
    return { pc1, pc2 };
  }

  it('a UFW BLOCK line lands in ufw.log after a denied connection', async () => {
    const { pc1, pc2 } = buildPair();
    await pc2.executeCommand('sudo ufw enable');
    await pc2.executeCommand('sudo ufw deny 22');
    await pc1.executeCommand('ssh alice@10.0.0.2');
    const log = await pc2.executeCommand('sudo cat /var/log/ufw.log');
    expect(log).toMatch(/\[UFW (BLOCK|REJECT)\]/);
    expect(log).toContain('DPT=22');
  });

  it('nothing is logged while ufw is disabled', async () => {
    const { pc1, pc2 } = buildPair();
    await pc1.executeCommand('ssh alice@10.0.0.2');
    const log = await pc2.executeCommand('sudo cat /var/log/ufw.log');
    expect(log).not.toMatch(/\[UFW BLOCK\]/);
  });
});
