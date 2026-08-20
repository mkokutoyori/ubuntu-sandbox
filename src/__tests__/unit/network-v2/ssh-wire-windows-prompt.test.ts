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

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const MASK = new SubnetMask('255.255.255.0');
type Reply = { stdout: string; stderr: string; exitCode: number; prompt?: string };

async function windowsShell(): Promise<{ ch: ISshShellChannel; win: WindowsPC }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const win = new WindowsPC('windows-pc', 'WIN1');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.7.1'), MASK);
  win.getPorts()[0].configureIP(new IPAddress('10.0.7.2'), MASK);
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
    .host('10.0.7.2').user('Administrator').password('admin').strictHostKeyChecking('no').build();
  const connected = await session.connect(opts);
  if (!isOk(connected)) throw new Error('connect failed: ' + JSON.stringify((connected as { error: unknown }).error));
  const channel = session.openShellChannel();
  if (!isOk(channel)) throw new Error('shell channel failed');
  return { ch: channel.value, win };
}

describe('Windows publishes its cmd prompt on the wire (docs/PRD-SSH-Unification.md §4 #8, A3)', () => {
  it('the prompt is a real Windows path ending in >', async () => {
    const { ch } = await windowsShell();
    const res = await ch.runLine('hostname') as Reply;
    expect(res.prompt).toBeDefined();
    expect(res.prompt).toMatch(/^[A-Z]:\\/);
    expect(res.prompt?.trimEnd().endsWith('>')).toBe(true);
  }, 30000);

  it('the prompt tracks a directory change', async () => {
    const { ch } = await windowsShell();
    const before = await ch.runLine('cd') as Reply;
    const after = await ch.runLine('cd C:\\Windows') as Reply;
    expect(after.prompt).not.toEqual(before.prompt);
    expect(after.prompt?.toLowerCase()).toContain('windows');
  }, 30000);

  it('the directory the prompt shows is the one cmd reports', async () => {
    const { ch } = await windowsShell();
    await ch.runLine('cd C:\\Windows');
    const where = await ch.runLine('cd') as Reply;
    expect(where.prompt).toContain(where.stdout.trim());
  }, 30000);
});
