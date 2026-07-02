import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  tryInterpretSshLaunch,
  finalisePendingAuth,
  type SshLaunchOptions,
} from '@/shell/sshLauncher';
import type { IShell } from '@/shell/IShell';
import { reinstallDefaultShells } from '@/shell/registerDefaults';

const MASK = '255.255.255.0';
const PC_IP = '10.0.0.1';
const CISCO_IP = '10.0.0.6';
const HUAWEI_IP = '10.0.0.8';

function launchOpts(pc: LinuxPC): SshLaunchOptions {
  return {
    defaultUser: 'root',
    sourceIp: PC_IP,
    wireProbe: (host, port) => pc.tcpConnectOutcome(new IPAddress(host), port),
  };
}

async function buildCiscoLan(): Promise<{ pc: LinuxPC; cisco: CiscoRouter }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const cisco = new CiscoRouter('cisco1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(cisco.getPorts()[0], sw.getPorts()[1]);
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask(MASK));
  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    `ip address ${CISCO_IP} ${MASK}`,
    'no shutdown', 'end',
  ]) await cisco.executeCommand(cmd);
  return { pc, cisco };
}

async function buildHuaweiLan(): Promise<{ pc: LinuxPC; huawei: HuaweiRouter }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const huawei = new HuaweiRouter('huawei1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(huawei.getPorts()[0], sw.getPorts()[1]);
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask(MASK));
  for (const cmd of [
    'system-view',
    'interface GigabitEthernet0/0/0',
    `ip address ${HUAWEI_IP} ${MASK}`,
    'undo shutdown', 'quit', 'quit',
  ]) await huawei.executeCommand(cmd);
  return { pc, huawei };
}

async function openInteractiveSession(pc: LinuxPC, ip: string): Promise<IShell> {
  const attempt = await tryInterpretSshLaunch(`ssh alice@${ip}`, launchOpts(pc));
  expect(attempt?.kind).toBe('pending');
  const finalised = finalisePendingAuth(
    (attempt as { pendingAuth: Parameters<typeof finalisePendingAuth>[0] }).pendingAuth,
    'alice',
  );
  expect(finalised).not.toBeNull();
  return finalised!.shell;
}

function registryOf(router: CiscoRouter | HuaweiRouter) {
  return (router as unknown as {
    getSshSessionRegistry: () => {
      list: () => ReadonlyArray<{ line: string; lineIndex: number; user: string }>;
    };
  }).getSshSessionRegistry();
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
  reinstallDefaultShells();
});

describe('the VTY line pool is finite (default vty 0 4)', () => {
  it('admits five concurrent interactive sessions and refuses the sixth', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (let i = 0; i < 5; i++) await openInteractiveSession(pc, CISCO_IP);
    expect(registryOf(cisco).list()).toHaveLength(5);

    const sixth = await tryInterpretSshLaunch(`ssh alice@${CISCO_IP}`, launchOpts(pc));

    expect(sixth?.kind).toBe('error');
    expect(sixth?.result.output.join('\n')).toMatch(/Connection refused/);
  });

  it('closing a session frees its line for the next connection', async () => {
    const { pc, cisco } = await buildCiscoLan();
    const shells: IShell[] = [];
    for (let i = 0; i < 5; i++) shells.push(await openInteractiveSession(pc, CISCO_IP));
    expect((await tryInterpretSshLaunch(`ssh alice@${CISCO_IP}`, launchOpts(pc)))?.kind).toBe('error');

    shells[0].dispose();

    expect(registryOf(cisco).list()).toHaveLength(4);
    const again = await tryInterpretSshLaunch(`ssh alice@${CISCO_IP}`, launchOpts(pc));
    expect(again?.kind).toBe('pending');
  });

  it('reuses the lowest freed line index', async () => {
    const { pc, cisco } = await buildCiscoLan();
    const first = await openInteractiveSession(pc, CISCO_IP);
    await openInteractiveSession(pc, CISCO_IP);
    first.dispose();

    await openInteractiveSession(pc, CISCO_IP);

    const indexes = registryOf(cisco).list().map(s => s.lineIndex).sort();
    expect(indexes).toEqual([0, 1]);
  });

  it('show users lists each allocated vty line', async () => {
    const { pc, cisco } = await buildCiscoLan();
    await openInteractiveSession(pc, CISCO_IP);
    await openInteractiveSession(pc, CISCO_IP);

    const out = (cisco as unknown as {
      runSshCommandSync: (u: string, c: string) => { output: string } | null;
    }).runSshCommandSync('alice', 'show users');

    expect(out?.output).toMatch(/vty 0/);
    expect(out?.output).toMatch(/vty 1/);
    expect(out?.output).toMatch(/alice/);
  });

  it('a narrower line vty range shrinks the pool', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (const cmd of [
      'enable', 'configure terminal', 'line vty 0 1', 'exit', 'end',
    ]) await cisco.executeCommand(cmd);
    await openInteractiveSession(pc, CISCO_IP);
    await openInteractiveSession(pc, CISCO_IP);

    const third = await tryInterpretSshLaunch(`ssh alice@${CISCO_IP}`, launchOpts(pc));

    expect(third?.kind).toBe('error');
    expect(third?.result.output.join('\n')).toMatch(/Connection refused/);
  });

  it('clear line vty N terminates the session holding that line', async () => {
    const { pc, cisco } = await buildCiscoLan();
    await openInteractiveSession(pc, CISCO_IP);
    await openInteractiveSession(pc, CISCO_IP);
    await cisco.executeCommand('enable');

    await cisco.executeCommand('clear line vty 0');

    const remaining = registryOf(cisco).list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].lineIndex).toBe(1);
  });

  it('applies the same finite pool to Huawei routers', async () => {
    const { pc, huawei } = await buildHuaweiLan();
    for (let i = 0; i < 5; i++) await openInteractiveSession(pc, HUAWEI_IP);

    const sixth = await tryInterpretSshLaunch(`ssh alice@${HUAWEI_IP}`, launchOpts(pc));

    expect(sixth?.kind).toBe('error');
    expect(sixth?.result.output.join('\n')).toMatch(/Connection refused/);
  });
});
