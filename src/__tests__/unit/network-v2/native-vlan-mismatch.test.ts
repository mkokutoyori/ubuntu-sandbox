import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
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

async function ciscoTrunkWithNative(sw: CiscoSwitch, port: string, native: number): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`interface ${port}`);
  await sw.executeCommand('switchport mode trunk');
  await sw.executeCommand(`switchport trunk native vlan ${native}`);
  await sw.executeCommand('end');
}

describe('802.1Q Phase 7 — native VLAN mismatch detection (Cisco, via CDP native-VLAN TLV)', () => {
  it('detects a mismatch and logs the real %CDP-4-NATIVE_VLAN_MISMATCH message', async () => {
    const bus = new EventBus();
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
    s1.setEventBus(bus); s2.setEventBus(bus);
    await ciscoTrunkWithNative(s1, 'FastEthernet0/1', 1);
    await ciscoTrunkWithNative(s2, 'FastEthernet0/1', 99);

    const mismatches: unknown[] = [];
    bus.subscribe('cdp.native-vlan.mismatch', (e) => mismatches.push(e.payload));

    new Cable('w').connect(s1.getPort('FastEthernet0/1')!, s2.getPort('FastEthernet0/1')!);

    expect(mismatches.length).toBeGreaterThan(0);
    const logs = Logger.getLogs();
    expect(logs.some(l => l.event === 'cdp:native-vlan-mismatch'
      && /Native VLAN mismatch/.test(l.message))).toBe(true);
  });

  it('stays silent when both trunk ends agree on the native VLAN', async () => {
    const bus = new EventBus();
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
    s1.setEventBus(bus); s2.setEventBus(bus);
    await ciscoTrunkWithNative(s1, 'FastEthernet0/1', 50);
    await ciscoTrunkWithNative(s2, 'FastEthernet0/1', 50);

    const mismatches: unknown[] = [];
    bus.subscribe('cdp.native-vlan.mismatch', (e) => mismatches.push(e.payload));

    new Cable('w').connect(s1.getPort('FastEthernet0/1')!, s2.getPort('FastEthernet0/1')!);

    expect(mismatches).toHaveLength(0);
  });
});

describe('802.1Q Phase 7 — Huawei has no equivalent (LLDP carries no native-VLAN TLV)', () => {
  it('two Huawei trunks with different PVIDs never raise any mismatch, by design', async () => {
    const bus = new EventBus();
    const s1 = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    const s2 = new HuaweiSwitch('switch-huawei', 'SW2', 8);
    s1.setEventBus(bus); s2.setEventBus(bus);
    await s1.executeCommand('system-view');
    await s1.executeCommand('interface GigabitEthernet0/0/1');
    await s1.executeCommand('port link-type trunk');
    await s1.executeCommand('port trunk pvid vlan 1');
    await s1.executeCommand('quit');
    await s2.executeCommand('system-view');
    await s2.executeCommand('interface GigabitEthernet0/0/1');
    await s2.executeCommand('port link-type trunk');
    await s2.executeCommand('port trunk pvid vlan 99');
    await s2.executeCommand('quit');

    const events: unknown[] = [];
    bus.subscribe('cdp.native-vlan.mismatch', (e) => events.push(e.payload));

    new Cable('w').connect(s1.getPort('GigabitEthernet0/0/1')!, s2.getPort('GigabitEthernet0/0/1')!);

    expect(events).toHaveLength(0);
    const logs = Logger.getLogs();
    expect(logs.some(l => /native.vlan.mismatch/i.test(l.event))).toBe(false);
  });
});
