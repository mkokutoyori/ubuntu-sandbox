import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function enablePortFastWithBpduGuard(sw: CiscoSwitch, port: string): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`interface ${port}`);
  await sw.executeCommand('spanning-tree portfast');
  await sw.executeCommand('spanning-tree bpduguard enable');
  await sw.executeCommand('end');
}

async function enableRootGuard(sw: CiscoSwitch, port: string): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`interface ${port}`);
  await sw.executeCommand('spanning-tree guard root');
  await sw.executeCommand('end');
}

describe('STP guards — PortFast', () => {
  it('spanning-tree portfast records the flag and the port forwards by default', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('spanning-tree portfast');
    await sw.executeCommand('end');
    expect(sw.getStpAgent().getPortGuards('FastEthernet0/0').portFast).toBe(true);
    expect(sw.getSTPState('FastEthernet0/0')).toBe('forwarding');
  });

  it('no spanning-tree portfast clears the flag', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('spanning-tree portfast');
    expect(sw.getStpAgent().getPortGuards('FastEthernet0/0').portFast).toBe(true);
    await sw.executeCommand('no spanning-tree portfast');
    expect(sw.getStpAgent().getPortGuards('FastEthernet0/0').portFast).toBe(false);
  });
});

describe('STP guards — BPDU Guard', () => {
  it('bpduguard enable err-disables the port on first received BPDU', async () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const rogue = new CiscoSwitch('switch-cisco', 'ROGUE', 8);
    sw.setEventBus(bus);
    rogue.setEventBus(bus);
    await rogue.executeCommand('enable');
    await rogue.executeCommand('configure terminal');
    await rogue.executeCommand('spanning-tree vlan 1 priority 4096');
    await rogue.executeCommand('end');
    await enablePortFastWithBpduGuard(sw, 'FastEthernet0/0');

    const violations: Array<{ port: string; senderMac: string }> = [];
    bus.subscribe('stp.bpdu-guard.violation', (e) => violations.push(e.payload));

    new Cable('w').connect(sw.getPort('FastEthernet0/0')!,
                            rogue.getPort('FastEthernet0/0')!);

    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].port).toBe('FastEthernet0/0');
    expect(sw.getPort('FastEthernet0/0')!.getIsUp()).toBe(false);
    expect(sw.getSTPState('FastEthernet0/0')).toBe('disabled');
  });

  it('global "portfast bpduguard default" implies BPDU Guard on PortFast ports', async () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const rogue = new CiscoSwitch('switch-cisco', 'ROGUE', 8);
    sw.setEventBus(bus);
    rogue.setEventBus(bus);
    await rogue.executeCommand('enable');
    await rogue.executeCommand('configure terminal');
    await rogue.executeCommand('spanning-tree vlan 1 priority 4096');
    await rogue.executeCommand('end');
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('spanning-tree portfast bpduguard default');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('spanning-tree portfast');
    await sw.executeCommand('end');

    const violations: Array<{ port: string }> = [];
    bus.subscribe('stp.bpdu-guard.violation', (e) => violations.push(e.payload));
    new Cable('w').connect(sw.getPort('FastEthernet0/0')!,
                            rogue.getPort('FastEthernet0/0')!);
    expect(violations.length).toBeGreaterThan(0);
    expect(sw.getPort('FastEthernet0/0')!.getIsUp()).toBe(false);
  });

  it('without BPDU Guard the port accepts BPDUs normally', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const rogue = new CiscoSwitch('switch-cisco', 'ROGUE', 8);
    await rogue.executeCommand('enable');
    await rogue.executeCommand('configure terminal');
    await rogue.executeCommand('spanning-tree vlan 1 priority 4096');
    await rogue.executeCommand('end');
    new Cable('w').connect(sw.getPort('FastEthernet0/0')!,
                            rogue.getPort('FastEthernet0/0')!);
    expect(sw.getPort('FastEthernet0/0')!.getIsUp()).toBe(true);
  });
});

describe('STP guards — Root Guard', () => {
  it('root guard blocks a port that advertises a superior root', async () => {
    const bus = new EventBus();
    const local = new CiscoSwitch('switch-cisco', 'LOCAL', 8);
    const rogue = new CiscoSwitch('switch-cisco', 'ROGUE', 8);
    local.setEventBus(bus);
    rogue.setEventBus(bus);
    await rogue.executeCommand('enable');
    await rogue.executeCommand('configure terminal');
    await rogue.executeCommand('spanning-tree vlan 1 priority 0');
    await rogue.executeCommand('end');
    await enableRootGuard(local, 'FastEthernet0/0');

    const events: Array<{ port: string; state: string }> = [];
    bus.subscribe('stp.root-guard.changed', (e) => events.push(e.payload));
    new Cable('w').connect(local.getPort('FastEthernet0/0')!,
                            rogue.getPort('FastEthernet0/0')!);

    expect(events.some(e => e.state === 'inconsistent')).toBe(true);
    expect(local.getStpAgent().isRootInconsistent('FastEthernet0/0')).toBe(true);
    expect(local.getStpAgent().getPortRole('FastEthernet0/0')).toBe('alternate');
    expect(local.getSTPState('FastEthernet0/0')).toBe('blocking');
    expect(local.getStpAgent().isRoot()).toBe(true);
  });

  it('root guard does not affect a port whose peer advertises an inferior root', async () => {
    const local = new CiscoSwitch('switch-cisco', 'LOCAL', 8);
    const inferior = new CiscoSwitch('switch-cisco', 'INFERIOR', 8);
    await local.executeCommand('enable');
    await local.executeCommand('configure terminal');
    await local.executeCommand('spanning-tree vlan 1 priority 4096');
    await local.executeCommand('end');
    await enableRootGuard(local, 'FastEthernet0/0');
    new Cable('w').connect(local.getPort('FastEthernet0/0')!,
                            inferior.getPort('FastEthernet0/0')!);
    expect(local.getStpAgent().isRootInconsistent('FastEthernet0/0')).toBe(false);
    expect(local.getStpAgent().getPortRole('FastEthernet0/0')).toBe('designated');
  });

  it('clearRootInconsistent restores the port', async () => {
    const local = new CiscoSwitch('switch-cisco', 'LOCAL', 8);
    const rogue = new CiscoSwitch('switch-cisco', 'ROGUE', 8);
    await rogue.executeCommand('enable');
    await rogue.executeCommand('configure terminal');
    await rogue.executeCommand('spanning-tree vlan 1 priority 0');
    await rogue.executeCommand('end');
    await enableRootGuard(local, 'FastEthernet0/0');
    new Cable('w').connect(local.getPort('FastEthernet0/0')!,
                            rogue.getPort('FastEthernet0/0')!);
    expect(local.getStpAgent().isRootInconsistent('FastEthernet0/0')).toBe(true);
    local.getStpAgent().clearRootInconsistent('FastEthernet0/0');
    expect(local.getStpAgent().isRootInconsistent('FastEthernet0/0')).toBe(false);
  });
});

describe('STP guards — CLI persistence', () => {
  it('running-config records portfast / bpduguard / guard root via ifStp', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await enablePortFastWithBpduGuard(sw, 'FastEthernet0/0');
    await enableRootGuard(sw, 'FastEthernet0/1');
    const out = sw.getRunningConfig();
    expect(out).toMatch(/interface FastEthernet0\/0[\s\S]*?spanning-tree portfast/);
    expect(out).toMatch(/spanning-tree bpduguard enable/);
    expect(out).toMatch(/interface FastEthernet0\/1[\s\S]*?spanning-tree guard root/);
  });
});
