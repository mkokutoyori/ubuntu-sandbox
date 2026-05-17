/**
 * TDD — Huawei switch STP/RSTP/MSTP CLI (L2-only, switch-specific).
 *
 * Surfaced by debug-output/huawei/huawei-security-mgmt: the whole `stp`
 * / `display stp` family was "Unrecognized command".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

async function sysSwitch(): Promise<HuaweiSwitch> {
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
  await sw.executeCommand('system-view');
  return sw;
}

describe('Huawei STP — system-view configuration', () => {
  it('stp enable / disable / mode are recognized', async () => {
    const sw = await sysSwitch();
    for (const c of ['stp enable', 'stp mode rstp', 'stp mode mstp',
      'stp mode stp', 'stp disable', 'stp enable']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Unrecognized command/);
    }
  });

  it('stp priority / root primary|secondary are recognized', async () => {
    const sw = await sysSwitch();
    expect(await sw.executeCommand('stp priority 4096')).not.toMatch(/Unrecognized/);
    expect(await sw.executeCommand('stp root primary')).not.toMatch(/Unrecognized/);
    expect(await sw.executeCommand('stp root secondary')).not.toMatch(/Unrecognized/);
    expect(await sw.executeCommand('stp bpdu-protection')).not.toMatch(/Unrecognized/);
  });

  it('display stp reflects the configured mode', async () => {
    const sw = await sysSwitch();
    await sw.executeCommand('stp mode rstp');
    await sw.executeCommand('return');
    const out = await sw.executeCommand('display stp');
    expect(out).not.toMatch(/Unrecognized command/);
    expect(out).toMatch(/RSTP|Mode\s+RSTP/i);
  });

  it('display stp brief lists ports with role/state', async () => {
    const sw = await sysSwitch();
    await sw.executeCommand('return');
    const out = await sw.executeCommand('display stp brief');
    expect(out).not.toMatch(/Unrecognized command/);
    expect(out).toMatch(/GigabitEthernet0\/0\/1/);
  });
});

describe('Huawei STP — interface-view configuration', () => {
  it('stp edged-port / bpdu-protection / cost / port priority recognized', async () => {
    const sw = await sysSwitch();
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    for (const c of ['stp edged-port enable', 'stp bpdu-protection',
      'stp cost 20000', 'stp port priority 64', 'stp disable', 'stp enable']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Unrecognized command/);
    }
    const out = await sw.executeCommand('display this');
    expect(out).toContain('stp edged-port enable');
  });

  it('display stp interface <if> works', async () => {
    const sw = await sysSwitch();
    await sw.executeCommand('return');
    const out = await sw.executeCommand('display stp interface GigabitEthernet0/0/1');
    expect(out).not.toMatch(/Unrecognized command/);
    expect(out).toMatch(/GigabitEthernet0\/0\/1/);
  });
});

describe('Huawei STP — MST region sub-view', () => {
  it('stp region-configuration enters region view and accepts members', async () => {
    const sw = await sysSwitch();
    await sw.executeCommand('stp mode mstp');
    const enter = await sw.executeCommand('stp region-configuration');
    expect(enter).not.toMatch(/Unrecognized command/);
    expect(sw.getPrompt()).toBe('[SW1-mst-region]');
    expect(await sw.executeCommand('region-name LAB')).not.toMatch(/Unrecognized/);
    expect(await sw.executeCommand('instance 1 vlan 10')).not.toMatch(/Unrecognized/);
    expect(await sw.executeCommand('instance 2 vlan 20')).not.toMatch(/Unrecognized/);
    expect(await sw.executeCommand('active region-configuration')).not.toMatch(/Unrecognized/);
    await sw.executeCommand('quit');
    expect(sw.getPrompt()).toBe('[SW1]');
  });
});
