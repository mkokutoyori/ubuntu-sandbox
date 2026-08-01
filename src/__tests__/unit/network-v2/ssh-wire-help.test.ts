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
type Reply = { stdout: string; stderr: string; exitCode: number; prompt?: string };

async function shellTo(
  remote: { getPorts(): Array<{ configureIP(a: IPAddress, m: SubnetMask): void }> },
  ip: string, user: string, password: string,
): Promise<ISshShellChannel> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.11.1'), MASK);
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
  return channel.value;
}

async function cisco(): Promise<CiscoRouter> {
  const r = new CiscoRouter('router-cisco', 'R1');
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('hostname R1');
  await r.executeCommand('username admin privilege 1 secret adminpw');
  // IOS runs no SSH server without RSA host keys, and refuses to
  // generate them without a domain name — this is the real setup that
  // makes the router reachable over ssh, not decoration.
  await r.executeCommand('ip domain-name lab.local');
  await r.executeCommand('crypto key generate rsa modulus 2048');
  await r.executeCommand('end');
  return r;
}

describe('IOS contextual help over the wire (docs/PRD-SSH-Unification.md §4bis B1)', () => {
  it('a bare ? lists the commands available in the current mode', async () => {
    const ch = await shellTo(await cisco() as never, '10.0.11.2', 'admin', 'adminpw');
    const help = await ch.runLine('?') as Reply;
    expect(help.stdout).toContain('show');
    expect(help.stdout).not.toContain('not recognised');
  }, 30000);

  it('a partial command followed by ? narrows the help', async () => {
    const ch = await shellTo(await cisco() as never, '10.0.11.2', 'admin', 'adminpw');
    const help = await ch.runLine('sh ?') as Reply;
    expect(help.stdout.length).toBeGreaterThan(0);
    expect(help.stdout).not.toContain('not recognised');
  }, 30000);

  it('the help follows the CLI mode, like the real device', async () => {
    const ch = await shellTo(await cisco() as never, '10.0.11.2', 'admin', 'adminpw');
    const asUser = (await ch.runLine('?') as Reply).stdout;
    await ch.runLine('enable');
    const asPrivileged = (await ch.runLine('?') as Reply).stdout;
    expect(asPrivileged).not.toEqual(asUser);
    expect(asPrivileged).toContain('configure');
  }, 30000);

  it('asking for help leaves the session mode untouched', async () => {
    const ch = await shellTo(await cisco() as never, '10.0.11.2', 'admin', 'adminpw');
    await ch.runLine('enable');
    await ch.runLine('?');
    expect((await ch.runLine('show clock') as Reply).prompt).toContain('R1#');
  }, 30000);
});

describe('Huawei contextual help over the wire', () => {
  it('a bare ? lists commands', async () => {
    const r = new HuaweiRouter('router-huawei', 'R1');
    await r.executeCommand('system-view');
    await r.executeCommand('aaa');
    await r.executeCommand('local-user admin password irreversible-cipher adminpw');
    await r.executeCommand('local-user admin privilege level 15');
    await r.executeCommand('local-user admin service-type ssh terminal');
    await r.executeCommand('quit');
    // VRP ne fait tourner aucun serveur STelnet sans paire de clés locale.
    await r.executeCommand('rsa local-key-pair create');
    await r.executeCommand('quit');

    const ch = await shellTo(r as never, '10.0.11.3', 'admin', 'adminpw');
    const help = await ch.runLine('?') as Reply;
    expect(help.stdout.length).toBeGreaterThan(0);
    expect(help.stdout).not.toContain('not recognised');
  }, 30000);
});
