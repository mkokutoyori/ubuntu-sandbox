import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { isValidSubnetMask } from '@/network/core/ip';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const INVALID = "% Invalid input detected at '^' marker.";

async function intf(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('interface GigabitEthernet0/0');
  return r;
}

describe('isValidSubnetMask', () => {
  it('accepts contiguous masks, rejects out-of-range and non-contiguous', () => {
    expect(isValidSubnetMask('255.255.255.0')).toBe(true);
    expect(isValidSubnetMask('255.255.255.255')).toBe(true);
    expect(isValidSubnetMask('0.0.0.0')).toBe(true);
    expect(isValidSubnetMask('255.255.254.0')).toBe(true);
    expect(isValidSubnetMask('999.0.0.0')).toBe(false);
    expect(isValidSubnetMask('255.0.255.0')).toBe(false);
    expect(isValidSubnetMask('255.255.1.0')).toBe(false);
  });
});

describe('Cisco interface config — argument validation (IOS error messages)', () => {
  it('ip address rejects an invalid mask and does not change interface state', async () => {
    const r = await intf();
    expect(await r.executeCommand('ip address 1.2.3.4 999.0.0.0')).toBe(INVALID);
    expect(await r.executeCommand('ip address 1.2.3.4 255.0.255.0')).toBe(INVALID);
    expect(await r.executeCommand('ip address 300.1.1.1 255.255.255.0')).toBe(INVALID);
    expect(r.getPort('GigabitEthernet0/0')?.getIPAddress()).toBeNull();
  });

  it('ip address accepts a valid address/mask', async () => {
    const r = await intf();
    expect(await r.executeCommand('ip address 10.0.0.1 255.255.255.0')).toBe('');
    expect(r.getPort('GigabitEthernet0/0')?.getIPAddress()?.toString()).toBe('10.0.0.1');
  });

  it('speed/duplex/mtu/bandwidth reject invalid arguments instead of silently ignoring them', async () => {
    const r = await intf();
    expect(await r.executeCommand('speed 999')).toBe(INVALID);
    expect(await r.executeCommand('duplex foo')).toBe(INVALID);
    expect(await r.executeCommand('mtu abc')).toBe(INVALID);
    expect(await r.executeCommand('bandwidth -5')).toBe(INVALID);
    expect(await r.executeCommand('bandwidth 0')).toBe(INVALID);
  });

  it('valid speed/duplex/bandwidth still apply', async () => {
    const r = await intf();
    expect(await r.executeCommand('speed 1000')).toBe('');
    expect(await r.executeCommand('duplex full')).toBe('');
    expect(await r.executeCommand('bandwidth 100000')).toBe('');
    const p = r.getPort('GigabitEthernet0/0')!;
    expect(p.getSpeed()).toBe(1000);
    expect(p.getDuplex()).toBe('full');
  });
});
