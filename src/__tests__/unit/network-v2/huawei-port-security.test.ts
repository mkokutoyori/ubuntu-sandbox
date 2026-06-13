import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const IF = 'GigabitEthernet0/0/1';

async function configured(): Promise<HuaweiSwitch> {
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
  await sw.executeCommand('system-view');
  await sw.executeCommand(`interface ${IF}`);
  return sw;
}

describe('Huawei port-security — wired to the vendor-neutral PortSecurity', () => {
  it('port-security enable / max-mac-num / protect-action drive the real PortSecurity', async () => {
    const sw = await configured();
    await sw.executeCommand('port-security enable');
    await sw.executeCommand('port-security max-mac-num 3');
    await sw.executeCommand('port-security protect-action restrict');

    const sec = sw.getPort(IF)!.getPortSecurity();
    expect(sec.isEnabled()).toBe(true);
    expect(sec.getMaxMACAddresses()).toBe(3);
    expect(sec.getViolationMode()).toBe('restrict');
  });

  it('port-security mac-address sticky toggles sticky and learns a sticky MAC', async () => {
    const sw = await configured();
    await sw.executeCommand('port-security enable');
    await sw.executeCommand('port-security mac-address sticky');
    const sec = sw.getPort(IF)!.getPortSecurity();
    expect(sec.isStickyEnabled()).toBe(true);

    await sw.executeCommand('port-security mac-address sticky 00e0-fc12-3456 vlan 1');
    expect(sec.getEntries().some((e) => e.mac.toString() === '00:e0:fc:12:34:56')).toBe(true);
  });

  it('undo port-security enable / sticky reverts the real state', async () => {
    const sw = await configured();
    await sw.executeCommand('port-security enable');
    await sw.executeCommand('port-security mac-address sticky');
    await sw.executeCommand('undo port-security mac-address sticky');
    await sw.executeCommand('undo port-security enable');
    const sec = sw.getPort(IF)!.getPortSecurity();
    expect(sec.isEnabled()).toBe(false);
    expect(sec.isStickyEnabled()).toBe(false);
  });

  it('display port-security reflects the live per-port state', async () => {
    const sw = await configured();
    await sw.executeCommand('port-security enable');
    await sw.executeCommand('port-security max-mac-num 2');
    await sw.executeCommand('port-security protect-action shutdown');
    await sw.executeCommand('quit');

    const out = await sw.executeCommand('display port-security');
    expect(out).toContain(IF);
    expect(out).toContain('shutdown');
    expect(out).toMatch(/\b2\b/);
  });

  it('port-security is recorded in the interface running-config (display this)', async () => {
    const sw = await configured();
    await sw.executeCommand('port-security enable');
    await sw.executeCommand('port-security max-mac-num 5');
    const out = await sw.executeCommand('display this');
    expect(out).toContain('port-security enable');
    expect(out).toContain('port-security max-mac-num 5');
  });
});
