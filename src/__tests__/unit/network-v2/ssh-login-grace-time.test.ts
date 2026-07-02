import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import type { TcpConnector, TcpStream } from '@/network/core/TcpConnection';

let scheduler: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
  scheduler = new VirtualTimeScheduler();
  __setDefaultScheduler(scheduler);
});

afterEach(() => { __setDefaultScheduler(null); });

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

async function reload(srv: LinuxServer, sshdBody: string) {
  const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
  vfs.writeFile('/etc/ssh/sshd_config', sshdBody, 0, 0, 0o022);
  await srv.executeCommand('systemctl reload ssh');
}

describe('SSH server — LoginGraceTime enforcement', () => {
  it('drops a connection that never authenticates within LoginGraceTime', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'LoginGraceTime 10\nPasswordAuthentication yes\n');

    const events: Array<{ kind: string; reason?: string }> = [];
    srv.getSshServerContext().events.on('*', (e) => {
      events.push({ kind: e.kind, reason: (e as { reason?: string }).reason });
    });

    const sock = await pc.tcpConnect('10.0.0.2', 22);
    expect(sock).toBeTruthy();
    sock!.write(JSON.stringify({ op: 'hello', clientVersion: 'SSH-2.0-test' }));

    scheduler.advance(15_000);

    const drops = events.filter((e) => e.kind === 'client_disconnected');
    expect(drops.some((e) => e.reason === 'auth_grace_timeout')).toBe(true);
  });

  it('does NOT drop once the client has authenticated, even past LoginGraceTime', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'LoginGraceTime 10\nPasswordAuthentication yes\n');

    const events: Array<{ kind: string; reason?: string }> = [];
    srv.getSshServerContext().events.on('*', (e) => {
      events.push({ kind: e.kind, reason: (e as { reason?: string }).reason });
    });

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

    scheduler.advance(15_000);

    const drops = events.filter((e) => e.kind === 'client_disconnected' && e.reason === 'auth_grace_timeout');
    expect(drops).toHaveLength(0);
    session.disconnect();
  });

  it('disabled when LoginGraceTime is 0 — pre-auth socket stays open', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'LoginGraceTime 0\nPasswordAuthentication yes\n');

    const events: Array<{ kind: string; reason?: string }> = [];
    srv.getSshServerContext().events.on('*', (e) => {
      events.push({ kind: e.kind, reason: (e as { reason?: string }).reason });
    });

    const sock = (await pc.tcpConnect('10.0.0.2', 22)) as TcpStream | null;
    expect(sock).toBeTruthy();
    sock!.write(JSON.stringify({ op: 'hello', clientVersion: 'SSH-2.0-test' }));

    scheduler.advance(60_000);

    const drops = events.filter((e) => e.kind === 'client_disconnected' && e.reason === 'auth_grace_timeout');
    expect(drops).toHaveLength(0);
  });
});
