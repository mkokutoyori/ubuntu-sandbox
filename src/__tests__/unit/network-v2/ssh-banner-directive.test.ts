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

function srvVfs(srv: LinuxServer) {
  return (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
}

async function reload(srv: LinuxServer, body: string) {
  srvVfs(srv).writeFile('/etc/ssh/sshd_config', body, 0, 0, 0o022);
  await srv.executeCommand('systemctl reload ssh');
}

describe('SSH server — Banner directive', () => {
  it('shows the file pointed at by Banner instead of /etc/issue.net', async () => {
    const { pc, srv } = await buildPair();
    srvVfs(srv).writeFile('/etc/issue.net', 'OLD ISSUE\n', 0, 0, 0o022);
    srvVfs(srv).writeFile('/etc/my-banner', 'CUSTOM BANNER LINE\n', 0, 0, 0o022);
    await reload(srv, 'PasswordAuthentication yes\nBanner /etc/my-banner\n');

    const out = await pc.executeCommand('ssh alice@10.0.0.2');
    expect(out).toMatch(/CUSTOM BANNER LINE/);
    expect(out).not.toMatch(/OLD ISSUE/);
  });

  it('Banner none suppresses the banner entirely (no /etc/issue.net fallback)', async () => {
    const { pc, srv } = await buildPair();
    srvVfs(srv).writeFile('/etc/issue.net', 'OLD ISSUE\n', 0, 0, 0o022);
    await reload(srv, 'PasswordAuthentication yes\nBanner none\n');

    const out = await pc.executeCommand('ssh alice@10.0.0.2');
    expect(out).not.toMatch(/OLD ISSUE/);
    expect(out).toMatch(/Welcome to Ubuntu/);
  });

  it('no Banner directive falls back to /etc/issue.net (legacy default)', async () => {
    const { pc, srv } = await buildPair();
    srvVfs(srv).writeFile('/etc/issue.net', 'LEGACY ISSUE LINE\n', 0, 0, 0o022);
    await reload(srv, 'PasswordAuthentication yes\n');

    const out = await pc.executeCommand('ssh alice@10.0.0.2');
    expect(out).toMatch(/LEGACY ISSUE LINE/);
  });
});
