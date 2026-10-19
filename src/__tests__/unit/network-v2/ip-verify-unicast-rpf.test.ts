/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security): `ip verify unicast source
 * reachable-via {any | rx} [allow-default] [allow-self-ping] [access-list]` and `ip verify unicast
 * reverse-path [access-list]`.
 *
 * Book: `rx` (strict) permits a packet only if its source is reachable through the interface it arrived
 * on, `any` (loose) if it is in the FIB through any interface; allow-default lets the default route
 * count; allow-self-ping lets the router ping its own interfaces; a packet that fails the check is
 * dropped unless the access list permits it, in which case it is counted as a suppressed drop.
 *
 * Lab: INSIDE PC - FW - OUTSIDE PC. The outside PC forges echo requests with hping3 (-a), and the tap
 * on the inside PC counts what actually crosses the firewall.
 *
 * Measured with src stashed to HEAD: 6 of the 11 cases fall (the access list, allow-self-ping, the
 * counters in `show ip interface`, the rendering with its `no` form and the refusals). Five pass either
 * way because the strict / loose / allow-default check itself existed: the witness, rx, any,
 * allow-default and the old reverse-path form.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { zoneLab, type ZoneLab } from './_helpers/zoneFirewallLab';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const OUTSIDE = (...lines: string[]): string[] => ['interface GigabitEthernet0/1', ...lines, 'exit'];

async function forge(lab: ZoneLab, source: string): Promise<number> {
  const before = lab.seenByInside.count;
  await lab.outside.executeCommand(`sudo hping3 --icmp -a ${source} -c 1 10.0.1.10`);
  return lab.seenByInside.count - before;
}

describe('strict and loose checks', () => {
  it('witness (passes either way): without uRPF a forged source crosses', async () => {
    const lab = await zoneLab();
    expect(await forge(lab, '10.0.1.77')).toBe(1);
  });

  it('rx drops a source routed through another interface and keeps the genuine one', async () => {
    const lab = await zoneLab(OUTSIDE('ip verify unicast source reachable-via rx'));
    expect(await forge(lab, '10.0.1.77')).toBe(0);
    expect(await lab.outside.executeCommand('ping -c 1 10.0.1.10')).toContain('1 received');
  });

  it('any lets a routed source through and drops an unrouted one', async () => {
    const lab = await zoneLab(OUTSIDE('ip verify unicast source reachable-via any'));
    expect(await forge(lab, '10.0.1.77')).toBe(1);
    expect(await forge(lab, '192.0.2.5')).toBe(0);
  });

  it('allow-default counts the default route as a way back', async () => {
    const strict = await zoneLab(['ip route 0.0.0.0 0.0.0.0 10.0.2.10', ...OUTSIDE('ip verify unicast source reachable-via any')]);
    expect(await forge(strict, '192.0.2.5')).toBe(0);
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    const lab = await zoneLab(['ip route 0.0.0.0 0.0.0.0 10.0.2.10', ...OUTSIDE('ip verify unicast source reachable-via any allow-default')]);
    expect(await forge(lab, '192.0.2.5')).toBe(1);
  });

  it('the old reverse-path form is a strict check', async () => {
    const lab = await zoneLab(OUTSIDE('ip verify unicast reverse-path'));
    expect(await forge(lab, '10.0.1.77')).toBe(0);
  });
});

describe('access list and self ping', () => {
  const ACL = ['access-list 101 permit icmp host 10.0.1.77 any'];

  it('a packet that fails the check but is permitted by the list crosses; another one does not', async () => {
    const lab = await zoneLab([...ACL, ...OUTSIDE('ip verify unicast source reachable-via rx 101')]);
    expect(await forge(lab, '10.0.1.77')).toBe(1);
    expect(await forge(lab, '10.0.1.78')).toBe(0);
  });

  it('the reverse-path form takes a list too', async () => {
    const lab = await zoneLab([...ACL, ...OUTSIDE('ip verify unicast reverse-path 101')]);
    expect(await forge(lab, '10.0.1.77')).toBe(1);
    expect(await forge(lab, '10.0.1.78')).toBe(0);
  });

  it('allow-self-ping lets a packet sourced from the router own address through', async () => {
    const without = await zoneLab(OUTSIDE('ip verify unicast source reachable-via rx'));
    expect(await forge(without, '10.0.1.1')).toBe(0);
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    const lab = await zoneLab(OUTSIDE('ip verify unicast source reachable-via rx allow-self-ping'));
    expect(await forge(lab, '10.0.1.1')).toBe(1);
  });
});

describe('views and configuration', () => {
  it('show ip interface counts verification drops and suppressed drops', async () => {
    const lab = await zoneLab(['access-list 101 permit icmp host 10.0.1.77 any', ...OUTSIDE('ip verify unicast source reachable-via rx 101')]);
    await forge(lab, '10.0.1.77');
    await forge(lab, '10.0.1.78');
    await forge(lab, '10.0.1.79');
    const shown = await lab.fw.executeCommand('show ip interface GigabitEthernet0/1');
    expect(shown).toContain('IP verify source reachable-via RX');
    expect(shown).toContain('2 verification drops');
    expect(shown).toContain('1 suppressed verification drops');
    expect(await lab.fw.executeCommand('show ip interface GigabitEthernet0/0')).not.toContain('IP verify source');
  });

  it('the running-config renders every qualifier and the no form removes the check', async () => {
    const lab = await zoneLab(OUTSIDE('ip verify unicast source reachable-via rx allow-default allow-self-ping 101'));
    expect(await lab.fw.executeCommand('show running-config')).toContain(' ip verify unicast source reachable-via rx allow-default allow-self-ping 101');
    await lab.fw.executeCommand('configure terminal');
    await lab.fw.executeCommand('interface GigabitEthernet0/1');
    await lab.fw.executeCommand('no ip verify unicast source reachable-via');
    await lab.fw.executeCommand('end');
    expect(await lab.fw.executeCommand('show running-config')).not.toContain('ip verify unicast');
    expect(await forge(lab, '10.0.1.77')).toBe(1);
  });

  it('refuses an unknown mode, a repeated qualifier, a word after the list and a list out of range', async () => {
    const lab = await zoneLab();
    for (const line of ['configure terminal', 'interface GigabitEthernet0/1']) await lab.fw.executeCommand(line);
    for (const bad of [
      'ip verify unicast source reachable-via zorglub', 'ip verify unicast source reachable-via rx allow-default allow-default',
      'ip verify unicast source reachable-via rx 101 allow-default', 'ip verify unicast source reachable-via rx 200',
      'ip verify unicast source reachable-via rx l2-src',
    ]) expect(await lab.fw.executeCommand(bad), bad).toContain('% Invalid input');
  });
});
