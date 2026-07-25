import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

function noopVfs() {
  return {
    readFile: () => null,
    writeFile: () => undefined,
    resolveInode: () => null,
    mkdirp: () => undefined,
  };
}

/** Open a real SSH shell channel from `pc` to `ip`. */
async function openWireShell(
  pc: LinuxPC, ip: string, user: string, password: string,
): Promise<ISshShellChannel> {
  const dev = pc as unknown as { tcpConnect(h: string, p: number): Promise<unknown> };
  const session = new SshSession({
    tcpConnector: ((h: string, p: number) => dev.tcpConnect(h, p)) as never,
    vfs: noopVfs() as never,
    localUser: 'user', localUid: 1000, localGid: 1000,
    knownHostsPath: '/home/user/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(),
  } as never);
  const opts = SshConnectOptionsBuilder.create()
    .host(ip).user(user).password(password).strictHostKeyChecking('no').build();
  const connected = await session.connect(opts);
  if (!isOk(connected)) throw new Error('ssh connect failed: ' + JSON.stringify((connected as {error: unknown}).error));
  const channel = session.openShellChannel();
  if (!isOk(channel)) throw new Error('shell channel failed');
  return channel.value;
}

async function linuxToLinux(): Promise<ISshShellChannel> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxPC('linux-pc', 'PC2');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.1.1'), MASK);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.1.2'), MASK);
  new Cable('c1').connect(pc.getPorts()[0], srv.getPorts()[0]);
  const um = (srv as unknown as { executor: { userMgr: {
    useradd: (u: string, o?: object) => void;
    getUser: (u: string) => unknown;
    setPassword: (u: string, p: string) => void;
  } } }).executor.userMgr;
  if (!um.getUser('alice')) {
    um.useradd('alice', { m: true, s: '/bin/bash' });
    um.setPassword('alice', 'admin');
  }
  return openWireShell(pc, '10.0.1.2', 'user', 'admin');
}

describe('the wire carries the remote prompt (docs/PRD-SSH-Unification.md §4 #2, A1)', () => {
  it('a Linux shell reply reports the remote prompt', async () => {
    const channel = await linuxToLinux();
    const res = await channel.runLine('echo hi') as { stdout: string; prompt?: string };
    expect(res.stdout).toContain('hi');
    expect(res.prompt).toBeDefined();
    expect(res.prompt).toContain('user@');
  }, 30000);

  it('the prompt tracks a change the command itself caused', async () => {
    const channel = await linuxToLinux();
    const before = await channel.runLine('pwd') as { prompt?: string };
    await channel.runLine('mkdir -p /tmp/deep');
    const after = await channel.runLine('cd /tmp/deep') as { prompt?: string };
    expect(before.prompt).not.toEqual(after.prompt);
    expect(after.prompt).toContain('deep');
  }, 30000);
});

describe('the prompt contract stays optional (docs/PRD-SSH-Unification.md §4 #1, A1)', () => {
  it('a Cisco router still answers show commands over the wire', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const r = new CiscoRouter('router-cisco', 'R1');
    pc.getPorts()[0].configureIP(new IPAddress('10.0.2.1'), MASK);
    r.getPorts()[0].configureIP(new IPAddress('10.0.2.2'), MASK);
    new Cable('c1').connect(pc.getPorts()[0], r.getPorts()[0]);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('username admin privilege 15 secret adminpw');
    await r.executeCommand('end');

    const channel = await openWireShell(pc, '10.0.2.2', 'admin', 'adminpw');
    const res = await channel.runLine('show version') as { stdout: string };
    expect(res.stdout).toContain('Cisco IOS');
  }, 30000);
});
