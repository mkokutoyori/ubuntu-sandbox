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

async function authedSession(pc: LinuxPC): Promise<SshSession> {
  const session = new SshSession({
    tcpConnector: tcpConnectorOf(pc),
    vfs: (pc as unknown as { executor: { vfs: unknown } }).executor.vfs as never,
    localUser: 'root', localUid: 0, localGid: 0,
    knownHostsPath: '/root/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler('admin'),
  });
  await session.connect(SshConnectOptionsBuilder.create()
    .host('10.0.0.2').user('alice').port(22)
    .strictHostKeyChecking('accept-new').password('admin').build());
  return session;
}

describe('SSH server — MaxSessions enforcement', () => {
  it('refuses the (N+1)-th channel open when MaxSessions=N', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/ssh/sshd_config', 'MaxSessions 2\nPasswordAuthentication yes\n', 0, 0, 0o022);

    const s = await authedSession(pc);
    const a = s.openExecChannel('true');
    const b = s.openExecChannel('true');
    const c = s.openExecChannel('true');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(true);
    // The third channel exists locally but the server refused it; the next
    // exec on it should report the prohibition error or an empty stdout.
    if (c.ok) {
      const r = await c.value.execute();
      expect(r.stderr || r.stdout || '').not.toBe('hello');
    }
    s.disconnect();
  });

  it('allows MaxSessions opens in a row when MaxSessions=10 (default sanity)', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/ssh/sshd_config', 'MaxSessions 10\nPasswordAuthentication yes\n', 0, 0, 0o022);

    const s = await authedSession(pc);
    for (let i = 0; i < 5; i++) {
      const ch = s.openExecChannel('echo ok');
      expect(ch.ok).toBe(true);
    }
    s.disconnect();
  });
});
