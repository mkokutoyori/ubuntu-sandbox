/**
 * TDD — anomalies surfaced by debug-output/huawei/* transcripts.
 *
 * These features are COMMON to the Huawei switch and router CLIs, so the
 * implementation must live in shared code (DRY), not be duplicated in
 * HuaweiSwitchShell and HuaweiVRPShell.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

describe('Huawei CLI — output pipe filtering (switch & router, DRY)', () => {
  it('switch: display current-configuration | include vlan keeps only matching lines', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan batch 10 20');
    await sw.executeCommand('return');
    const full = await sw.executeCommand('display current-configuration');
    const filtered = await sw.executeCommand('display current-configuration | include vlan');
    expect(full).toContain('vlan');
    expect(filtered.length).toBeGreaterThan(0);
    for (const line of filtered.split('\n').filter(l => l.trim() !== '')) {
      expect(line.toLowerCase()).toContain('vlan');
    }
    expect(filtered.split('\n').length).toBeLessThan(full.split('\n').length);
  });

  it('switch: | exclude removes matching lines', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    const out = await sw.executeCommand('display interface brief | exclude down');
    expect(out.toLowerCase()).not.toContain(' down');
  });

  it('switch: | begin starts at the first matching line', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    const out = await sw.executeCommand('display version | begin VRP');
    expect(out.length).toBeGreaterThan(0);
    expect(out.split('\n')[0].toLowerCase()).toContain('vrp');
  });

  it('router: display current-configuration | include interface filters too', async () => {
    const r = new HuaweiRouter('R1');
    const out = await r.executeCommand('display current-configuration | include interface');
    for (const line of out.split('\n').filter(l => l.trim() !== '')) {
      expect(line.toLowerCase()).toContain('interface');
    }
  });
});

describe('Huawei CLI — quit/return accept unambiguous abbreviations', () => {
  it('switch: "q" quits one level like "quit"', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    await sw.executeCommand('system-view');
    expect(sw.getPrompt()).toBe('[SW1]');
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    expect(sw.getPrompt()).toBe('[SW1-GigabitEthernet0/0/1]');
    await sw.executeCommand('q');
    expect(sw.getPrompt()).toBe('[SW1]');
  });

  it('switch: "ret" returns to user view like "return"', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    await sw.executeCommand('ret');
    expect(sw.getPrompt()).toBe('<SW1>');
  });

  it('router: "q" and "ret" behave like quit/return', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const sysPrompt = r.getPrompt();
    expect(sysPrompt).toContain('[R1');
    await r.executeCommand('ret');
    expect(r.getPrompt()).toBe('<R1>');
  });
});

describe('Huawei CLI — common display commands (switch & router, DRY)', () => {
  it('switch: display clock returns a date/time line', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    const out = await sw.executeCommand('display clock');
    expect(out).not.toMatch(/Unrecognized command/);
    expect(out).toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/);
  });

  it('router: display clock works the same way', async () => {
    const r = new HuaweiRouter('R1');
    const out = await r.executeCommand('display clock');
    expect(out).not.toMatch(/Unrecognized command/);
    expect(out).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('switch: display cpu-usage / memory-usage are recognized', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    const cpu = await sw.executeCommand('display cpu-usage');
    const mem = await sw.executeCommand('display memory-usage');
    expect(cpu).not.toMatch(/Unrecognized command/);
    expect(mem).not.toMatch(/Unrecognized command/);
    expect(cpu.toLowerCase()).toContain('cpu');
    expect(mem.toLowerCase()).toContain('memory');
  });

  it('switch: display this echoes current-view config', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    await sw.executeCommand('description LINKTEST');
    const out = await sw.executeCommand('display this');
    expect(out).not.toMatch(/Unrecognized command/);
    expect(out).toContain('LINKTEST');
  });
});
