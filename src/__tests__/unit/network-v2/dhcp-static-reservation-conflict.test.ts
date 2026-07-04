/**
 * Static DHCP reservations (Cisco `host`/`hardware-address`, Huawei
 * `static-bind`) had no duplicate-IP validation: two different pools could
 * reserve the same address for two different clients with no warning, a
 * real misconfiguration a real DHCP server rejects.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('Cisco DHCP — static host reservation conflict', () => {
  it('rejects `host` reserving an IP already reserved in another pool', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip dhcp pool POOL_A');
    await r.executeCommand('host 10.0.0.5 255.255.255.0');
    await r.executeCommand('hardware-address 0011.2233.4455');
    await r.executeCommand('exit');

    await r.executeCommand('ip dhcp pool POOL_B');
    const out = await r.executeCommand('host 10.0.0.5 255.255.255.0');
    expect(out).toMatch(/already|conflict|reserved/i);
    await r.executeCommand('end');

    const showB = await r.executeCommand('show ip dhcp pool POOL_B');
    expect(showB).not.toContain('10.0.0.5');
  });

  it('allows re-issuing `host` for the same pool (idempotent update)', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip dhcp pool POOL_A');
    await r.executeCommand('host 10.0.0.5 255.255.255.0');
    const out = await r.executeCommand('host 10.0.0.5 255.255.255.0');
    expect(out).not.toMatch(/already|conflict|reserved/i);
  });

  it('allows two different pools to reserve two different IPs', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip dhcp pool POOL_A');
    await r.executeCommand('host 10.0.0.5 255.255.255.0');
    await r.executeCommand('exit');
    await r.executeCommand('ip dhcp pool POOL_B');
    const out = await r.executeCommand('host 10.0.0.6 255.255.255.0');
    expect(out).not.toMatch(/already|conflict|reserved/i);
  });
});

describe('Huawei DHCP — static-bind reservation conflict', () => {
  async function sysRouter(): Promise<HuaweiRouter> {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('dhcp enable');
    return r;
  }

  it('rejects a static-bind reserving an IP already bound in another pool', async () => {
    const r = await sysRouter();
    await r.executeCommand('dhcp server ip-pool POOL_A');
    await r.executeCommand('static-bind ip-address 10.0.0.5 mac-address aaaa-bbbb-cccc');
    await r.executeCommand('quit');

    await r.executeCommand('dhcp server ip-pool POOL_B');
    const out = await r.executeCommand('static-bind ip-address 10.0.0.5 mac-address 1111-2222-3333');
    expect(out).toMatch(/already|conflict|bound/i);
  });

  it('allows re-issuing the same static-bind for the same client in the same pool', async () => {
    const r = await sysRouter();
    await r.executeCommand('dhcp server ip-pool POOL_A');
    await r.executeCommand('static-bind ip-address 10.0.0.5 mac-address aaaa-bbbb-cccc');
    const out = await r.executeCommand('static-bind ip-address 10.0.0.5 mac-address aaaa-bbbb-cccc');
    expect(out).not.toMatch(/already|conflict|bound/i);
  });
});
