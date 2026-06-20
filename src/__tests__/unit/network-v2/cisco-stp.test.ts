/**
 * TDD — Cisco IOS STP / Rapid-PVST / MST (L2-only, switch-specific).
 * Surfaced by debug-output/cisco/cisco-stp-security.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

async function cfgSwitch(): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 26);
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  return sw;
}

describe('Cisco STP — global config', () => {
  it('spanning-tree mode / priority / root / toggles recognized', async () => {
    const sw = await cfgSwitch();
    for (const c of ['spanning-tree mode pvst', 'spanning-tree mode rapid-pvst',
      'spanning-tree mode mst', 'spanning-tree vlan 10 priority 4096',
      'spanning-tree vlan 10 root primary', 'spanning-tree vlan 20 root secondary',
      'spanning-tree extend system-id', 'spanning-tree portfast default',
      'spanning-tree portfast bpduguard default',
      'spanning-tree loopguard default']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Invalid input|Unrecognized/);
    }
  });

  it('show spanning-tree / summary reflect state', async () => {
    const sw = await cfgSwitch();
    await sw.executeCommand('spanning-tree mode rapid-pvst');
    await sw.executeCommand('end');
    const st = await sw.executeCommand('show spanning-tree');
    expect(st).not.toMatch(/Invalid input/);
    const sum = await sw.executeCommand('show spanning-tree summary');
    expect(sum).not.toMatch(/Invalid input/);
    expect(sum.toLowerCase()).toMatch(/rapid|pvst|mode/);
  });
});

describe('Cisco STP — MST sub-mode', () => {
  it('spanning-tree mst configuration enters config-mst', async () => {
    const sw = await cfgSwitch();
    expect(await sw.executeCommand('spanning-tree mst configuration'))
      .not.toMatch(/Invalid input|Unrecognized/);
    expect(sw.getPrompt()).toBe('SW1(config-mst)#');
    for (const c of ['name LAB', 'revision 1', 'instance 1 vlan 10',
      'instance 2 vlan 20', 'show current']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Invalid input|Unrecognized/);
    }
    await sw.executeCommand('exit');
    expect(sw.getPrompt()).toBe('SW1(config)#');
    expect(await sw.executeCommand('do show spanning-tree mst configuration'))
      .not.toMatch(/Invalid input/);
  });

  it('the MST region is owned by the bridge engine (SSOT), not the CLI session', async () => {
    const sw = await cfgSwitch();
    for (const c of ['spanning-tree mst configuration', 'name LAB',
      'revision 7', 'instance 1 vlan 10,20', 'exit']) {
      await sw.executeCommand(c);
    }
    const region = sw.getStpAgent().getMstRegion();
    expect(region.name).toBe('LAB');
    expect(region.revision).toBe(7);
    expect(region.instances.get(1)).toBe('vlan 10,20');

    const show = await sw.executeCommand('do show spanning-tree mst configuration');
    expect(show).toContain('Name      [LAB]');
    expect(show).toContain('Revision  7');
    expect(show).toMatch(/1\s+vlan 10,20/);
  });

  it('no name / no instance revert the region in the engine', async () => {
    const sw = await cfgSwitch();
    for (const c of ['spanning-tree mst configuration', 'name LAB',
      'instance 3 vlan 30', 'no name', 'no instance 3', 'exit']) {
      await sw.executeCommand(c);
    }
    const region = sw.getStpAgent().getMstRegion();
    expect(region.name).toBe('');
    expect(region.instances.has(3)).toBe(false);
  });
});

describe('Cisco STP — interface config', () => {
  it('per-interface spanning-tree commands recognized', async () => {
    const sw = await cfgSwitch();
    await sw.executeCommand('interface FastEthernet0/2');
    for (const c of ['spanning-tree portfast', 'spanning-tree bpduguard enable',
      'spanning-tree bpdufilter enable', 'spanning-tree cost 19',
      'spanning-tree port-priority 64', 'spanning-tree guard root']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Invalid input|Unrecognized/);
    }
    expect(await sw.executeCommand(
      'do show spanning-tree interface FastEthernet0/2')).not.toMatch(/Invalid input/);
  });
});
