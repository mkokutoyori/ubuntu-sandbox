/**
 * TDD — Lot C: prefix-lists & route-maps as real config objects
 * (PolicyRepository). Config is recorded and projected by
 * show ip prefix-list / show route-map. No stubs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('Cisco prefix-lists & route-maps — real config state', () => {
  it('ip prefix-list entries are recorded and projected', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    for (let i = 1; i <= 5; i++) {
      const c = `ip prefix-list PL-IN seq ${i * 5} permit 10.${i}.0.0/16 le 24`;
      expect(await r.executeCommand(c), c).not.toMatch(/Invalid input|Incomplete/);
    }
    await r.executeCommand('ip prefix-list PL-IN seq 100 deny 0.0.0.0/0');
    await r.executeCommand('end');

    const out = await r.executeCommand('show ip prefix-list PL-IN');
    expect(out).not.toMatch(/Invalid input/);
    expect(out).toContain('10.1.0.0/16');
    expect(out).toMatch(/seq 5 permit 10\.1\.0\.0\/16 le 24/);
    expect(out).toMatch(/seq 100 deny 0\.0\.0\.0\/0/);
    expect(out).toMatch(/6 entries/);

    await r.executeCommand('configure terminal');
    await r.executeCommand('no ip prefix-list PL-IN seq 5');
    await r.executeCommand('end');
    expect(await r.executeCommand('show ip prefix-list PL-IN'))
      .not.toMatch(/seq 5 permit/);
  });

  it('route-map clauses (match/set) are recorded and projected', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('access-list 10 permit 192.168.1.0 0.0.0.255');
    expect(await r.executeCommand('route-map RM-PBR permit 10'))
      .not.toMatch(/Invalid input/);
    for (const c of [
      'match ip address 10',
      'match interface GigabitEthernet0/0',
      'set ip next-hop 10.0.0.2',
      'set interface GigabitEthernet0/1',
      'set ip default next-hop 10.0.0.254',
    ]) {
      expect(await r.executeCommand(c), c).not.toMatch(/Invalid input|Incomplete/);
    }
    await r.executeCommand('exit');
    await r.executeCommand('route-map RM-PBR deny 20');
    await r.executeCommand('end');

    const out = await r.executeCommand('show route-map RM-PBR');
    expect(out).not.toMatch(/Invalid input/);
    expect(out).toMatch(/route-map RM-PBR, permit sequence 10/);
    expect(out).toContain('match ip address 10');
    expect(out).toContain('set ip next-hop 10.0.0.2');
    expect(out).toMatch(/route-map RM-PBR, deny sequence 20/);
  });

  it('ipv6 prefix-list works and show route-map lists all', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('ipv6 prefix-list V6 seq 5 permit 2001:db8::/32 le 64');
    await r.executeCommand('route-map A permit 10');
    await r.executeCommand('exit');
    await r.executeCommand('route-map B permit 10');
    await r.executeCommand('end');
    expect(await r.executeCommand('show ipv6 prefix-list')).toContain('2001:db8::/32');
    const all = await r.executeCommand('show route-map');
    expect(all).toContain('route-map A');
    expect(all).toContain('route-map B');
  });
});
