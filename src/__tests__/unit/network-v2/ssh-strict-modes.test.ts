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
  return (srv as unknown as { executor: { vfs: {
    mkdirp(p: string, m: number, u: number, g: number): void;
    writeFile(p: string, c: string, u: number, g: number, m: number): void;
  } } }).executor.vfs;
}

async function reload(srv: LinuxServer, body: string) {
  srvVfs(srv).writeFile('/etc/ssh/sshd_config', body, 0, 0, 0o022);
  await srv.executeCommand('systemctl reload ssh');
}

async function installLooseAuthorizedKeys(pc: LinuxPC, srv: LinuxServer) {
  await pc.executeCommand("ssh-keygen -t rsa -N '' -f /root/.ssh/id_rsa");
  const pub = (await pc.executeCommand('cat /root/.ssh/id_rsa.pub')).trim();
  const vfs = srvVfs(srv);
  vfs.mkdirp('/home/alice/.ssh', 0o700, 1000, 1000);
  // umask 0 → file ends up 0o666 (group/world rw) — violates strict modes.
  vfs.writeFile('/home/alice/.ssh/authorized_keys', `${pub}\n`, 1000, 1000, 0);
}

describe('SSH server — StrictModes directive', () => {
  it('default (StrictModes implicit yes) refuses a group-writable authorized_keys', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'PasswordAuthentication no\n');
    await installLooseAuthorizedKeys(pc, srv);

    const out = await pc.executeCommand(
      'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 whoami',
    );
    expect(out).toMatch(/Permission denied/i);
  });

  it('StrictModes=no accepts the same loose authorized_keys', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'PasswordAuthentication no\nStrictModes no\n');
    await installLooseAuthorizedKeys(pc, srv);

    const out = await pc.executeCommand(
      'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 whoami',
    );
    expect(out).toMatch(/^alice\s*$/m);
    expect(out).not.toMatch(/Permission denied/i);
  });
});
