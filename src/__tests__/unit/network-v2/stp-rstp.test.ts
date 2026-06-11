import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

afterEach(() => {
  vi.useRealTimers();
});

async function setRapidPvst(sw: CiscoSwitch): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('spanning-tree mode rapid-pvst');
  await sw.executeCommand('end');
}

async function makeRoot(sw: CiscoSwitch): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('spanning-tree vlan 1 priority 4096');
  await sw.executeCommand('end');
}

describe('RSTP (802.1w subset)', () => {
  it('spanning-tree mode rapid-pvst switches the agent into rstp', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    expect(sw.getStpAgent().getMode()).toBe('stp');
    await setRapidPvst(sw);
    expect(sw.getStpAgent().getMode()).toBe('rstp');
  });

  it('Huawei: stp mode rstp switches the agent into rstp', async () => {
    const { HuaweiSwitch } = await import('@/network/devices/HuaweiSwitch');
    const sw = new HuaweiSwitch('switch-huawei', 'HW1');
    await sw.executeCommand('system-view');
    await sw.executeCommand('stp mode rstp');
    expect(sw.getStpAgent().getMode()).toBe('rstp');
  });

  it('proposal/agreement: a blocked port turned designated forwards without timers', async () => {
    vi.useFakeTimers();
    const root = new CiscoSwitch('switch-cisco', 'ROOT', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    await setRapidPvst(root);
    await setRapidPvst(sw2);
    await makeRoot(root);
    new Cable('a').connect(root.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    new Cable('b').connect(root.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);
    const states = () => ['FastEthernet0/0', 'FastEthernet0/1']
      .map(p => sw2.getStpAgent().getForwardState(p));
    expect(states()).toContain('blocking');

    sw2.getStpAgent().setBridgePriority(0);

    expect(sw2.getStpAgent().isRoot()).toBe(true);
    expect(root.getStpAgent().getRootPort()).toBe('FastEthernet0/0');
    expect(sw2.getStpAgent().getForwardState('FastEthernet0/0')).toBe('forwarding');
    expect(root.getStpAgent().getForwardState('FastEthernet0/0')).toBe('forwarding');
    expect(sw2.getStpAgent().getForwardState('FastEthernet0/1')).toBe('forwarding');
    expect(root.getStpAgent().getForwardState('FastEthernet0/1')).toBe('blocking');
  });

  it('in legacy stp mode the same change walks listening → learning instead', async () => {
    vi.useFakeTimers();
    const root = new CiscoSwitch('switch-cisco', 'ROOT', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    await makeRoot(root);
    new Cable('a').connect(root.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    new Cable('b').connect(root.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);
    expect(['FastEthernet0/0', 'FastEthernet0/1']
      .map(p => sw2.getStpAgent().getForwardState(p))).toContain('blocking');

    sw2.getStpAgent().setBridgePriority(0);

    const states = ['FastEthernet0/0', 'FastEthernet0/1']
      .map(p => sw2.getStpAgent().getForwardState(p));
    expect(states).toContain('listening');
  });

  it('failover: the surviving port becomes root port and forwards immediately', async () => {
    vi.useFakeTimers();
    const root = new CiscoSwitch('switch-cisco', 'ROOT', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    await setRapidPvst(root);
    await setRapidPvst(sw2);
    await makeRoot(root);
    const a = new Cable('a');
    a.connect(root.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    new Cable('b').connect(root.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);
    expect(sw2.getStpAgent().getForwardState('FastEthernet0/1')).toBe('blocking');

    a.disconnect();

    expect(sw2.getStpAgent().getRootPort()).toBe('FastEthernet0/1');
    expect(sw2.getStpAgent().getForwardState('FastEthernet0/1')).toBe('forwarding');
  });

  it('topology change uses tcWhile propagation, never TCN BPDUs', async () => {
    const bus = new EventBus();
    const root = new CiscoSwitch('switch-cisco', 'ROOT', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    const sw3 = new CiscoSwitch('switch-cisco', 'SW3', 4);
    root.setEventBus(bus); sw2.setEventBus(bus); sw3.setEventBus(bus);
    await setRapidPvst(root);
    await setRapidPvst(sw2);
    await setRapidPvst(sw3);
    await makeRoot(root);
    new Cable('a').connect(root.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    const leaf = new Cable('b');
    leaf.connect(sw2.getPort('FastEthernet0/1')!, sw3.getPort('FastEthernet0/0')!);

    const tcns: string[] = [];
    bus.subscribe('stp.tcn.sent', (e) => tcns.push((e.payload as { deviceId: string }).deviceId));

    leaf.disconnect();

    expect(tcns).toHaveLength(0);
    expect(sw2.getStpAgent().isTopologyChangeActive()).toBe(true);
    expect(sw2.getStpAgent().isFastAgingActive()).toBe(true);
    expect(root.getStpAgent().isFastAgingActive()).toBe(true);
  });
});
