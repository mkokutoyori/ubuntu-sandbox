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
import { SshInteractiveSubShell } from '@/terminal/subshells/SshInteractiveSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const MASK = new SubnetMask('255.255.255.0');

async function remoteSubShell(user: string, addOpts: object = { m: true, s: '/bin/bash' }) {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxPC('linux-pc', 'PC2');
  srv.setHostname('srv2');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.8.1'), MASK);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.8.2'), MASK);
  new Cable('c1').connect(pc.getPorts()[0], srv.getPorts()[0]);

  const um = (srv as unknown as { executor: { userMgr: {
    useradd: (u: string, o?: object) => void;
    getUser: (u: string) => unknown;
    setPassword: (u: string, p: string) => void;
  } } }).executor.userMgr;
  if (!um.getUser(user)) um.useradd(user, addOpts);
  um.setPassword(user, 'admin');

  const dev = pc as unknown as { tcpConnect(h: string, p: number): Promise<unknown> };
  const session = new SshSession({
    tcpConnector: ((h: string, p: number) => dev.tcpConnect(h, p)) as never,
    vfs: { readFile: () => null, writeFile: () => undefined, resolveInode: () => null, mkdirp: () => undefined } as never,
    localUser: 'user', localUid: 1000, localGid: 1000,
    knownHostsPath: '/home/user/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(),
  } as never);
  const opts = SshConnectOptionsBuilder.create()
    .host('10.0.8.2').user(user).password('admin').strictHostKeyChecking('no').build();
  const connected = await session.connect(opts);
  if (!isOk(connected)) throw new Error('connect failed: ' + JSON.stringify((connected as { error: unknown }).error));
  const channel = session.openShellChannel();
  if (!isOk(channel)) throw new Error('shell channel failed');

  return new SshInteractiveSubShell(
    session as never, channel.value as never, user, '10.0.8.2', '~', undefined, 'srv2',
  );
}

describe('the interactive client renders the prompt the server published (A4)', () => {
  it('adopts the remote hostname the server reports', async () => {
    const shell = await remoteSubShell('user');
    await shell.processLine('pwd');
    expect(shell.getPrompt()).toContain('user@srv2');
  }, 30000);

  it('follows a cd made on the remote', async () => {
    const shell = await remoteSubShell('user');
    const before = shell.getPrompt();
    await shell.processLine('mkdir -p /tmp/deep');
    await shell.processLine('cd /tmp/deep');
    const after = shell.getPrompt();
    expect(after).not.toEqual(before);
    expect(after).toContain('/tmp/deep');
  }, 30000);

  it('never invents a /home/<user> path for an account whose home is elsewhere', async () => {
    const shell = await remoteSubShell('svc', { m: true, d: '/opt/svcdata', s: '/bin/bash' });
    await shell.processLine('pwd');
    const prompt = shell.getPrompt();
    expect(prompt).not.toContain('/home/svc');
    expect(prompt).toContain(':~');
  }, 30000);

  it('an account with no home directory shows / rather than a phantom ~', async () => {
    const shell = await remoteSubShell('nohome', { s: '/bin/bash' });
    await shell.processLine('pwd');
    const prompt = shell.getPrompt();
    expect(prompt).toContain(':/');
    expect(prompt).not.toContain(':~');
  }, 30000);

  it('falls back to its own prompt before any line has run', async () => {
    const shell = await remoteSubShell('user');
    expect(shell.getPrompt()).toContain('user@srv2');
  }, 30000);
});
