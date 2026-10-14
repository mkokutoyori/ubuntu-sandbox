/**
 * Probe: `ssh -W host:port` and `-o ProxyCommand=` are evaluated, not stored.
 *
 * Measured with src/network and src/terminal stashed: `-W` was parsed as a
 * value flag and then ignored (the command logged in and ran a shell instead
 * of relaying bytes), and `ProxyCommand` was accepted by the option parser
 * and never consulted, so the TCP leg to the final host started on the
 * client itself.
 *
 *   fall before : '-W relays the target banner through the jump host'
 *   fall before : '-W: the connection to the target starts on the jump host'
 *   fall before : '-W refused by AllowTcpForwarding no'
 *   fall before : 'a bad -W specification is refused'
 *   fall before : 'ProxyCommand ssh -W: the final TCP leg starts on the jump host'
 *   fall before : 'a ProxyCommand that fails stops the connection'
 *   fall before : 'a ProxyCommand naming an unknown program fails'
 *   pass both   : 'ProxyCommand nc %h %p still reaches the host' (witness: the
 *                 lab authenticates through a proxy at all)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Lab {
  readonly first: LinuxPC;
  readonly jump: LinuxServer;
  readonly target: LinuxServer;
}

function buildLab(): Lab {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
  const first = new LinuxPC('linux-pc', 'first', 0, 0);
  const jump = new LinuxServer('linux-server', 'jump', 0, 0);
  const target = new LinuxServer('linux-server', 'target', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  [first, jump, target].forEach((d, i) => new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]));
  const mask = new SubnetMask('255.255.255.0');
  first.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  jump.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  target.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  for (const machine of [first, jump, target]) {
    const users = (machine as unknown as { executor: { userMgr: {
      useradd(u: string, o?: object): void; setPassword(u: string, p: string): void;
    } } }).executor.userMgr;
    users.useradd('alice', { m: true, s: '/bin/bash' });
    users.setPassword('alice', 'admin');
  }
  return { first, jump, target };
}

async function authLog(machine: LinuxServer): Promise<string> {
  return machine.executeCommand('sudo cat /var/log/auth.log');
}

describe('ssh -W and ProxyCommand', () => {
  let lab: Lab;
  beforeEach(() => {
    lab = buildLab();
  });

  it('-W relays the target banner through the jump host', async () => {
    const out = await lab.first.executeCommand('ssh -W 10.0.0.3:22 alice@10.0.0.2', 'admin\n');
    expect(out).toMatch(/^SSH-2\.0-OpenSSH/m);
  });

  it('-W: the connection to the target starts on the jump host', async () => {
    await lab.first.executeCommand('ssh -W 10.0.0.3:22 alice@10.0.0.2', 'admin\n');
    const log = await authLog(lab.target);
    expect(log).toMatch(/10\.0\.0\.2/);
    expect(log).not.toMatch(/10\.0\.0\.1\b/);
  });

  it('-W refused by AllowTcpForwarding no', async () => {
    await lab.jump.executeCommand("sudo sh -c 'echo AllowTcpForwarding no >> /etc/ssh/sshd_config'");
    await lab.jump.executeCommand('sudo systemctl reload ssh');
    const out = await lab.first.executeCommand('ssh -W 10.0.0.3:22 alice@10.0.0.2', 'admin\n');
    expect(out).toMatch(/channel 0: open failed: administratively prohibited/);
    expect(out).toMatch(/Stdio forwarding request failed/);
  });

  it('a bad -W specification is refused', async () => {
    const out = await lab.first.executeCommand('ssh -W nonsense alice@10.0.0.2', 'admin\n');
    expect(out).toMatch(/Bad stdio forwarding specification 'nonsense'/);
  });

  it('ProxyCommand nc %h %p still reaches the host', async () => {
    const out = await lab.first.executeCommand(
      'ssh -o ProxyCommand="nc %h %p" alice@10.0.0.3 hostname', 'admin\n');
    expect(out).toMatch(/target/);
  });

  it('ProxyCommand ssh -W: the final TCP leg starts on the jump host', async () => {
    const out = await lab.first.executeCommand(
      'ssh -o ProxyCommand="ssh -W %h:%p alice@10.0.0.2" alice@10.0.0.3 hostname', 'admin\nadmin\n');
    expect(out).toMatch(/target/);
    const log = await authLog(lab.target);
    expect(log).toMatch(/Accepted password for alice from 10\.0\.0\.2/);
    expect(log).not.toMatch(/from 10\.0\.0\.1\b/);
  });

  it('a ProxyCommand that fails stops the connection', async () => {
    const out = await lab.first.executeCommand(
      'ssh -o ProxyCommand="ssh -W %h:%p alice@10.0.0.9" alice@10.0.0.3 hostname', 'admin\nadmin\n');
    expect(out).not.toMatch(/target/);
    expect(out).toMatch(/Connection closed by UNKNOWN port 65535/);
  });

  it('a ProxyCommand naming an unknown program fails', async () => {
    const out = await lab.first.executeCommand(
      'ssh -o ProxyCommand="frobnicate %h %p" alice@10.0.0.3 hostname', 'admin\n');
    expect(out).toMatch(/frobnicate: not found/);
    expect(out).not.toMatch(/target/);
  });
});
