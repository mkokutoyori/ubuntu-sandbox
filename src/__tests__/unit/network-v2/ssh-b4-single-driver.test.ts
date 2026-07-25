import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { isOk } from '@/network/protocols/ssh/Result';
import type { ISshShellChannel } from '@/network/protocols/ssh/channels/ISshChannel';
import { installDefaultShells } from '@/shell/registerDefaults';

beforeEach(() => {
  installDefaultShells();
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const MASK = new SubnetMask('255.255.255.0');

interface Lab {
  pc: LinuxPC;
  cisco: CiscoRouter;
  windows: WindowsPC;
}

async function lab(): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'SW');
  const pc = new LinuxPC('linux-pc', 'PC1');
  const cisco = new CiscoRouter('router-cisco', 'R1');
  const windows = new WindowsPC('windows-pc', 'WIN1');

  pc.getPorts()[0].configureIP(new IPAddress('10.0.21.1'), MASK);
  windows.getPorts()[0].configureIP(new IPAddress('10.0.21.4'), MASK);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(windows.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(cisco.getPorts()[0], sw.getPorts()[2]);

  for (const cmd of [
    'enable', 'configure terminal', 'hostname R1',
    `interface ${cisco.getPortNames()[0]}`, 'ip address 10.0.21.6 255.255.255.0', 'no shutdown', 'exit',
    'username admin privilege 15 secret Admin@123', 'enable secret Admin@123',
    'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'ip ssh version 2',
    'line vty 0 4', 'login local', 'transport input ssh', 'end',
  ]) await cisco.executeCommand(cmd);

  return { pc, cisco, windows };
}

async function shellTo(pc: LinuxPC, ip: string, user: string, password: string): Promise<ISshShellChannel> {
  const dev = pc as unknown as { tcpConnect(h: string, p: number): Promise<unknown> };
  const session = new SshSession({
    tcpConnector: ((h: string, p: number) => dev.tcpConnect(h, p)) as never,
    vfs: { readFile: () => null, writeFile: () => undefined, resolveInode: () => null, mkdirp: () => undefined } as never,
    localUser: 'user', localUid: 1000, localGid: 1000,
    knownHostsPath: '/home/user/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(),
  } as never);
  const opts = SshConnectOptionsBuilder.create()
    .host(ip).user(user).password(password).strictHostKeyChecking('no').build();
  const connected = await session.connect(opts);
  if (!isOk(connected)) throw new Error('connect failed: ' + JSON.stringify((connected as { error: unknown }).error));
  const channel = session.openShellChannel();
  if (!isOk(channel)) throw new Error('shell channel failed');
  return channel.value;
}

describe('the wire carries what a client used to assume (docs/PRD-SSH-Unification.md §4bis B4)', () => {
  it('a router publishes its prompt before a single line has run', async () => {
    const { pc } = await lab();
    const ch = await shellTo(pc, '10.0.21.6', 'admin', 'Admin@123');
    expect(ch.initialPrompt()).toMatch(/^R1[>#]/);
  }, 30000);

  it('a Windows host publishes its prompt at open too', async () => {
    const { pc } = await lab();
    const ch = await shellTo(pc, '10.0.21.4', 'Administrator', 'admin');
    expect(ch.initialPrompt()).toMatch(/^[A-Z]:\\/);
  }, 30000);

  it('a router and a Windows host both declare themselves non-POSIX', async () => {
    const { pc } = await lab();
    const router = await shellTo(pc, '10.0.21.6', 'admin', 'Admin@123');
    expect(router.isPosixShell()).toBe(false);
    const win = await shellTo(pc, '10.0.21.4', 'Administrator', 'admin');
    expect(win.isPosixShell()).toBe(false);
  }, 30000);

  it('cls on a Windows remote asks the client to wipe the screen', async () => {
    const { pc } = await lab();
    const ch = await shellTo(pc, '10.0.21.4', 'Administrator', 'admin');
    const plain = await ch.runLine('hostname');
    expect(plain.clearScreen).toBe(false);
    const wipe = await ch.runLine('cls');
    expect(wipe.clearScreen).toBe(true);
  }, 30000);

  it('a router reports the logout when its own exit word runs out of modes', async () => {
    const { pc } = await lab();
    const ch = await shellTo(pc, '10.0.21.6', 'admin', 'Admin@123');
    await ch.runLine('enable');
    await ch.runLine('configure terminal');
    // Each `exit` pops one mode; only the one with nothing left to pop
    // logs the VTY line out.
    let ended = false;
    for (let i = 0; i < 4 && !ended; i++) {
      ended = (await ch.runLine('exit')).sessionEnded === true;
    }
    expect(ended).toBe(true);
  }, 30000);
});
