import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
});

describe('IGMPv3 not supported — explicit user-facing disclosure (GAP §5.4 first constat)', () => {
  it('rejects "ip igmp version 3" with a clear out-of-scope message', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    const out = await r.executeCommand('ip igmp version 3');
    expect(out).toMatch(/IGMPv3 is not supported/);
    expect(out).toMatch(/RFC 3376/);
  });

  it('accepts versions 1 and 2 without error', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    expect(await r.executeCommand('ip igmp version 1')).toBe('');
    expect(await r.executeCommand('ip igmp version 2')).toBe('');
  });

  it('"show ip igmp interface" emits the v3 limitation footer when at least one interface exists', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('ip igmp version 2');
    await r.executeCommand('end');
    const out = await r.executeCommand('show ip igmp interface');
    expect(out).toMatch(/IGMPv3 \(RFC 3376 source filtering\) is not supported/);
  });
});
