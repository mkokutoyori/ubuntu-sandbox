import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import type { TcpConnector } from '@/network/core/TcpConnection';

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

function tcpConnectorOf(pc: LinuxPC): TcpConnector {
  return (h, p) => (pc as unknown as { tcpConnect: (h: string, p: number) => Promise<unknown> })
    .tcpConnect(h, p) as ReturnType<TcpConnector>;
}

async function tryAuth(pc: LinuxPC, password: string) {
  const session = new SshSession({
    tcpConnector: tcpConnectorOf(pc),
    vfs: (pc as unknown as { executor: { vfs: unknown } }).executor.vfs as never,
    localUser: 'root',
    localUid: 0,
    localGid: 0,
    knownHostsPath: '/root/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(password),
  });
  const opts = SshConnectOptionsBuilder.create()
    .host('10.0.0.2').user('alice').port(22)
    .strictHostKeyChecking('accept-new').password(password).build();
  const r = await session.connect(opts);
  session.disconnect();
  return r;
}

describe('SSH server — MaxAuthTries enforcement', () => {
  it('rejects auth after MaxAuthTries failed attempts on one connection', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/ssh/sshd_config', 'MaxAuthTries 2\nPasswordAuthentication yes\n', 0, 0, 0o022);

    const r1 = await tryAuth(pc, 'wrong-1');
    const r2 = await tryAuth(pc, 'wrong-2');
    const r3 = await tryAuth(pc, 'wrong-3');

    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(false);
  });

  it('still accepts the correct password before the cap is reached', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/ssh/sshd_config', 'MaxAuthTries 6\nPasswordAuthentication yes\n', 0, 0, 0o022);

    const r = await tryAuth(pc, 'admin');
    expect(r.ok).toBe(true);
  });
});
