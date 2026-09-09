/**
 * Cron subsystem + firewall block-logging enhancements.
 *
 * Covers:
 *   CF-03  Installing a crontab logs to /var/log/syslog when cron runs
 *   CF-04  ufw-blocked SSH is recorded in /var/log/ufw.log
 *
 * CF-01 et CF-02 vivaient ici en DOUBLE de CM-01..CM-05 et CM-17/CM-18
 * de `cron-model.test.ts`, aux memes instants et aux memes expressions.
 * Le double est retire : le modele de cron se decrit a un seul endroit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
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
    const sw = new GenericSwitch('switch-generic', 'sw');
    new Cable('c1').connect(pc1.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(pc2.getPorts()[0], sw.getPorts()[1]);
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
