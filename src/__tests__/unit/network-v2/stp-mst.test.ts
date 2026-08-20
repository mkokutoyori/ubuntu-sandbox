/**
 * TDD — real MSTP: CIST + independent MSTIs, per audit 01 constat critique
 * ("MSTP n'existe pas réellement, seulement en façade" — `spanning-tree
 * mode mst` was silently remapped to RSTP, and `showMstInstances`/
 * `display stp instance` always echoed the single CST/VLAN1 tree for every
 * MST instance shown, regardless of which VLANs were really mapped to it).
 */
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

async function provisionCiscoMst(sw: CiscoSwitch, port: string): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('vlan 10');
  await sw.executeCommand('exit');
  await sw.executeCommand('vlan 20');
  await sw.executeCommand('exit');
  await sw.executeCommand(`interface ${port}`);
  await sw.executeCommand('switchport trunk encapsulation dot1q');
  await sw.executeCommand('switchport mode trunk');
  await sw.executeCommand('exit');
  await sw.executeCommand('spanning-tree mode mst');
  await sw.executeCommand('spanning-tree mst configuration');
  await sw.executeCommand('name LAB');
  await sw.executeCommand('revision 1');
  await sw.executeCommand('instance 1 vlan 10');
  await sw.executeCommand('exit');
  await sw.executeCommand('end');
}

describe('MSTP — independent CIST + MSTI election (Cisco)', () => {
  it('elects a different root per MST instance from real per-instance BPDUs', async () => {
    const bus = new EventBus();
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    sw1.setEventBus(bus);
    sw2.setEventBus(bus);

    await provisionCiscoMst(sw1, 'FastEthernet0/1');
    await provisionCiscoMst(sw2, 'FastEthernet0/1');

    new Cable('trunk').connect(
      sw1.getPort('FastEthernet0/1')!,
      sw2.getPort('FastEthernet0/1')!,
    );

    // SW1 is created first (lower MAC) and wins CIST (instance 0) by the
    // default tie-break. Make SW2 root of MSTI 1 (VLAN 10) explicitly —
    // a real per-instance divergence that a single shared CST/RSTP tree
    // cannot produce.
    await sw2.executeCommand('enable');
    await sw2.executeCommand('configure terminal');
    await sw2.executeCommand('spanning-tree mst 1 priority 0');
    await sw2.executeCommand('end');

    const a = sw1.getStpAgent();
    const b = sw2.getStpAgent();

    expect(a.getMode()).toBe('mstp');

    // CIST (instance 0): SW1 is root.
    expect(a.isRootForInstance(0)).toBe(true);
    expect(b.isRootForInstance(0)).toBe(false);
    expect(a.getPortRoleForInstance(0, 'FastEthernet0/1')).toBe('designated');
    expect(b.getPortRoleForInstance(0, 'FastEthernet0/1')).toBe('root');

    // MSTI 1 (VLAN 10): SW2 is root — the opposite of CIST on the very
    // same physical port, which is only possible with independent MSTIs.
    expect(b.isRootForInstance(1)).toBe(true);
    expect(a.isRootForInstance(1)).toBe(false);
    // 802.1t: the instance number lives in the low 12 bits of the
    // priority, so MSTI 1 at priority 0 is a bridge ID priority of 1.
    expect(b.getRootBridgeForInstance(1).priority).toBe(1);
    expect(a.getRootPortForInstance(1)).toBe('FastEthernet0/1');
    expect(a.getPortRoleForInstance(1, 'FastEthernet0/1')).toBe('root');
    expect(b.getPortRoleForInstance(1, 'FastEthernet0/1')).toBe('designated');
  });

  it('show spanning-tree mst <id> renders the true per-instance role, not a CST facade', async () => {
    const bus = new EventBus();
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    sw1.setEventBus(bus);
    sw2.setEventBus(bus);

    await provisionCiscoMst(sw1, 'FastEthernet0/1');
    await provisionCiscoMst(sw2, 'FastEthernet0/1');
    new Cable('trunk').connect(
      sw1.getPort('FastEthernet0/1')!,
      sw2.getPort('FastEthernet0/1')!,
    );

    await sw2.executeCommand('enable');
    await sw2.executeCommand('configure terminal');
    await sw2.executeCommand('spanning-tree mst 1 priority 0');
    await sw2.executeCommand('end');

    await sw1.executeCommand('enable');
    const mst0 = await sw1.executeCommand('show spanning-tree mst 0');
    const mst1 = await sw1.executeCommand('show spanning-tree mst 1');

    // Same switch, same physical port — opposite roles across the two
    // instance blocks. The pre-fix facade printed the identical CST role
    // (and identical Sts) in both blocks regardless of instance id.
    expect(mst0).toMatch(/Fa0\/1\s+Desg/);
    expect(mst1).toMatch(/Fa0\/1\s+Root/);
    expect(mst0).not.toEqual(mst1);
  });
});

async function provisionHuaweiMst(sw: HuaweiSwitch, port: string): Promise<void> {
  await sw.executeCommand('system-view');
  await sw.executeCommand('vlan batch 10 20');
  await sw.executeCommand(`interface ${port}`);
  await sw.executeCommand('port link-type trunk');
  await sw.executeCommand('port trunk allow-pass vlan 10 20');
  await sw.executeCommand('quit');
  await sw.executeCommand('stp region-configuration');
  await sw.executeCommand('region-name LAB');
  await sw.executeCommand('revision-level 1');
  await sw.executeCommand('instance 1 vlan 10');
  await sw.executeCommand('active region-configuration');
  await sw.executeCommand('quit');
  await sw.executeCommand('stp mode mstp');
  await sw.executeCommand('quit');
}

describe('MSTP — independent CIST + MSTI election (Huawei)', () => {
  it('display stp instance <id> renders the true per-instance role', async () => {
    const bus = new EventBus();
    const sw1 = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    const sw2 = new HuaweiSwitch('switch-huawei', 'SW2', 4);
    sw1.setEventBus(bus);
    sw2.setEventBus(bus);

    await provisionHuaweiMst(sw1, 'GigabitEthernet0/0/1');
    await provisionHuaweiMst(sw2, 'GigabitEthernet0/0/1');
    new Cable('trunk').connect(
      sw1.getPort('GigabitEthernet0/0/1')!,
      sw2.getPort('GigabitEthernet0/0/1')!,
    );

    await sw2.executeCommand('system-view');
    await sw2.executeCommand('stp instance 1 priority 0');
    await sw2.executeCommand('quit');

    const a = sw1.getStpAgent();
    const b = sw2.getStpAgent();
    expect(a.getMode()).toBe('mstp');
    expect(a.isRootForInstance(0)).toBe(true);
    expect(b.isRootForInstance(1)).toBe(true);

    const inst0 = await sw1.executeCommand('display stp instance 0');
    const inst1 = await sw1.executeCommand('display stp instance 1');

    expect(inst0).toMatch(/GigabitEthernet0\/0\/1\s+DESI/);
    expect(inst1).toMatch(/GigabitEthernet0\/0\/1\s+ROOT/);
    expect(inst0).not.toEqual(inst1);
  });
});
