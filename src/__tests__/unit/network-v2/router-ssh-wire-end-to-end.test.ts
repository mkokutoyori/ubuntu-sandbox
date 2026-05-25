/**
 * End-to-end SSH over TCP from a Linux client to a router (Cisco/Huawei).
 *
 * Uses the same SshSession + tcpConnector pipeline the production UI
 * (LinuxTerminalSession.connectAndEnterSsh) drives, but in pure
 * programmatic form. Asserts the connection authenticates (via the
 * router's NetworkOsCredentialStore-backed RouterSshServerContext) and
 * an exec channel returns the router's native CLI output.
 *
 * Because routers don't initiate TCP we don't model the client side from
 * them — Cisco/Huawei → anything still goes through `device.executeCommand
 * ('ssh ...')` which already covers the cross-vendor matrix.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { isOk } from '@/network/protocols/ssh/Result';
import type { TcpConnector } from '@/network/core/TcpConnection';

const NETMASK = '255.255.255.0';

interface Lan { linux: LinuxPC; cisco: CiscoRouter; huawei: HuaweiRouter; sw: GenericSwitch; }

async function buildLan(): Promise<Lan> {
  EquipmentRegistry.resetInstance();
  const linux  = new LinuxPC('linux-pc', 'linux1', 0, 0);
  const cisco  = new CiscoRouter('cisco1', 0, 0);
  const huawei = new HuaweiRouter('huawei1', 0, 0);
  const sw     = new GenericSwitch('switch-generic', 'core', 8, 0, 0);
  new Cable('c0').connect(linux.getPorts()[0],  sw.getPorts()[0]);
  new Cable('c1').connect(cisco.getPorts()[0],  sw.getPorts()[1]);
  new Cable('c2').connect(huawei.getPorts()[0], sw.getPorts()[2]);

  const mask = new SubnetMask(NETMASK);
  linux.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);

  for (const c of [
    'enable', 'configure terminal', 'hostname cisco1',
    'interface GigabitEthernet0/0',
    `ip address 10.0.0.6 ${NETMASK}`, 'no shutdown', 'end',
  ]) await cisco.executeCommand(c);

  for (const c of [
    'system-view', 'sysname huawei1',
    'interface GigabitEthernet0/0/0',
    `ip address 10.0.0.8 ${NETMASK}`, 'undo shutdown', 'quit', 'quit',
  ]) await huawei.executeCommand(c);

  await linux.executeCommand('ping -c 1 10.0.0.6');
  await linux.executeCommand('ping -c 1 10.0.0.8');
  return { linux, cisco, huawei, sw };
}

function tcpConnectorOf(pc: LinuxPC): TcpConnector {
  const dev = pc as unknown as { tcpConnect: (h: string, p: number) => Promise<unknown> };
  return (host, port) => dev.tcpConnect(host, port) as Promise<never>;
}

async function openSshTo(client: LinuxPC, host: string, user: string, password: string): Promise<SshSession> {
  const vfs = new VirtualFileSystem();
  const session = new SshSession({
    tcpConnector: tcpConnectorOf(client),
    vfs,
    localUser: 'root',
    localUid: 0,
    localGid: 0,
    knownHostsPath: '/root/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(password),
  });
  const builder = SshConnectOptionsBuilder.create()
    .host(host).user(user).port(22).strictHostKeyChecking('accept-new');
  const result = await session.connect(builder.build());
  if (!isOk(result)) throw new Error('connect failed: ' + JSON.stringify(result));
  return session;
}

beforeEach(() => { EquipmentRegistry.resetInstance(); });

describe('SSH over real TCP — Linux client → router daemon', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  it('Linux → Cisco: authenticates alice/alice via password and runs show version', async () => {
    const session = await openSshTo(lan.linux, '10.0.0.6', 'alice', 'alice');
    const channelResult = session.openExecChannel('show version');
    if (!isOk(channelResult)) throw new Error('exec channel failed');
    const channel = channelResult.value;
    const exec = await channel.execute();
    expect(exec.stdout).toMatch(/IOS|Cisco|Version/i);
    channel.close();
    session.disconnect();
  });

  it('Linux → Huawei: authenticates bob/bob and runs display version', async () => {
    const session = await openSshTo(lan.linux, '10.0.0.8', 'bob', 'bob');
    const channelResult = session.openExecChannel('display version');
    if (!isOk(channelResult)) throw new Error('exec channel failed');
    const channel = channelResult.value;
    const exec = await channel.execute();
    expect(exec.stdout).toMatch(/VRP|Huawei|Version/i);
    channel.close();
    session.disconnect();
  });

  it('Linux → Cisco: wrong password is rejected', async () => {
    const vfs = new VirtualFileSystem();
    const session = new SshSession({
      tcpConnector: tcpConnectorOf(lan.linux),
      vfs, localUser: 'root', localUid: 0, localGid: 0,
      knownHostsPath: '/root/.ssh/known_hosts',
      interactionHandler: new SilentSshInteractionHandler('WRONG'),
    });
    const builder = SshConnectOptionsBuilder.create()
      .host('10.0.0.6').user('alice').port(22).strictHostKeyChecking('accept-new');
    const result = await session.connect(builder.build());
    expect(isOk(result)).toBe(false);
  });

  it('Linux → Huawei: unknown user is rejected', async () => {
    const vfs = new VirtualFileSystem();
    const session = new SshSession({
      tcpConnector: tcpConnectorOf(lan.linux),
      vfs, localUser: 'root', localUid: 0, localGid: 0,
      knownHostsPath: '/root/.ssh/known_hosts',
      interactionHandler: new SilentSshInteractionHandler('anything'),
    });
    const builder = SshConnectOptionsBuilder.create()
      .host('10.0.0.8').user('ghost').port(22).strictHostKeyChecking('accept-new');
    const result = await session.connect(builder.build());
    expect(isOk(result)).toBe(false);
  });
});
