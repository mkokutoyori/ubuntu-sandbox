import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
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

async function openWireShell(
  pc: LinuxPC, ip: string, user: string, password: string,
): Promise<ISshShellChannel> {
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

type Reply = { stdout: string; stderr: string; exitCode: number; prompt?: string };

async function ciscoLab(): Promise<{ pc: LinuxPC; r: CiscoRouter }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const r = new CiscoRouter('router-cisco', 'R1');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.4.1'), MASK);
  r.getPorts()[0].configureIP(new IPAddress('10.0.4.2'), MASK);
  new Cable('c1').connect(pc.getPorts()[0], r.getPorts()[0]);
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('hostname R1');
  // Level 1 on purpose: these tests watch the session move from user
  // EXEC to privileged and back, and a privilege-15 account is already
  // in privileged EXEC the moment it lands, as on real IOS.
  await r.executeCommand('username admin privilege 1 secret adminpw');
  await r.executeCommand('end');
  return { pc, r };
}

describe('a router SSH shell keeps its mode across lines (docs/PRD-SSH-Unification.md §4 #3, A2)', () => {
  it('enable then configure terminal then a config command actually takes effect', async () => {
    const { pc, r } = await ciscoLab();
    const ch = await openWireShell(pc, '10.0.4.2', 'admin', 'adminpw');

    expect((await ch.runLine('enable') as Reply).stderr).not.toContain('not recognised');
    expect((await ch.runLine('configure terminal') as Reply).stderr).not.toContain('not recognised');
    await ch.runLine('hostname R99');

    expect(r.getHostname()).toBe('R99');
  }, 30000);

  it('the change is visible in the running config read back over the wire', async () => {
    const { pc } = await ciscoLab();
    const ch = await openWireShell(pc, '10.0.4.2', 'admin', 'adminpw');
    await ch.runLine('enable');
    await ch.runLine('configure terminal');
    await ch.runLine('hostname R99');
    await ch.runLine('end');

    const shown = await ch.runLine('show running-config') as Reply;
    expect(shown.stdout).toContain('hostname R99');
  }, 30000);

  it('the prompt follows the mode (docs/PRD-SSH-Unification.md §4 #4)', async () => {
    const { pc } = await ciscoLab();
    const ch = await openWireShell(pc, '10.0.4.2', 'admin', 'adminpw');

    expect((await ch.runLine('show clock') as Reply).prompt).toContain('R1>');
    expect((await ch.runLine('enable') as Reply).prompt).toContain('R1#');
    expect((await ch.runLine('configure terminal') as Reply).prompt).toContain('R1(config)#');
  }, 30000);

  it('show commands still work, unchanged (non-regression)', async () => {
    const { pc } = await ciscoLab();
    const ch = await openWireShell(pc, '10.0.4.2', 'admin', 'adminpw');
    expect((await ch.runLine('show version') as Reply).stdout).toContain('Cisco IOS');
  }, 30000);
});

describe('sessions are isolated like real VTY lines (docs/PRD-SSH-Unification.md §4 #5-6, A2)', () => {
  it('two simultaneous sessions hold independent modes but share the config', async () => {
    const { pc, r } = await ciscoLab();
    const a = await openWireShell(pc, '10.0.4.2', 'admin', 'adminpw');
    const b = await openWireShell(pc, '10.0.4.2', 'admin', 'adminpw');

    await a.runLine('enable');
    await a.runLine('configure terminal');

    // b never enabled, so it is still in user EXEC.
    expect((await b.runLine('show clock') as Reply).prompt).toContain('>');
    expect((await a.runLine('hostname R42') as Reply).prompt).toContain('(config)#');

    // …yet the device config a changed is the one b sees.
    expect(r.getHostname()).toBe('R42');
    expect((await b.runLine('show running-config') as Reply).stdout).toContain('hostname R42');
  }, 30000);

  it('an SSH session in config mode leaves the local console mode alone', async () => {
    const { pc, r } = await ciscoLab();
    const ch = await openWireShell(pc, '10.0.4.2', 'admin', 'adminpw');
    await ch.runLine('enable');
    await ch.runLine('configure terminal');

    const consolePrompt = r.getShell().getPrompt(r);
    expect(consolePrompt).not.toContain('(config)');
  }, 30000);
});

describe('Huawei over the wire (docs/PRD-SSH-Unification.md §4 #7, A2)', () => {
  it('system-view takes effect and the prompt switches to brackets', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const r = new HuaweiRouter('router-huawei', 'R1');
    pc.getPorts()[0].configureIP(new IPAddress('10.0.5.1'), MASK);
    r.getPorts()[0].configureIP(new IPAddress('10.0.5.2'), MASK);
    new Cable('c1').connect(pc.getPorts()[0], r.getPorts()[0]);
    await r.executeCommand('system-view');
    await r.executeCommand('aaa');
    await r.executeCommand('local-user admin password irreversible-cipher adminpw');
    await r.executeCommand('local-user admin privilege level 15');
    await r.executeCommand('local-user admin service-type ssh terminal');
    await r.executeCommand('quit');
    await r.executeCommand('quit');

    const ch = await openWireShell(pc, '10.0.5.2', 'admin', 'adminpw');
    const sysview = await ch.runLine('system-view') as Reply;
    expect(sysview.stderr).not.toContain('not recognised');
    expect(sysview.prompt).toContain('[');
  }, 30000);
});
