/**
 * TDD — Huawei switch VLAN extras (L2-only, switch-specific).
 *
 * Surfaced by debug-output/huawei/huawei-vlan: hybrid ports, vlan-view
 * description, voice/mux VLAN, QinQ/vlan-mapping and the display vlan
 * variants were "Unrecognized command".
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

describe('Huawei VLAN — vlan-view description', () => {
  it('description is recognized in vlan view and shown in display vlan', async () => {
    const sw = await sysSwitch();
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('name SALES');
    expect(await sw.executeCommand('description Sales department VLAN'))
      .not.toMatch(/Unrecognized command/);
    await sw.executeCommand('return');
    const out = await sw.executeCommand('display vlan');
    expect(out).toContain('10');
  });
});

describe('Huawei VLAN — hybrid ports', () => {
  it('port link-type hybrid + port hybrid pvid/tagged/untagged recognized', async () => {
    const sw = await sysSwitch();
    await sw.executeCommand('vlan batch 10 20 100');
    await sw.executeCommand('interface GigabitEthernet0/0/2');
    for (const c of ['port link-type hybrid', 'port hybrid pvid vlan 10',
      'port hybrid tagged vlan 20 100', 'port hybrid untagged vlan 10']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Unrecognized command/);
    }
    const out = await sw.executeCommand('display this');
    expect(out).toContain('port link-type hybrid');
    expect(out).toContain('port hybrid pvid vlan 10');
  });
});

describe('Huawei VLAN — voice / mux / qinq / vlan-mapping', () => {
  it('all recognized', async () => {
    const sw = await sysSwitch();
    await sw.executeCommand('vlan batch 50 60');
    await sw.executeCommand('interface GigabitEthernet0/0/2');
    expect(await sw.executeCommand('voice-vlan 50 enable')).not.toMatch(/Unrecognized/);
    expect(await sw.executeCommand('port vlan-mapping vlan 10 map-vlan 1000'))
      .not.toMatch(/Unrecognized/);
    expect(await sw.executeCommand('qinq vlan-translation enable'))
      .not.toMatch(/Unrecognized/);
    await sw.executeCommand('quit');
    await sw.executeCommand('vlan 60');
    expect(await sw.executeCommand('mux-vlan')).not.toMatch(/Unrecognized/);
  });
});

describe('Huawei VLAN — display variants', () => {
  it('display vlan summary / <id> / port vlan are recognized', async () => {
    const sw = await sysSwitch();
    await sw.executeCommand('vlan batch 10 20');
    await sw.executeCommand('return');
    for (const c of ['display vlan summary', 'display vlan 10',
      'display port vlan', 'display port vlan active',
      'display current-configuration configuration vlan']) {
      const out = await sw.executeCommand(c);
      expect(out).not.toMatch(/Unrecognized command/);
    }
  });
});

describe('Huawei VLAN — port-group bulk view', () => {
  it('port-group group-member enters a view that accepts port commands', async () => {
    const sw = await sysSwitch();
    await sw.executeCommand('vlan 200');
    await sw.executeCommand('quit');
    expect(await sw.executeCommand(
      'port-group group-member GigabitEthernet0/0/4 to GigabitEthernet0/0/8'))
      .not.toMatch(/Unrecognized command/);
    expect(await sw.executeCommand('port link-type access')).not.toMatch(/Unrecognized/);
    expect(await sw.executeCommand('port default vlan 200')).not.toMatch(/Unrecognized/);
    await sw.executeCommand('quit');
    expect(sw.getPrompt()).toBe('[SW1]');
  });
});
