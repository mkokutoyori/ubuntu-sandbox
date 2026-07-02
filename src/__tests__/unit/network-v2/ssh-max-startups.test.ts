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

async function reload(srv: LinuxServer, sshdBody: string) {
  const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
  vfs.writeFile('/etc/ssh/sshd_config', sshdBody, 0, 0, 0o022);
  await srv.executeCommand('systemctl reload ssh');
}

function tcpConnectorOf(pc: LinuxPC): TcpConnector {
  return (h, p) => (pc as unknown as { tcpConnect: (h: string, p: number) => Promise<unknown> })
    .tcpConnect(h, p) as ReturnType<TcpConnector>;
}

describe('SSH server — MaxStartups pre-auth concurrency cap', () => {
  it('refuses a second pre-auth connection when MaxStartups 1:100:2 with 1 already pending', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'MaxStartups 1:100:2\nPasswordAuthentication yes\n');

    const dropReasons: string[] = [];
    srv.getSshServerContext().events.on('client_disconnected', (e) => {
      dropReasons.push((e as { reason?: string }).reason ?? '');
    });

    // 1st: TCP connect + send hello, leave it pending (no auth) → counter stays 1.
    const sock1 = await pc.tcpConnect('10.0.0.2', 22);
    expect(sock1).toBeTruthy();
    sock1!.write(JSON.stringify({ op: 'hello', clientVersion: 'SSH-2.0-test' }));

    // 2nd: should be refused at register time. The TCP connect itself succeeds
    // (server is listening), but the handler immediately closes.
    let secondClosed = false;
    const sock2 = await pc.tcpConnect('10.0.0.2', 22);
    sock2?.onClose?.(() => { secondClosed = true; });
    sock2?.write(JSON.stringify({ op: 'hello', clientVersion: 'SSH-2.0-test' }));

    expect(secondClosed || dropReasons.some((r) => r === 'too_many_failures')).toBe(true);
  });

  it('accepts a connection when count drops below MaxStartups.start', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'MaxStartups 1:100:2\nPasswordAuthentication yes\n');

    // Authenticate fully — counter goes 0→1→0 (auth_success decrements).
    const s = new SshSession({
      tcpConnector: tcpConnectorOf(pc),
      vfs: (pc as unknown as { executor: { vfs: unknown } }).executor.vfs as never,
      localUser: 'root', localUid: 0, localGid: 0,
      knownHostsPath: '/root/.ssh/known_hosts',
      interactionHandler: new SilentSshInteractionHandler('admin'),
    });
    const r = await s.connect(SshConnectOptionsBuilder.create()
      .host('10.0.0.2').user('alice').port(22)
      .strictHostKeyChecking('accept-new').password('admin').build());
    expect(r.ok).toBe(true);
    s.disconnect();
  });

  it('MaxStartups defaults (start=10) — sequential authed sessions all succeed', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'PasswordAuthentication yes\n');

    for (let i = 0; i < 3; i++) {
      const s = new SshSession({
        tcpConnector: tcpConnectorOf(pc),
        vfs: (pc as unknown as { executor: { vfs: unknown } }).executor.vfs as never,
        localUser: 'root', localUid: 0, localGid: 0,
        knownHostsPath: '/root/.ssh/known_hosts',
        interactionHandler: new SilentSshInteractionHandler('admin'),
      });
      const r = await s.connect(SshConnectOptionsBuilder.create()
        .host('10.0.0.2').user('alice').port(22)
        .strictHostKeyChecking('accept-new').password('admin').build());
      expect(r.ok).toBe(true);
      s.disconnect();
    }
  });
});
