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
  const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
  vfs.writeFile('/etc/motd', 'CUSTOM MOTD LINE\n', 0, 0, 0o022);
  return { pc, srv };
}

async function reload(srv: LinuxServer, body: string) {
  const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
  vfs.writeFile('/etc/ssh/sshd_config', body, 0, 0, 0o022);
  await srv.executeCommand('systemctl reload ssh');
}

describe('SSH server — PrintMotd / PrintLastLog gates', () => {
  it('PrintMotd=no suppresses /etc/motd in the interactive banner', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'PasswordAuthentication yes\nPrintMotd no\n');
    const out = await pc.executeCommand('ssh alice@10.0.0.2');
    expect(out).not.toMatch(/CUSTOM MOTD LINE/);
    expect(out).toMatch(/Last login:/);
  });

  it('PrintLastLog=no suppresses the "Last login" line', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'PasswordAuthentication yes\nPrintLastLog no\n');
    const out = await pc.executeCommand('ssh alice@10.0.0.2');
    expect(out).not.toMatch(/Last login:/);
    expect(out).toMatch(/CUSTOM MOTD LINE/);
  });

  it('defaults: both motd and last-login are present', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'PasswordAuthentication yes\n');
    const out = await pc.executeCommand('ssh alice@10.0.0.2');
    expect(out).toMatch(/Last login:/);
    expect(out).toMatch(/CUSTOM MOTD LINE/);
  });
});
