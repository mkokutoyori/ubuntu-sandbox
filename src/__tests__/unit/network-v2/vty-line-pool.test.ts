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
import {
  configureCiscoSshServer,
  configureHuaweiSshServer,
  ROUTER_SSH_USER,
  ROUTER_SSH_PASSWORD,
} from './_helpers/routerSshFixtures';

const MASK = '255.255.255.0';
const PC_IP = '10.0.0.1';
const CISCO_IP = '10.0.0.6';
const HUAWEI_IP = '10.0.0.8';

function launchOpts(pc: LinuxPC): SshLaunchOptions {
  return {
    defaultUser: 'root',
    sourceIp: PC_IP,
    sourceDevice: pc,
    wireProbe: (host, port) => pc.tcpConnectOutcome(new IPAddress(host), port),
  };
}

async function buildCiscoLan(
  opts: { vtyRange?: string } = {},
): Promise<{ pc: LinuxPC; cisco: CiscoRouter }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const cisco = new CiscoRouter('cisco1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(cisco.getPorts()[0], sw.getPorts()[1]);
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask(MASK));
  // A real sshd, not just an address: the pool being tested is only
  // meaningful for sessions that were genuinely opened over the wire.
  await configureCiscoSshServer(cisco, CISCO_IP, MASK, { interfaceName: 'GigabitEthernet0/0', vtyRange: opts.vtyRange });
  return { pc, cisco };
}

async function buildHuaweiLan(): Promise<{ pc: LinuxPC; huawei: HuaweiRouter }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const huawei = new HuaweiRouter('huawei1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(huawei.getPorts()[0], sw.getPorts()[1]);
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask(MASK));
  await configureHuaweiSshServer(huawei, HUAWEI_IP, MASK, { interfaceName: 'GigabitEthernet0/0/0' });
  return { pc, huawei };
}

async function openInteractiveSession(pc: LinuxPC, ip: string): Promise<IShell> {
  const attempt = await tryInterpretSshLaunch(`ssh ${ROUTER_SSH_USER}@${ip}`, launchOpts(pc));
  expect(attempt?.kind).toBe('pending');
  const finalised = await finalisePendingAuth(
    (attempt as { pendingAuth: Parameters<typeof finalisePendingAuth>[0] }).pendingAuth,
    ROUTER_SSH_PASSWORD,
  );
  expect(finalised.kind).toBe('success');
  if (finalised.kind !== 'success') throw new Error('unreachable');
  return finalised.shell;
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

    const sixth = await tryInterpretSshLaunch(`ssh ${ROUTER_SSH_USER}@${CISCO_IP}`, launchOpts(pc));

    expect(sixth?.kind).toBe('error');
    // The router's real SshServerHandler accepts the TCP connection
    // (vty-pool exhaustion is an application-layer check, not a SYN-time
    // refusal) then immediately closes it — a bare TCP probe sees
    // "established, then closed right away", which its binary
    // open/refused classifier reports as a timeout rather than an
    // active refusal (no RST-on-SYN was ever sent). Either way the
    // connection is genuinely and correctly rejected.
    expect(sixth?.result.output.join('\n')).toMatch(/Connection (refused|timed out)/);
  });

  it('closing a session frees its line for the next connection', async () => {
    const { pc, cisco } = await buildCiscoLan();
    const shells: IShell[] = [];
    for (let i = 0; i < 5; i++) shells.push(await openInteractiveSession(pc, CISCO_IP));
    expect((await tryInterpretSshLaunch(`ssh ${ROUTER_SSH_USER}@${CISCO_IP}`, launchOpts(pc)))?.kind).toBe('error');

    shells[0].dispose();

    expect(registryOf(cisco).list()).toHaveLength(4);
    const again = await tryInterpretSshLaunch(`ssh ${ROUTER_SSH_USER}@${CISCO_IP}`, launchOpts(pc));
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
    }).runSshCommandSync(ROUTER_SSH_USER, 'show users');

    expect(out?.output).toMatch(/vty 0/);
    expect(out?.output).toMatch(/vty 1/);
    expect(out?.output).toMatch(new RegExp(ROUTER_SSH_USER));
  });

  it('a narrower line vty range shrinks the pool', async () => {
    // The range is configured up front: on real IOS `line vty 0 1` after
    // `line vty 0 4` selects a range, it does not delete lines 2-4, so a
    // pool narrowed after the fact would not shrink.
    const { pc } = await buildCiscoLan({ vtyRange: '0 1' });
    await openInteractiveSession(pc, CISCO_IP);
    await openInteractiveSession(pc, CISCO_IP);

    const third = await tryInterpretSshLaunch(`ssh ${ROUTER_SSH_USER}@${CISCO_IP}`, launchOpts(pc));

    expect(third?.kind).toBe('error');
    // See the "refuses the sixth" test above for why both wordings are
    // accepted here.
    expect(third?.result.output.join('\n')).toMatch(/Connection (refused|timed out)/);
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

    const sixth = await tryInterpretSshLaunch(`ssh ${ROUTER_SSH_USER}@${HUAWEI_IP}`, launchOpts(pc));

    expect(sixth?.kind).toBe('error');
    // See the "refuses the sixth" test above for why both wordings are
    // accepted here.
    expect(sixth?.result.output.join('\n')).toMatch(/Connection (refused|timed out)/);
  });
});
