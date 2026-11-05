/*
 * Probe: operator verbs on an IPsec tunnel found missing on the Meridian hub: `diagnose vpn tunnel down`
 * (CLI Reference 7.4.12 p.3578, <phase2> <phase1> <serial>), `diagnose vpn tunnel list name <t>` (p.3579),
 * the documented three-word form of `diagnose vpn tunnel up`, and `get vpn ipsec tunnel name <t>`.
 * Measured before: "Unknown action 0" / "Command fail. Return code -61" for each.
 * Discriminated with git stash on src/network: 4 of 6 fall before the fix. The witness (the tunnel is up) and the
 * three-word `up` (the tunnel was never down before the fix, so it stays up) pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadAllDevicePlatforms } from '@/network';
import { useNetworkStore } from '@/store/networkStore';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { LabWorkbench } from '@/labs/LabWorkbench';

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); EquipmentRegistry.resetInstance(); Logger.reset();
  await loadAllDevicePlatforms();
  useNetworkStore.getState().clearAll();
});

async function lab() {
  const bench = new LabWorkbench();
  const a = bench.place('firewall-fortinet', 'A', 0, 0);
  const b = bench.place('firewall-fortinet', 'B', 0, 0);
  bench.connect(a, 'wan1', b, 'wan1');
  const side = (wan: string, peer: string) => [
    'config system interface', 'edit wan1', 'set mode static', `set ip ${wan} 255.255.255.0`, 'next', 'end',
    'config vpn ipsec phase1-interface', 'edit "t"', 'set interface "wan1"', 'set ike-version 2', `set remote-gw ${peer}`,
    'set psksecret sekret123', 'set proposal aes256-sha256', 'next', 'end',
    'config vpn ipsec phase2-interface', 'edit "t-p2"', 'set phase1name "t"', 'set proposal aes256-sha256',
    'set src-subnet 0.0.0.0 0.0.0.0', 'set dst-subnet 0.0.0.0 0.0.0.0', 'next', 'end',
  ];
  await bench.shell(a, ...side('203.0.113.1', '203.0.113.2'));
  await bench.shell(b, ...side('203.0.113.2', '203.0.113.1'));
  await a.executeCommand('diagnose vpn tunnel up t');
  return { a };
}

const selectorsUp = (out: string) => /selectors\(total,up\): 1\/1/.test(out);

describe('operator verbs on a tunnel', () => {
  it('witness: the tunnel is up after diagnose vpn tunnel up', async () => {
    const { a } = await lab();
    expect(selectorsUp(await a.executeCommand('get vpn ipsec tunnel summary'))).toBe(true);
  });

  it('diagnose vpn tunnel down <phase1> takes it down', async () => {
    const { a } = await lab();
    await a.executeCommand('diagnose vpn tunnel down t');
    expect(selectorsUp(await a.executeCommand('get vpn ipsec tunnel summary'))).toBe(false);
  });

  it('diagnose vpn tunnel down accepts the documented <phase2> <phase1> <serial> form', async () => {
    const { a } = await lab();
    await a.executeCommand('diagnose vpn tunnel down t-p2 t 1');
    expect(selectorsUp(await a.executeCommand('get vpn ipsec tunnel summary'))).toBe(false);
  });

  it('diagnose vpn tunnel up accepts the documented three-word form', async () => {
    const { a } = await lab();
    await a.executeCommand('diagnose vpn tunnel down t');
    await a.executeCommand('diagnose vpn tunnel up t-p2 t 1');
    expect(selectorsUp(await a.executeCommand('get vpn ipsec tunnel summary'))).toBe(true);
  });

  it('diagnose vpn tunnel list name shows only that tunnel', async () => {
    const { a } = await lab();
    const out = await a.executeCommand('diagnose vpn tunnel list name t');
    expect(out).toContain('name=t ');
    expect(await a.executeCommand('diagnose vpn tunnel list name nope')).not.toContain('name=');
  });

  it('get vpn ipsec tunnel name <t> shows that tunnel', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('get vpn ipsec tunnel name t')).toContain('name=t ');
  });
});
