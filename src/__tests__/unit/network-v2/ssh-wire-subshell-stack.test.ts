import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
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
type Reply = { stdout: string; stderr: string; exitCode: number; prompt?: string };

async function windowsShell(): Promise<ISshShellChannel> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const win = new WindowsPC('windows-pc', 'WIN1');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.13.1'), MASK);
  win.getPorts()[0].configureIP(new IPAddress('10.0.13.2'), MASK);
  new Cable('c1').connect(pc.getPorts()[0], win.getPorts()[0]);

  const dev = pc as unknown as { tcpConnect(h: string, p: number): Promise<unknown> };
  const session = new SshSession({
    tcpConnector: ((h: string, p: number) => dev.tcpConnect(h, p)) as never,
    vfs: { readFile: () => null, writeFile: () => undefined, resolveInode: () => null, mkdirp: () => undefined } as never,
    localUser: 'user', localUid: 1000, localGid: 1000,
    knownHostsPath: '/home/user/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(),
  } as never);
  const opts = SshConnectOptionsBuilder.create()
    .host('10.0.13.2').user('Administrator').password('admin').strictHostKeyChecking('no').build();
  const connected = await session.connect(opts);
  if (!isOk(connected)) throw new Error('connect failed: ' + JSON.stringify((connected as { error: unknown }).error));
  const channel = session.openShellChannel();
  if (!isOk(channel)) throw new Error('shell channel failed');
  return channel.value;
}

describe('sub-shells stack on the server side of the wire (docs/PRD-SSH-Unification.md §4bis B2)', () => {
  it('cmd answers before any sub-shell is entered', async () => {
    const ch = await windowsShell();
    const res = await ch.runLine('hostname') as Reply;
    expect(res.stdout).toContain('WIN1');
    expect(res.prompt).toMatch(/^[A-Z]:\\/);
  }, 30000);

  it('entering powershell switches the prompt to PS', async () => {
    const ch = await windowsShell();
    const res = await ch.runLine('powershell') as Reply;
    expect(res.prompt).toMatch(/^PS /);
  }, 30000);

  it('a cmdlet runs once inside PowerShell', async () => {
    const ch = await windowsShell();
    await ch.runLine('powershell');
    const res = await ch.runLine('Write-Output hello') as Reply;
    expect(res.stdout).toContain('hello');
  }, 30000);

  it('exit pops back to cmd rather than ending the session', async () => {
    const ch = await windowsShell();
    await ch.runLine('powershell');
    await ch.runLine('exit');
    const res = await ch.runLine('hostname') as Reply;
    expect(res.stdout).toContain('WIN1');
    expect(res.prompt).toMatch(/^[A-Z]:\\/);
  }, 30000);

  it('completion follows the shell that is on top of the stack', async () => {
    const ch = await windowsShell();
    await ch.runLine('powershell');
    const candidates = await ch.complete('Write-Out');
    expect(candidates.some((c) => c.startsWith('Write-Output'))).toBe(true);
  }, 30000);
});
