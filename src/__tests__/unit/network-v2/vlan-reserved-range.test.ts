import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

describe('Reserved VLAN range — universal IEEE bounds', () => {
  it('createVLAN rejects VID 0 and 4095 on both vendors', () => {
    const cisco = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const huawei = new HuaweiSwitch('switch-huawei', 'SW2', 8);
    for (const sw of [cisco, huawei]) {
      expect(sw.createVLAN(0)).toBe(false);
      expect(sw.createVLAN(4095)).toBe(false);
    }
  });
});

describe('Reserved VLAN range — Cisco 1002-1005 (legacy FDDI/Token Ring)', () => {
  it('the CLI refuses vlan 1002-1005 with an explicit message', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    const out = await sw.executeCommand('vlan 1002');
    expect(out).toContain('%');
    expect(out).toMatch(/reserved/i);
    expect(sw.getVLAN(1002)).toBeUndefined();
    const range = await sw.executeCommand('vlan 1000-1003');
    expect(range).toMatch(/reserved/i);
    expect(sw.getVLAN(1000)).toBeUndefined();
  });

  it('the engine rejects create and delete of 1002-1005 even when bypassing the CLI', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    for (const id of [1002, 1003, 1004, 1005]) {
      expect(sw.createVLAN(id)).toBe(false);
      expect(sw.deleteVLAN(id)).toBe(false);
    }
  });

  it('adjacent VIDs 1001 stay usable on Cisco', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 1001');
    await sw.executeCommand('end');
    expect(sw.getVLAN(1001)).toBeDefined();
  });

  it('Huawei does NOT reserve 1002-1005 (no artificial vendor parity)', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan 1002');
    await sw.executeCommand('quit');
    expect(sw.getVLAN(1002)).toBeDefined();
    expect(sw.createVLAN(1003)).toBe(true);
  });
});
