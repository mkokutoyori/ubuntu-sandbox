/**
 * TDD — Huawei switch Eth-Trunk / LACP link aggregation (L2).
 *
 * Surfaced by debug-output/huawei/huawei-interface: interface Eth-Trunk,
 * mode lacp-static, trunkport, (max|least) active-linknumber,
 * load-balance, member `eth-trunk N`, display eth-trunk were all
 * "Unrecognized command".
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

describe('Huawei Eth-Trunk — creation & LACP config', () => {
  it('interface Eth-Trunk N enters trunk view with the right prompt', async () => {
    const sw = await sysSwitch();
    expect(await sw.executeCommand('interface Eth-Trunk 1'))
      .not.toMatch(/Unrecognized command/);
    expect(sw.getPrompt()).toBe('[SW1-Eth-Trunk1]');
  });

  it('mode / linknumber / load-balance / trunkport recognized', async () => {
    const sw = await sysSwitch();
    await sw.executeCommand('interface Eth-Trunk 1');
    for (const c of ['mode lacp-static', 'max active-linknumber 2',
      'least active-linknumber 1', 'load-balance src-dst-mac',
      'trunkport GigabitEthernet0/0/21', 'trunkport GigabitEthernet0/0/22']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Unrecognized command/);
    }
    const out = await sw.executeCommand('display this');
    expect(out).toContain('mode lacp-static');
    expect(out).toContain('Eth-Trunk1');
  });

  it('member ports join with `eth-trunk N`', async () => {
    const sw = await sysSwitch();
    await sw.executeCommand('interface Eth-Trunk 1');
    await sw.executeCommand('quit');
    await sw.executeCommand('interface GigabitEthernet0/0/21');
    expect(await sw.executeCommand('eth-trunk 1')).not.toMatch(/Unrecognized command/);
    await sw.executeCommand('quit');
    await sw.executeCommand('interface GigabitEthernet0/0/22');
    expect(await sw.executeCommand('eth-trunk 1')).not.toMatch(/Unrecognized command/);
  });

  it('display eth-trunk N lists the bundle and members', async () => {
    const sw = await sysSwitch();
    await sw.executeCommand('interface Eth-Trunk 1');
    await sw.executeCommand('mode lacp-static');
    await sw.executeCommand('quit');
    await sw.executeCommand('interface GigabitEthernet0/0/21');
    await sw.executeCommand('eth-trunk 1');
    await sw.executeCommand('return');
    const out = await sw.executeCommand('display eth-trunk 1');
    expect(out).not.toMatch(/Unrecognized command/);
    expect(out).toMatch(/Eth-Trunk1/);
    expect(out).toMatch(/GigabitEthernet0\/0\/21/);
  });

  it('a non-trunk command in eth-trunk view is still rejected', async () => {
    const sw = await sysSwitch();
    await sw.executeCommand('interface Eth-Trunk 1');
    expect(await sw.executeCommand('frobnicate xyz'))
      .toMatch(/Unrecognized command/);
  });
});

describe('Huawei interface — counters maintenance', () => {
  it('reset / display counters are recognized', async () => {
    const sw = await sysSwitch();
    await sw.executeCommand('return');
    expect(await sw.executeCommand('reset counters interface GigabitEthernet0/0/1'))
      .not.toMatch(/Unrecognized command/);
    expect(await sw.executeCommand('display counters inbound interface GigabitEthernet0/0/1'))
      .not.toMatch(/Unrecognized command/);
  });
});
