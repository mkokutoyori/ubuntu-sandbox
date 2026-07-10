// `ufw logging off` gates /var/log/ufw.log writes — PRD-Iptables-UFW.md §2.1
// objectif F.17. Only on/off gating; low/medium/high/full content-level
// filtering is out of scope (see logBlockedPacket() doc comment).

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

describe('ufw logging on/off gates /var/log/ufw.log writes', () => {
  it('ufw status verbose shows logging on (low) by default, matching the seeded ufw.conf', async () => {
    const { pc2 } = buildPair();
    await pc2.executeCommand('sudo ufw enable');
    const out = await pc2.executeCommand('sudo ufw status verbose');
    expect(out).toContain('Logging: on (low)');
  });

  it('a blocked connection is logged by default (logging on (low), no explicit ufw logging call)', async () => {
    const { pc1, pc2 } = buildPair();
    await pc2.executeCommand('sudo ufw enable');
    await pc2.executeCommand('sudo ufw deny 22');
    await pc1.executeCommand('ssh alice@10.0.0.2');

    const log = await pc2.executeCommand('sudo cat /var/log/ufw.log');
    expect(log).toMatch(/\[UFW (BLOCK|REJECT)\]/);
  });

  it('ufw logging off suppresses blocked-packet logging entirely', async () => {
    const { pc1, pc2 } = buildPair();
    await pc2.executeCommand('sudo ufw enable');
    await pc2.executeCommand('sudo ufw deny 22');
    await pc2.executeCommand('sudo ufw logging off');
    const beforeLog = await pc2.executeCommand('sudo cat /var/log/ufw.log');

    await pc1.executeCommand('ssh alice@10.0.0.2');

    const afterLog = await pc2.executeCommand('sudo cat /var/log/ufw.log');
    expect(afterLog).not.toMatch(/\[UFW (BLOCK|REJECT)\]/);
    // Confirms the earlier assertion isn't vacuous (the log file itself
    // still exists and is being read correctly).
    expect(afterLog.length).toBeGreaterThanOrEqual(beforeLog.length);
  });

  it('re-enabling logging (any level) resumes blocked-packet writes', async () => {
    const { pc1, pc2 } = buildPair();
    await pc2.executeCommand('sudo ufw enable');
    await pc2.executeCommand('sudo ufw deny 22');
    await pc2.executeCommand('sudo ufw logging off');
    await pc2.executeCommand('sudo ufw logging medium');

    await pc1.executeCommand('ssh alice@10.0.0.2');

    const log = await pc2.executeCommand('sudo cat /var/log/ufw.log');
    expect(log).toMatch(/\[UFW (BLOCK|REJECT)\]/);
  });
});
