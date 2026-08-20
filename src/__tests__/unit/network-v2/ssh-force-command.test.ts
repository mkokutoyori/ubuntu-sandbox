import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function buildPair() {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  const um = (srv as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void;
    setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'admin');
  return { pc, srv };
}

async function reload(srv: LinuxServer, sshdBody: string) {
  const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
  vfs.writeFile('/etc/ssh/sshd_config', sshdBody, 0, 0, 0o022);
  await srv.executeCommand('systemctl reload ssh');
}

describe('SSH server — ForceCommand directive', () => {
  it('replaces the user-supplied command with the configured one (exec mode)', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'ForceCommand whoami\nPasswordAuthentication yes\n');
    const out = await pc.executeCommand('ssh alice@10.0.0.2 echo hello');
    expect(out).toMatch(/^alice/m);
    expect(out).not.toMatch(/hello/);
  });

  it('exposes the user’s original command via $SSH_ORIGINAL_COMMAND', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'ForceCommand echo "got: $SSH_ORIGINAL_COMMAND"\nPasswordAuthentication yes\n');
    const out = await pc.executeCommand('ssh alice@10.0.0.2 rm -rf /etc');
    expect(out).toMatch(/got: rm -rf \/etc/);
  });

  it('runs the forced command also for interactive login (no remote command)', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'ForceCommand whoami\nPasswordAuthentication yes\n');
    const out = await pc.executeCommand('ssh alice@10.0.0.2');
    expect(out).toMatch(/^alice/m);
    expect(out).not.toMatch(/Welcome to Ubuntu/);
  });

  it('with no ForceCommand, the user’s command runs as-is', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'PasswordAuthentication yes\n');
    const out = await pc.executeCommand('ssh alice@10.0.0.2 echo hello');
    expect(out).toMatch(/^hello/m);
  });
});
