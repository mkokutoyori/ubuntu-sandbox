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
import { SshInteractiveSubShell } from '@/terminal/subshells/SshInteractiveSubShell';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const MASK = new SubnetMask('255.255.255.0');

async function subShellTo(
  remote: { getPorts(): Array<{ configureIP(a: IPAddress, m: SubnetMask): void }> },
  ip: string, user: string, password: string,
): Promise<SshInteractiveSubShell> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.12.1'), MASK);
  remote.getPorts()[0].configureIP(new IPAddress(ip), MASK);
  new Cable('c1').connect(
    pc.getPorts()[0] as never,
    (remote as unknown as { getPorts(): unknown[] }).getPorts()[0] as never,
  );
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
  return new SshInteractiveSubShell(
    session as never, channel.value as never, user, ip, '~', undefined, ip,
  );
}

async function cisco(): Promise<CiscoRouter> {
  const r = new CiscoRouter('router-cisco', 'R1');
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('hostname R1');
  await r.executeCommand('username admin privilege 15 secret adminpw');
  await r.executeCommand('end');
  return r;
}

describe('inline ? is offered only where it is a help key (docs/PRD-SSH-Unification.md §4bis B1)', () => {
  it('a router session advertises inline help', async () => {
    const shell = await subShellTo(await cisco() as never, '10.0.12.2', 'admin', 'adminpw');
    expect(shell.supportsInlineHelp()).toBe(true);
  }, 30000);

  it('a Linux session does not — there ? is an ordinary glob character', async () => {
    const shell = await subShellTo(new LinuxPC('linux-pc', 'PC2') as never, '10.0.12.3', 'user', 'admin');
    expect(shell.supportsInlineHelp()).toBe(false);
  }, 30000);

  it('inline help returns the same lines the device would print', async () => {
    const shell = await subShellTo(await cisco() as never, '10.0.12.2', 'admin', 'adminpw');
    const lines = await shell.inlineHelpAsync('');
    expect(lines.join('\n')).toContain('show');
  }, 30000);

  it('inline help narrows on a partial command', async () => {
    const shell = await subShellTo(await cisco() as never, '10.0.12.2', 'admin', 'adminpw');
    const lines = await shell.inlineHelpAsync('sh');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('not recognised');
  }, 30000);

  it('asking for inline help does not consume the line or change the mode', async () => {
    const shell = await subShellTo(await cisco() as never, '10.0.12.2', 'admin', 'adminpw');
    await shell.processLine('enable');
    const before = shell.getPrompt();
    await shell.inlineHelpAsync('conf');
    expect(shell.getPrompt()).toBe(before);
  }, 30000);
});

describe('the terminal intercepts ? only where it is a help key (B1)', () => {
  const question = { key: '?', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false } as never;
  const flush = async () => {
    for (let i = 0; i < 8; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); }
  };

  function terminalOn(shell: SshInteractiveSubShell): LinuxTerminalSession {
    const session = new LinuxTerminalSession('t1', new LinuxPC('linux-pc', 'PC0'));
    (session as unknown as { activeSubShell: unknown }).activeSubShell = shell;
    return session;
  }

  it('pressing ? on a router session prints help and keeps the typed line', async () => {
    const session = terminalOn(await subShellTo(await cisco() as never, '10.0.12.2', 'admin', 'adminpw'));
    session.setInputBuf('sh');
    session.handleKey(question);
    await flush();
    expect(session.getInputBuf()).toBe('sh');
    expect(session.lines.map((l) => l.text).join('\n')).toContain('sh?');
  }, 30000);

  it('pressing ? on a Linux session types the character instead', async () => {
    const session = terminalOn(await subShellTo(new LinuxPC('linux-pc', 'PC2') as never, '10.0.12.3', 'user', 'admin'));
    session.setInputBuf('ls ');
    const consumed = session.handleKey(question);
    await flush();
    expect(consumed).toBe(false);
  }, 30000);
});
