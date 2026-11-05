/*
 * Probe: `get router info routing-table details [<address>]` (FortiOS CLI Reference, get router info
 * routing-table <keyword>). Measured before: "Command fail. Return code -61" for every form.
 * Discriminated with git stash on src/network: 4 of 5 fall before the fix; the witness (`all` lists the static
 * route) passes either way and proves the routes exist.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

async function fgt() {
  const f = new FortiGate('firewall-fortinet', 'F', 0, 0);
  for (const c of ['config system interface', 'edit port1', 'set mode static', 'set ip 10.0.0.1 255.255.255.0', 'next', 'end',
    'config router static', 'edit 1', 'set dst 10.9.0.0 255.255.0.0', 'set gateway 10.0.0.254', 'set device "port1"', 'next', 'end']) {
    await f.executeCommand(c);
  }
  return f;
}

describe('get router info routing-table details', () => {
  it('witness: all lists the static route', async () => {
    expect(await (await fgt()).executeCommand('get router info routing-table all')).toContain('10.9.0.0/16');
  });

  it('shows a static route with its next hop, distance and metric', async () => {
    const out = await (await fgt()).executeCommand('get router info routing-table details 10.9.4.4');
    expect(out).toContain('Routing entry for 10.9.0.0/16');
    expect(out).toContain('Known via "static", distance 10, metric 0, best');
    expect(out).toContain('* 10.0.0.254, via port1');
  });

  it('shows a connected route as directly connected', async () => {
    const out = await (await fgt()).executeCommand('get router info routing-table details 10.0.0.0/24');
    expect(out).toContain('Known via "connected"');
    expect(out).toContain('* is directly connected, port1');
  });

  it('without an address lists every route', async () => {
    const out = await (await fgt()).executeCommand('get router info routing-table details');
    expect(out).toContain('Routing entry for 10.9.0.0/16');
    expect(out).toContain('Routing entry for 10.0.0.0/24');
  });

  it('an address that matches nothing says so', async () => {
    expect(await (await fgt()).executeCommand('get router info routing-table details 192.0.2.1')).toContain('Network not in table');
  });
});
