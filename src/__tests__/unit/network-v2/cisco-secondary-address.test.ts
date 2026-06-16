import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const INVALID = "% Invalid input detected at '^' marker.";

async function lan(): Promise<{ r1: CiscoRouter; r2: CiscoRouter }> {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  new Cable('lan').connect(
    r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  const cfg = async (d: CiscoRouter, prim: string, sec: string) => {
    await d.executeCommand('enable');
    await d.executeCommand('configure terminal');
    await d.executeCommand('interface GigabitEthernet0/0');
    await d.executeCommand(`ip address ${prim} 255.255.255.0`);
    await d.executeCommand(`ip address ${sec} 255.255.255.0 secondary`);
    await d.executeCommand('no shutdown');
    await d.executeCommand('end');
  };
  await cfg(r1, '10.0.0.1', '172.16.0.1');
  await cfg(r2, '10.0.0.2', '172.16.0.2');
  return { r1, r2 };
}

describe('Cisco secondary IPv4 address', () => {
  it('keeps the primary and adds the secondary (does not overwrite)', async () => {
    const { r1 } = await lan();
    const rc = await r1.executeCommand('show running-config interface GigabitEthernet0/0');
    expect(rc).toContain('ip address 10.0.0.1 255.255.255.0');
    expect(rc).toContain('ip address 172.16.0.1 255.255.255.0 secondary');
  });

  it('installs a connected route for the secondary subnet', async () => {
    const { r1 } = await lan();
    const route = await r1.executeCommand('show ip route');
    expect(route).toMatch(/C\s+10\.0\.0\.0\/24 is directly connected/);
    expect(route).toMatch(/C\s+172\.16\.0\.0\/24 is directly connected/);
  });

  it('answers ICMP on both the primary and the secondary address', async () => {
    const { r1 } = await lan();
    expect(await r1.executeCommand('ping 10.0.0.2')).toContain('Success rate is 100 percent');
    expect(await r1.executeCommand('ping 172.16.0.2')).toContain('Success rate is 100 percent');
  });

  it('rejects a malformed trailing keyword on ip address', async () => {
    const r = new CiscoRouter('R3');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    expect(await r.executeCommand('ip address 1.1.1.1 255.255.255.0 bogus')).toBe(INVALID);
  });

  it('removes a single secondary while keeping the primary', async () => {
    const { r1 } = await lan();
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    expect(await r1.executeCommand('no ip address 172.16.0.1 255.255.255.0 secondary')).toBe('');
    await r1.executeCommand('end');
    const rc = await r1.executeCommand('show running-config interface GigabitEthernet0/0');
    expect(rc).toContain('ip address 10.0.0.1 255.255.255.0');
    expect(rc).not.toContain('secondary');
    expect(await r1.executeCommand('show ip route')).not.toMatch(/172\.16\.0\.0\/24 is directly connected/);
  });
});
