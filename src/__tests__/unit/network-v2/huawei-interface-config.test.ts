/**
 * TDD — Huawei switch interface physical-config CLI.
 *
 * Surfaced by debug-output/huawei/huawei-interface: speed/duplex/mtu/
 * flow-control/loopback-detect/port-security/storm-control were all
 * "Unrecognized command" in interface view.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

async function ifaceSwitch(): Promise<HuaweiSwitch> {
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
  await sw.executeCommand('system-view');
  await sw.executeCommand('interface GigabitEthernet0/0/1');
  return sw;
}

describe('Huawei interface — physical config commands', () => {
  it('speed / duplex / negotiation are recognized', async () => {
    const sw = await ifaceSwitch();
    for (const c of ['speed 1000', 'speed 100', 'duplex full', 'duplex half',
      'negotiation auto']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Unrecognized command/);
    }
  });

  it('mtu / jumboframe / flow-control / loopback-detect recognized', async () => {
    const sw = await ifaceSwitch();
    for (const c of ['mtu 9216', 'jumboframe enable 9216', 'flow-control',
      'loopback-detect enable']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Unrecognized command/);
    }
  });

  it('port-security family recognized', async () => {
    const sw = await ifaceSwitch();
    for (const c of ['port-security enable', 'port-security max-mac-num 5',
      'port-security mac-address sticky',
      'port-security protect-action shutdown']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Unrecognized command/);
    }
  });

  it('storm-control / suppression recognized', async () => {
    const sw = await ifaceSwitch();
    for (const c of ['storm-control broadcast min-rate 100 max-rate 200',
      'storm-control multicast min-rate 100 max-rate 200',
      'broadcast-suppression 10']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Unrecognized command/);
    }
  });

  it('port-isolate is recognized', async () => {
    const sw = await ifaceSwitch();
    expect(await sw.executeCommand('port-isolate enable group 1'))
      .not.toMatch(/Unrecognized command/);
  });

  it('configured lines round-trip in display this', async () => {
    const sw = await ifaceSwitch();
    await sw.executeCommand('speed 1000');
    await sw.executeCommand('duplex full');
    await sw.executeCommand('port-security enable');
    const out = await sw.executeCommand('display this');
    expect(out).toContain('speed 1000');
    expect(out).toContain('duplex full');
    expect(out).toContain('port-security enable');
  });

  it('a genuinely bogus interface command is still rejected', async () => {
    const sw = await ifaceSwitch();
    expect(await sw.executeCommand('frobnicate the-widget'))
      .toMatch(/Unrecognized command/);
  });
});
