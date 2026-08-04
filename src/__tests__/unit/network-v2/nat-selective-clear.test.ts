/**
 * PRD-Port-Forwarding.md Phase 3 — selective NAT session clearing.
 *
 * `clear ip nat translation inside|outside|vrf|pool <criterion>` (Cisco)
 * and `reset nat session inside <ip>` (Huawei) used to accept and validate
 * their filter argument, then unconditionally purge the *entire* dynamic
 * session table regardless of it — an operator who meant to drop one
 * session wiped every active NAT translation on the router. These tests
 * build multiple concurrent dynamic sessions and confirm a filtered clear
 * removes only the targeted one(s), leaving the rest untouched.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const GW_INSIDE = '192.168.10.254';
const GW_OUTSIDE = '203.0.113.1';
const PC1_IP = '192.168.10.10';
const PC2_IP = '192.168.10.20';

interface CiscoLab {
  router: CiscoRouter;
  pc1: LinuxPC;
  pc2: LinuxPC;
  outside1: LinuxServer;
  outside2: LinuxServer;
}

async function buildCiscoLab(natCmds: string[]): Promise<CiscoLab> {
  const lanSw = new GenericSwitch('switch-generic', 'lan-sw', 8, 0, 0);
  const wanSw = new GenericSwitch('switch-generic', 'wan-sw', 8, 0, 0);
  const router = new CiscoRouter('R1', 0, 0);
  const pc1 = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const pc2 = new LinuxPC('linux-pc', 'PC2', 0, 0);
  const outside1 = new LinuxServer('linux-server', 'outside1', 0, 0);
  const outside2 = new LinuxServer('linux-server', 'outside2', 0, 0);

  new Cable('a').connect(pc1.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('b').connect(pc2.getPort('eth0')!, lanSw.getPorts()[1]);
  new Cable('c').connect(lanSw.getPorts()[7], router.getPort('GigabitEthernet0/0')!);
  new Cable('d').connect(router.getPort('GigabitEthernet0/1')!, wanSw.getPorts()[0]);
  new Cable('e').connect(wanSw.getPorts()[1], outside1.getPort('eth0')!);
  new Cable('f').connect(wanSw.getPorts()[2], outside2.getPort('eth0')!);

  const lanMask = new SubnetMask('255.255.255.0');
  pc1.getPorts()[0].configureIP(new IPAddress(PC1_IP), lanMask);
  pc1.setDefaultGateway(new IPAddress(GW_INSIDE));
  pc2.getPorts()[0].configureIP(new IPAddress(PC2_IP), lanMask);
  pc2.setDefaultGateway(new IPAddress(GW_INSIDE));

  const wanMask = new SubnetMask('255.255.255.0');
  outside1.getPorts()[0].configureIP(new IPAddress('203.0.113.2'), wanMask);
  outside1.setDefaultGateway(new IPAddress(GW_OUTSIDE));
  outside2.getPorts()[0].configureIP(new IPAddress('203.0.113.3'), wanMask);
  outside2.setDefaultGateway(new IPAddress(GW_OUTSIDE));

  const cmds = [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    `ip address ${GW_INSIDE} 255.255.255.0`,
    'ip nat inside', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    `ip address ${GW_OUTSIDE} 255.255.255.0`,
    'ip nat outside', 'no shutdown', 'exit',
    ...natCmds,
    'end',
  ];
  for (const cmd of cmds) await router.executeCommand(cmd);

  return { router, pc1, pc2, outside1, outside2 };
}

async function showTranslations(router: CiscoRouter | HuaweiRouter): Promise<string> {
  return router.executeCommand(
    router instanceof HuaweiRouter ? 'display nat session' : 'show ip nat translations',
  );
}

describe('PRD-Port-Forwarding.md Phase 3 — selective clear (Cisco)', () => {
  it('clear ip nat translation inside <ip> removes only that host\'s session', async () => {
    const { router, pc1, pc2 } = await buildCiscoLab([
      'access-list 1 permit 192.168.10.0 0.0.0.255',
      'ip nat inside source list 1 interface GigabitEthernet0/1 overload',
    ]);
    await pc1.executeCommand('ping -c 1 203.0.113.2');
    await pc2.executeCommand('ping -c 1 203.0.113.2');

    let table = await showTranslations(router);
    expect(table).toContain(PC1_IP);
    expect(table).toContain(PC2_IP);

    await router.executeCommand(`clear ip nat translation inside ${PC1_IP}`);

    table = await showTranslations(router);
    expect(table).not.toContain(PC1_IP);
    expect(table).toContain(PC2_IP);
  });

  it('clear ip nat translation outside <ip> removes only sessions to that destination', async () => {
    const { router, pc1 } = await buildCiscoLab([
      'access-list 1 permit 192.168.10.0 0.0.0.255',
      'ip nat inside source list 1 interface GigabitEthernet0/1 overload',
    ]);
    await pc1.executeCommand('ping -c 1 203.0.113.2');
    await pc1.executeCommand('ping -c 1 203.0.113.3');

    let table = await showTranslations(router);
    expect(table).toContain('203.0.113.2');
    expect(table).toContain('203.0.113.3');

    await router.executeCommand('clear ip nat translation outside 203.0.113.2');

    table = await showTranslations(router);
    expect(table).not.toContain('203.0.113.2');
    expect(table).toContain('203.0.113.3');
  });

  it('clear ip nat translation pool <name> removes only sessions translated through that pool', async () => {
    const { router, pc1, pc2 } = await buildCiscoLab([
      'ip nat pool POOL1 203.0.113.50 203.0.113.50 netmask 255.255.255.0',
      'ip nat pool POOL2 203.0.113.60 203.0.113.60 netmask 255.255.255.0',
      'access-list 1 permit host 192.168.10.10',
      'access-list 2 permit host 192.168.10.20',
      'ip nat inside source list 1 pool POOL1',
      'ip nat inside source list 2 pool POOL2',
    ]);
    await pc1.executeCommand('ping -c 1 203.0.113.2');
    await pc2.executeCommand('ping -c 1 203.0.113.2');

    let table = await showTranslations(router);
    expect(table).toContain('203.0.113.50');
    expect(table).toContain('203.0.113.60');

    await router.executeCommand('clear ip nat translation pool POOL1');

    table = await showTranslations(router);
    expect(table).not.toContain('203.0.113.50');
    expect(table).toContain('203.0.113.60');
  });

  it('clear ip nat translation * still clears every dynamic session (no regression)', async () => {
    const { router, pc1, pc2 } = await buildCiscoLab([
      'access-list 1 permit 192.168.10.0 0.0.0.255',
      'ip nat inside source list 1 interface GigabitEthernet0/1 overload',
    ]);
    await pc1.executeCommand('ping -c 1 203.0.113.2');
    await pc2.executeCommand('ping -c 1 203.0.113.2');

    await router.executeCommand('clear ip nat translation *');

    const table = await showTranslations(router);
    expect(table).not.toContain(PC1_IP);
    expect(table).not.toContain(PC2_IP);
  });
});

interface HuaweiLab {
  router: HuaweiRouter;
  pc1: LinuxPC;
  pc2: LinuxPC;
}

async function buildHuaweiLab(): Promise<HuaweiLab> {
  const lanSw = new GenericSwitch('switch-generic', 'lan-sw', 8, 0, 0);
  const wanSw = new GenericSwitch('switch-generic', 'wan-sw', 8, 0, 0);
  const router = new HuaweiRouter('HW1', 0, 0);
  const pc1 = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const pc2 = new LinuxPC('linux-pc', 'PC2', 0, 0);
  const outside = new LinuxServer('linux-server', 'outside', 0, 0);

  new Cable('a').connect(pc1.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('b').connect(pc2.getPort('eth0')!, lanSw.getPorts()[1]);
  new Cable('c').connect(lanSw.getPorts()[7], router.getPort('GE0/0/0')!);
  new Cable('d').connect(router.getPort('GE0/0/1')!, wanSw.getPorts()[0]);
  new Cable('e').connect(wanSw.getPorts()[1], outside.getPort('eth0')!);

  const lanMask = new SubnetMask('255.255.255.0');
  pc1.getPorts()[0].configureIP(new IPAddress(PC1_IP), lanMask);
  pc1.setDefaultGateway(new IPAddress(GW_INSIDE));
  pc2.getPorts()[0].configureIP(new IPAddress(PC2_IP), lanMask);
  pc2.setDefaultGateway(new IPAddress(GW_INSIDE));

  const wanMask = new SubnetMask('255.255.255.252');
  outside.getPorts()[0].configureIP(new IPAddress('203.0.113.2'), wanMask);
  outside.setDefaultGateway(new IPAddress(GW_OUTSIDE));

  const cmds = [
    'system-view',
    'acl 2000',
    'rule 5 permit source 192.168.10.0 0.0.0.255',
    'quit',
    'interface GE0/0/0',
    `ip address ${GW_INSIDE} 255.255.255.0`,
    'nat inside', 'undo shutdown', 'quit',
    'interface GE0/0/1',
    `ip address ${GW_OUTSIDE} 255.255.255.252`,
    'undo shutdown',
    'nat outbound 2000',
    'quit',
  ];
  for (const cmd of cmds) await router.executeCommand(cmd);

  return { router, pc1, pc2 };
}

describe('PRD-Port-Forwarding.md Phase 3 — selective reset (Huawei)', () => {
  it('reset nat session inside <ip> removes only that host\'s session', async () => {
    const { router, pc1, pc2 } = await buildHuaweiLab();
    await pc1.executeCommand('ping -c 1 203.0.113.2');
    await pc2.executeCommand('ping -c 1 203.0.113.2');

    let table = await showTranslations(router);
    expect(table).toContain(PC1_IP);
    expect(table).toContain(PC2_IP);

    await router.executeCommand(`reset nat session inside ${PC1_IP}`);

    table = await showTranslations(router);
    expect(table).not.toContain(PC1_IP);
    expect(table).toContain(PC2_IP);
  });

  it('reset nat session all still clears every dynamic session (no regression)', async () => {
    const { router, pc1, pc2 } = await buildHuaweiLab();
    await pc1.executeCommand('ping -c 1 203.0.113.2');
    await pc2.executeCommand('ping -c 1 203.0.113.2');

    await router.executeCommand('reset nat session all');

    const table = await showTranslations(router);
    expect(table).not.toContain(PC1_IP);
    expect(table).not.toContain(PC2_IP);
  });
});
