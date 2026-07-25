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

async function shellTo(
  remote: { getPorts(): Array<{ configureIP(a: IPAddress, m: SubnetMask): void }> },
  ip: string, user: string, password: string,
): Promise<ISshShellChannel> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.9.1'), MASK);
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

function linuxTarget(): LinuxPC {
  return new LinuxPC('linux-pc', 'PC2');
}

async function ciscoTarget(): Promise<CiscoRouter> {
  const r = new CiscoRouter('router-cisco', 'R1');
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('hostname R1');
  await r.executeCommand('username admin privilege 15 secret adminpw');
  await r.executeCommand('end');
  return r;
}

describe('the wire can answer a completion request (docs/PRD-SSH-Unification.md §4bis B1)', () => {
  it('a Linux remote completes a command prefix', async () => {
    const ch = await shellTo(linuxTarget() as never, '10.0.9.2', 'user', 'admin');
    const candidates = await ch.complete('hostn');
    expect(candidates).toContain('hostname');
  }, 30000);

  it('completion reflects the remote filesystem, not the client', async () => {
    const target = linuxTarget();
    await target.executeCommand('mkdir -p /tmp/onlyontheremote');
    const ch = await shellTo(target as never, '10.0.9.2', 'user', 'admin');
    const candidates = await ch.complete('ls /tmp/onlyontheremot');
    expect(candidates.some((c) => c.includes('onlyontheremote'))).toBe(true);
  }, 30000);

  it('an empty result is returned as an empty list, not an error', async () => {
    const ch = await shellTo(linuxTarget() as never, '10.0.9.2', 'user', 'admin');
    const candidates = await ch.complete('zzzzznotacommand');
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates).toHaveLength(0);
  }, 30000);

  it('a Cisco remote completes an IOS command prefix', async () => {
    const ch = await shellTo(await ciscoTarget() as never, '10.0.9.3', 'admin', 'adminpw');
    const candidates = await ch.complete('sho');
    expect(candidates.some((c) => c.startsWith('show'))).toBe(true);
  }, 30000);

  it('the router completion follows the CLI mode', async () => {
    const ch = await shellTo(await ciscoTarget() as never, '10.0.9.3', 'admin', 'adminpw');
    const userMode = await ch.complete('conf');
    await ch.runLine('enable');
    const privMode = await ch.complete('conf');
    expect(privMode.some((c) => c.startsWith('configure'))).toBe(true);
    expect(privMode).not.toEqual(userMode);
  }, 30000);

  it('completing does not disturb the session state', async () => {
    const ch = await shellTo(linuxTarget() as never, '10.0.9.2', 'user', 'admin');
    await ch.runLine('mkdir -p /tmp/deep && cd /tmp/deep');
    await ch.complete('ls /et');
    const where = await ch.runLine('pwd') as { stdout: string };
    expect(where.stdout.trim()).toBe('/tmp/deep');
  }, 30000);
});
