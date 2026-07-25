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
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const MASK = new SubnetMask('255.255.255.0');

async function remoteShell(): Promise<{ shell: SshInteractiveSubShell; remote: LinuxPC }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxPC('linux-pc', 'PC2');
  srv.setHostname('srv2');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.10.1'), MASK);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.10.2'), MASK);
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
    .host('10.0.10.2').user('user').password('admin').strictHostKeyChecking('no').build();
  const connected = await session.connect(opts);
  if (!isOk(connected)) throw new Error('connect failed');
  const channel = session.openShellChannel();
  if (!isOk(channel)) throw new Error('shell channel failed');

  const shell = new SshInteractiveSubShell(
    session as never, channel.value as never, 'user', '10.0.10.2', '~', undefined, 'srv2',
  );
  return { shell, remote: srv };
}

describe('the SSH sub-shell offers completion (docs/PRD-SSH-Unification.md §4bis B1)', () => {
  it('exposes an async completion entry point', async () => {
    const { shell } = await remoteShell();
    expect(typeof shell.getCompletionsAsync).toBe('function');
  }, 30000);

  it('completes a command that exists on the remote', async () => {
    const { shell } = await remoteShell();
    const candidates = await shell.getCompletionsAsync('hostn');
    expect(candidates).toContain('hostname');
  }, 30000);

  it('completes against the remote filesystem', async () => {
    const { shell, remote } = await remoteShell();
    await remote.executeCommand('mkdir -p /tmp/remoteonlydir');
    const candidates = await shell.getCompletionsAsync('ls /tmp/remoteonlydi');
    expect(candidates.some((c) => c.includes('remoteonlydir'))).toBe(true);
  }, 30000);

  it('follows the remote cwd after a cd', async () => {
    const { shell, remote } = await remoteShell();
    await remote.executeCommand('mkdir -p /tmp/workdir/inner');
    await shell.processLine('cd /tmp/workdir');
    const candidates = await shell.getCompletionsAsync('ls inn');
    expect(candidates.some((c) => c.includes('inner'))).toBe(true);
  }, 30000);

  it('returns an empty list rather than throwing when nothing matches', async () => {
    const { shell } = await remoteShell();
    await expect(shell.getCompletionsAsync('zzzznope')).resolves.toEqual([]);
  }, 30000);
});

describe('the terminal drives that completion on Tab (B1c)', () => {
  async function terminalOnSsh(): Promise<{ session: LinuxTerminalSession; remote: LinuxPC }> {
    const { shell, remote } = await remoteShell();
    const local = new LinuxPC('linux-pc', 'PC0');
    const session = new LinuxTerminalSession('t1', local);
    (session as unknown as { activeSubShell: unknown }).activeSubShell = shell;
    return { session, remote };
  }

  const flush = async () => {
    for (let i = 0; i < 8; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); }
  };

  it('Tab completes the input from the remote candidates', async () => {
    const { session } = await terminalOnSsh();
    session.setInputBuf('hostn');
    session.handleKey({ key: 'Tab', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false } as never);
    await flush();
    expect(session.getInputBuf()).toBe('hostname');
  }, 30000);

  it('Tab on a remote-only directory completes it', async () => {
    const { session, remote } = await terminalOnSsh();
    await remote.executeCommand('mkdir -p /tmp/uniquelynamedhere');
    session.setInputBuf('ls /tmp/uniquelynamedher');
    session.handleKey({ key: 'Tab', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false } as never);
    await flush();
    expect(session.getInputBuf()).toContain('uniquelynamedhere');
  }, 30000);

  it('a Tab that matches nothing leaves the input untouched', async () => {
    const { session } = await terminalOnSsh();
    session.setInputBuf('zzzznope');
    session.handleKey({ key: 'Tab', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false } as never);
    await flush();
    expect(session.getInputBuf()).toBe('zzzznope');
  }, 30000);
});
