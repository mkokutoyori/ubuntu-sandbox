import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const INVALID = "% Invalid input detected at '^' marker.";

async function router(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand('ip address 1.1.1.2 255.255.255.0');
  await r.executeCommand('no shutdown');
  await r.executeCommand('exit');
  return r;
}

describe('Cisco ip route — argument validation (global config)', () => {
  it('rejects an invalid mask and installs no route', async () => {
    const r = await router();
    expect(await r.executeCommand('ip route 10.0.0.0 999.0.0.0 1.1.1.1')).toBe(INVALID);
    expect(await r.executeCommand('ip route 10.0.0.0 255.0.255.0 1.1.1.1')).toBe(INVALID);
    expect(r.getRoutingTable().filter(rt => rt.type === 'static')).toHaveLength(0);
  });

  it('rejects an invalid next hop and an out-of-range administrative distance', async () => {
    const r = await router();
    expect(await r.executeCommand('ip route 10.0.0.0 255.255.255.0 300.1.1.1')).toBe(INVALID);
    expect(await r.executeCommand('ip route 10.0.0.0 255.255.255.0 1.1.1.1 999')).toBe(INVALID);
    expect(await r.executeCommand('ip route 10.0.0.0 255.255.255.0 1.1.1.1 0')).toBe(INVALID);
    expect(r.getRoutingTable().filter(rt => rt.type === 'static')).toHaveLength(0);
  });

  it('installs a valid static route', async () => {
    const r = await router();
    expect(await r.executeCommand('ip route 10.0.0.0 255.255.255.0 1.1.1.1')).toBe('');
    const rt = r.getRoutingTable().find(x => String(x.network) === '10.0.0.0');
    expect(rt?.type).toBe('static');
    expect(rt?.ad).toBe(1);
  });

  it('honors the administrative distance for a floating static route', async () => {
    const r = await router();
    await r.executeCommand('ip route 20.0.0.0 255.255.255.0 1.1.1.1 200');
    const rt = r.getRoutingTable().find(x => String(x.network) === '20.0.0.0');
    expect(rt?.ad).toBe(200);
  });
});
