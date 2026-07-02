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

const MASK = '255.255.255.0';
const PC_IP = '10.0.0.1';
const CISCO_IP = '10.0.0.6';
const HUAWEI_IP = '10.0.0.8';

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

function listenerPorts(router: CiscoRouter | HuaweiRouter): number[] {
  return (router as unknown as { getTcpStack: () => { listListeners: () => Array<{ localPort: number }> } })
    .getTcpStack().listListeners().map(l => l.localPort);
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('telnet toward a router VTY travels the wire', () => {
  it('a cabled router with default transport accepts the telnet connection', async () => {
    const { pc, cisco } = await buildCiscoLan();

    expect(listenerPorts(cisco)).toContain(23);
    const out = await pc.executeCommand(`telnet ${CISCO_IP}`);
    expect(out).toMatch(/Connected to/);
    expect(out).not.toMatch(/Connection refused/);
  });

  it('transport input ssh unbinds TCP/23 and telnet is refused on the wire', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (const cmd of [
      'enable', 'configure terminal', 'line vty 0 4', 'transport input ssh', 'end',
    ]) await cisco.executeCommand(cmd);

    expect(listenerPorts(cisco)).not.toContain(23);
    const out = await pc.executeCommand(`telnet ${CISCO_IP}`);
    expect(out).toMatch(/Connection refused/);
  });

  it('transport input none closes both vty transports', async () => {
    const { cisco } = await buildCiscoLan();
    for (const cmd of [
      'enable', 'configure terminal', 'line vty 0 4', 'transport input none', 'end',
    ]) await cisco.executeCommand(cmd);

    expect(listenerPorts(cisco)).not.toContain(22);
    expect(listenerPorts(cisco)).not.toContain(23);
  });

  it('restoring transport input all rebinds TCP/23', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (const cmd of [
      'enable', 'configure terminal', 'line vty 0 4', 'transport input ssh', 'end',
    ]) await cisco.executeCommand(cmd);
    expect(listenerPorts(cisco)).not.toContain(23);

    for (const cmd of [
      'configure terminal', 'line vty 0 4', 'transport input all', 'end',
    ]) await cisco.executeCommand(cmd);

    expect(listenerPorts(cisco)).toContain(23);
    const out = await pc.executeCommand(`telnet ${CISCO_IP}`);
    expect(out).toMatch(/Connected to/);
  });

  it('a denying access-class refuses the telnet session', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (const cmd of [
      'enable', 'configure terminal',
      'access-list 20 permit 10.0.0.99',
      'line vty 0 4', 'access-class 20 in', 'end',
    ]) await cisco.executeCommand(cmd);

    const out = await pc.executeCommand(`telnet ${CISCO_IP}`);

    expect(out).toMatch(/Connection refused/);
  });

  it('a line that mandates an unset password answers "Password required, but none set"', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (const cmd of [
      'enable', 'configure terminal',
      'line vty 0 4', 'login', 'end',
    ]) await cisco.executeCommand(cmd);

    const out = await pc.executeCommand(`telnet ${CISCO_IP}`);

    expect(out).toMatch(/Password required, but none set/);
  });

  it('Huawei protocol inbound ssh refuses telnet on the wire', async () => {
    const { pc, huawei } = await buildHuaweiLan();
    for (const cmd of [
      'system-view', 'user-interface vty 0 4', 'protocol inbound ssh', 'quit', 'quit',
    ]) await huawei.executeCommand(cmd);

    expect(listenerPorts(huawei)).not.toContain(23);
    const out = await pc.executeCommand(`telnet ${HUAWEI_IP}`);
    expect(out).toMatch(/Connection refused/);
  });
});
