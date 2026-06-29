import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import type { TcpConnector } from '@/network/core/TcpConnection';
import type {
  ISshInteractionHandler,
  SshConnectionInfo,
  HostKeyResponse,
} from '@/network/protocols/ssh/session/ISshInteractionHandler';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

class CapturingHandler implements ISshInteractionHandler {
  infoLines: string[] = [];
  constructor(private readonly password: string = '') {}
  async promptHostKeyConfirmation(): Promise<HostKeyResponse> { return { kind: 'yes' }; }
  async promptPassword(): Promise<string> { return this.password; }
  showInfo(message: string): void { this.infoLines.push(message); }
  showWarning(_m: string): void {}
  onConnected(_i: SshConnectionInfo): void {}
  showAuthFailure(_u: string, _h: string): void {}
}

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

describe('SSH server — pre-auth Banner directive', () => {
  it('surfaces the configured Banner file content to the client before auth', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/issue.net', '*** Authorized access only ***\n', 0, 0, 0o022);
    vfs.writeFile('/etc/ssh/sshd_config', 'Banner /etc/issue.net\nPasswordAuthentication yes\n', 0, 0, 0o022);
    await srv.executeCommand('systemctl reload ssh');

    const handler = new CapturingHandler('admin');
    const session = new SshSession({
      tcpConnector: tcpConnectorOf(pc),
      vfs: (pc as unknown as { executor: { vfs: unknown } }).executor.vfs as never,
      localUser: 'root', localUid: 0, localGid: 0,
      knownHostsPath: '/root/.ssh/known_hosts',
      interactionHandler: handler,
    });
    await session.connect(SshConnectOptionsBuilder.create()
      .host('10.0.0.2').user('alice').port(22)
      .strictHostKeyChecking('accept-new').password('admin').build());
    session.disconnect();

    expect(handler.infoLines.some((l) => l.includes('Authorized access only'))).toBe(true);
  });

  it('no Banner directive ⇒ no info line is surfaced', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/ssh/sshd_config', 'PasswordAuthentication yes\n', 0, 0, 0o022);

    const handler = new CapturingHandler('admin');
    const session = new SshSession({
      tcpConnector: tcpConnectorOf(pc),
      vfs: (pc as unknown as { executor: { vfs: unknown } }).executor.vfs as never,
      localUser: 'root', localUid: 0, localGid: 0,
      knownHostsPath: '/root/.ssh/known_hosts',
      interactionHandler: handler,
    });
    await session.connect(SshConnectOptionsBuilder.create()
      .host('10.0.0.2').user('alice').port(22)
      .strictHostKeyChecking('accept-new').password('admin').build());
    session.disconnect();

    expect(handler.infoLines.some((l) => l.includes('Authorized'))).toBe(false);
  });
});
