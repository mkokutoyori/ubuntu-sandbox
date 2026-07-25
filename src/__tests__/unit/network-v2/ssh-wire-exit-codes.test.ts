import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
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

async function wireShell(): Promise<ISshShellChannel> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxPC('linux-pc', 'PC2');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.6.1'), MASK);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.6.2'), MASK);
  new Cable('c1').connect(pc.getPorts()[0], srv.getPorts()[0]);

  const dev = pc as unknown as { tcpConnect(h: string, p: number): Promise<unknown> };
  const session = new SshSession({
    tcpConnector: ((h: string, p: number) => dev.tcpConnect(h, p)) as never,
    vfs: { readFile: () => null, writeFile: () => undefined, resolveInode: () => null, mkdirp: () => undefined } as never,
    localUser: 'user', localUid: 1000, localGid: 1000,
    knownHostsPath: '/home/user/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(),
  } as never);
  const opts = SshConnectOptionsBuilder.create()
    .host('10.0.6.2').user('user').password('admin').strictHostKeyChecking('no').build();
  const connected = await session.connect(opts);
  if (!isOk(connected)) throw new Error('connect failed');
  const channel = session.openShellChannel();
  if (!isOk(channel)) throw new Error('shell channel failed');
  return channel.value;
}

type Reply = { stdout: string; stderr: string; exitCode: number };

describe('SSH reports the shell\'s real exit status (docs/PRD-SSH-Unification.md, A5)', () => {
  it('a successful command reports 0', async () => {
    const ch = await wireShell();
    expect((await ch.runLine('true') as Reply).exitCode).toBe(0);
    expect((await ch.runLine('echo hi') as Reply).exitCode).toBe(0);
  }, 30000);

  it('`false` reports a failure instead of 0', async () => {
    const ch = await wireShell();
    expect((await ch.runLine('false') as Reply).exitCode).not.toBe(0);
  }, 30000);

  it('a missing file reports a failure — the case the old regex missed', async () => {
    const ch = await wireShell();
    const res = await ch.runLine('ls /totally/absent') as Reply;
    expect(`${res.stdout}${res.stderr}`).toContain('No such file or directory');
    expect(res.exitCode).not.toBe(0);
  }, 30000);

  it('a non-zero status from a real command is preserved verbatim', async () => {
    const ch = await wireShell();
    expect((await ch.runLine('exit 3; true') as Reply).exitCode).toBeDefined();
    const grep = await ch.runLine('echo abc | grep zzz') as Reply;
    expect(grep.exitCode).toBe(1);
  }, 30000);

  it('an unknown command still reports a failure (non-regression)', async () => {
    const ch = await wireShell();
    const res = await ch.runLine('definitelynotacommand') as Reply;
    expect(res.exitCode).not.toBe(0);
  }, 30000);

  it('a failure does not leak into the next command', async () => {
    const ch = await wireShell();
    expect((await ch.runLine('ls /totally/absent') as Reply).exitCode).not.toBe(0);
    expect((await ch.runLine('echo recovered') as Reply).exitCode).toBe(0);
  }, 30000);
});
