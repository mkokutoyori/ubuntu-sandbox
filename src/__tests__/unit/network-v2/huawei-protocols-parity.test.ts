import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
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

async function enableLldp(sw: HuaweiSwitch | HuaweiRouter): Promise<void> {
  await sw.executeCommand('system-view');
  await sw.executeCommand('lldp enable');
  await sw.executeCommand('quit');
}

describe('Huawei LLDP — switch parity', () => {
  it('lldp enable starts the agent', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    expect(sw.getLldpAgent().getConfig().enabled).toBe(false);
    await enableLldp(sw);
    expect(sw.getLldpAgent().getConfig().enabled).toBe(true);
  });

  it('two Huawei switches discover each other through LLDP', async () => {
    const s1 = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    const s2 = new HuaweiSwitch('switch-huawei', 'SW2', 4);
    new Cable('w').connect(s1.getPort('GigabitEthernet0/0/0')!,
                            s2.getPort('GigabitEthernet0/0/0')!);
    await enableLldp(s1);
    await enableLldp(s2);
    const n1 = s1.getLldpAgent().getNeighbors();
    const n2 = s2.getLldpAgent().getNeighbors();
    expect(n1[0]?.systemName).toBe('SW2');
    expect(n2[0]?.systemName).toBe('SW1');
  });

  it('Huawei switch sees Cisco switch via LLDP (vendor-neutral)', async () => {
    const huawei = new HuaweiSwitch('switch-huawei', 'HW1', 4);
    const cisco = new CiscoSwitch('switch-cisco', 'CSCO1', 4);
    new Cable('w').connect(huawei.getPort('GigabitEthernet0/0/0')!,
                            cisco.getPort('FastEthernet0/0')!);
    await enableLldp(huawei);
    await cisco.executeCommand('enable');
    await cisco.executeCommand('configure terminal');
    await cisco.executeCommand('lldp run');
    await cisco.executeCommand('end');
    const seen = huawei.getLldpAgent().getNeighbors();
    expect(seen[0]?.systemName).toBe('CSCO1');
  });

  it('display lldp neighbor brief lists discovered peers', async () => {
    const s1 = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    const s2 = new HuaweiSwitch('switch-huawei', 'SW2', 4);
    new Cable('w').connect(s1.getPort('GigabitEthernet0/0/0')!,
                            s2.getPort('GigabitEthernet0/0/0')!);
    await enableLldp(s1);
    await enableLldp(s2);
    const out = await s1.executeCommand('display lldp neighbor brief');
    expect(out).toMatch(/SW2/);
    expect(out).toMatch(/GigabitEthernet0\/0\/0/);
  });

  it('lldp timer / hold-multiplier knobs drive the agent', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    await sw.executeCommand('system-view');
    await sw.executeCommand('lldp enable');
    await sw.executeCommand('lldp message-transmission interval 10');
    await sw.executeCommand('lldp message-transmission hold-multiplier 5');
    await sw.executeCommand('quit');
    const cfg = sw.getLldpAgent().getConfig();
    expect(cfg.timerSec).toBe(10);
    expect(cfg.holdtimeMultiplier).toBe(5);
  });
});

describe('Huawei LLDP — router parity', () => {
  it('two Huawei routers discover each other', async () => {
    const r1 = new HuaweiRouter('R1');
    const r2 = new HuaweiRouter('R2');
    new Cable('w').connect(r1.getPort('GE0/0/0')!, r2.getPort('GE0/0/0')!);
    await enableLldp(r1);
    await enableLldp(r2);
    expect(r1.getLldpAgent().getNeighbors()[0]?.systemName).toBe('R2');
    expect(r2.getLldpAgent().getNeighbors()[0]?.systemName).toBe('R1');
  });
});

describe('Huawei STP — switch parity', () => {
  it('stp enable / stp disable drives the agent', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    expect(sw.getStpAgent().getConfig().enabled).toBe(true);
    await sw.executeCommand('system-view');
    await sw.executeCommand('stp disable');
    await sw.executeCommand('quit');
    expect(sw.getStpAgent().getConfig().enabled).toBe(false);
    await sw.executeCommand('system-view');
    await sw.executeCommand('stp enable');
    await sw.executeCommand('quit');
    expect(sw.getStpAgent().getConfig().enabled).toBe(true);
  });

  it('stp priority drives the bridge priority and wins the election', async () => {
    const winner = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    const loser = new HuaweiSwitch('switch-huawei', 'SW2', 4);
    await winner.executeCommand('system-view');
    await winner.executeCommand('stp priority 4096');
    await winner.executeCommand('quit');
    new Cable('w').connect(winner.getPort('GigabitEthernet0/0/0')!,
                            loser.getPort('GigabitEthernet0/0/0')!);
    expect(winner.getStpAgent().isRoot()).toBe(true);
    expect(loser.getStpAgent().isRoot()).toBe(false);
    expect(loser.getStpAgent().getRootPort()).toBe('GigabitEthernet0/0/0');
  });

  it('stp root primary sets priority to 0', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    await sw.executeCommand('system-view');
    await sw.executeCommand('stp root primary');
    await sw.executeCommand('quit');
    expect(sw.getStpAgent().getConfig().bridgePriority).toBe(0);
  });

  it('display stp brief shows live roles and states', async () => {
    const winner = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    const loser = new HuaweiSwitch('switch-huawei', 'SW2', 4);
    await winner.executeCommand('system-view');
    await winner.executeCommand('stp priority 4096');
    await winner.executeCommand('quit');
    new Cable('w').connect(winner.getPort('GigabitEthernet0/0/0')!,
                            loser.getPort('GigabitEthernet0/0/0')!);
    const out = await loser.executeCommand('display stp brief');
    expect(out).toMatch(/GigabitEthernet0\/0\/0[\s\S]*?ROOT[\s\S]*?FORWARDING/);
  });
});

describe('Huawei STP — interoperability with Cisco', () => {
  it('Cisco lower priority wins; Huawei facing port becomes root', async () => {
    const cisco = new CiscoSwitch('switch-cisco', 'CSCO1', 4);
    const huawei = new HuaweiSwitch('switch-huawei', 'HW1', 4);
    await cisco.executeCommand('enable');
    await cisco.executeCommand('configure terminal');
    await cisco.executeCommand('spanning-tree vlan 1 priority 4096');
    await cisco.executeCommand('end');
    new Cable('w').connect(cisco.getPort('FastEthernet0/0')!,
                            huawei.getPort('GigabitEthernet0/0/0')!);
    expect(cisco.getStpAgent().isRoot()).toBe(true);
    expect(huawei.getStpAgent().isRoot()).toBe(false);
    expect(huawei.getStpAgent().getPortRole('GigabitEthernet0/0/0')).toBe('root');
  });
});

describe('Huawei STP — reactive', () => {
  it('stp.root.changed fires on the Huawei loser', async () => {
    const bus = new EventBus();
    const winner = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    const loser = new HuaweiSwitch('switch-huawei', 'SW2', 4);
    winner.setEventBus(bus);
    loser.setEventBus(bus);
    await winner.executeCommand('system-view');
    await winner.executeCommand('stp priority 4096');
    await winner.executeCommand('quit');
    const changes: Array<{ deviceId: string }> = [];
    bus.subscribe('stp.root.changed', (e) => changes.push(e.payload));
    new Cable('w').connect(winner.getPort('GigabitEthernet0/0/0')!,
                            loser.getPort('GigabitEthernet0/0/0')!);
    expect(changes.some(c => c.deviceId === loser.id)).toBe(true);
  });
});
