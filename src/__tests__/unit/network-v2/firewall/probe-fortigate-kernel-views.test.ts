/*
 * Probe: three views FortiOS documents and the simulator lacked, found by typing an operator's routine on the
 * Meridian hub: `get router info kernel` (CLI Reference 6.0 p.1491), `get vpn ipsec stats crypto` (6.0 p.1524) and
 * `diagnose netlink interface list` (7.4.12 p.3105). Measured before: "Command fail. Return code -61" / "Unknown action 0".
 * The kernel and netlink line layouts follow what a FortiGate prints (the reference gives no sample for them; no
 * transcript is available), so the probe pins the facts they carry, not the column spacing.
 * Discriminated with git stash on src/network: 5 of 6 fall before the fix; the witness (the route table holds
 * the static route) passes either way.
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

describe('kernel views', () => {
  it('witness: the routing table holds the static route', async () => {
    expect(await (await fgt()).executeCommand('get router info routing-table static')).toContain('10.9.0.0/16');
  });

  it('get router info kernel lists the static route with its gateway and device', async () => {
    const out = await (await fgt()).executeCommand('get router info kernel');
    expect(out).toMatch(/proto=11 .*->10\.9\.0\.0\/16 .*gwy=10\.0\.0\.254 dev=\d+\(port1\)/);
  });

  it('get router info kernel lists the connected route as kernel-installed', async () => {
    const out = await (await fgt()).executeCommand('get router info kernel');
    expect(out).toMatch(/proto=2 .*->10\.0\.0\.0\/24 pref=10\.0\.0\.1 gwy=0\.0\.0\.0 dev=\d+\(port1\)/);
  });

  it('get vpn ipsec stats crypto prints the software counters', async () => {
    const out = await (await fgt()).executeCommand('get vpn ipsec stats crypto');
    expect(out).toContain('SOFTWARE (encrypted/decrypted):');
    expect(out).toMatch(/aes:\s+0\s+0/);
    expect(out).toMatch(/sha256:\s+0\s+0/);
  });

  it('diagnose netlink interface list names every interface with its address-independent state', async () => {
    const out = await (await fgt()).executeCommand('diagnose netlink interface list');
    expect(out).toMatch(/if=port1 family=00 type=1 index=\d+ mtu=1500/);
    expect(out).toContain('flags=up');
  });

  it('the new words are announced by ?', async () => {
    const f = await fgt();
    expect(await f.executeCommand('get router info ?')).toContain('kernel');
    expect(await f.executeCommand('diagnose netlink interface ?')).toContain('list');
  });
});
