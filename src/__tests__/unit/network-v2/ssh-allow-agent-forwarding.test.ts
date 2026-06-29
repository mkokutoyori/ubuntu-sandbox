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

async function reload(srv: LinuxServer, body: string) {
  const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
  vfs.writeFile('/etc/ssh/sshd_config', body, 0, 0, 0o022);
  await srv.executeCommand('systemctl reload ssh');
}

describe('SSH server — AllowAgentForwarding gate', () => {
  it('AllowAgentForwarding=no suppresses SSH_AUTH_SOCK in the remote exec env', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'PasswordAuthentication yes\nAllowAgentForwarding no\n');
    const out = await pc.executeCommand(
      "ssh -A alice@10.0.0.2 'echo got:$SSH_AUTH_SOCK'",
    );
    expect(out).toMatch(/^got:\s*$/m);
  });

  it('AllowAgentForwarding=yes (default) still exposes SSH_AUTH_SOCK on -A', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'PasswordAuthentication yes\nAllowAgentForwarding yes\n');
    const out = await pc.executeCommand(
      "ssh -A alice@10.0.0.2 'echo got:$SSH_AUTH_SOCK'",
    );
    expect(out).toMatch(/got:\/tmp\/ssh-alice\/agent\./);
  });

  it('AllowAgentForwarding=no leaves -A-less connections unaffected', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'PasswordAuthentication yes\nAllowAgentForwarding no\n');
    const out = await pc.executeCommand(
      "ssh alice@10.0.0.2 'echo done'",
    );
    expect(out).toMatch(/^done/m);
    expect(out).not.toMatch(/SSH_AUTH_SOCK/);
  });
});
