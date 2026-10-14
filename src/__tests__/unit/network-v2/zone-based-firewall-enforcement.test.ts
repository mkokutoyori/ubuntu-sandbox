/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security, Commands S to Z):
 * `zone security`, `zone-member security`, `zone-pair security`, `service-policy type inspect`,
 * `class-map type inspect`, `policy-map type inspect` with the inspect / pass / drop [log] actions.
 *
 * Book (zone-member security): when an interface is in a zone, all traffic to and from it is dropped
 * by default, except traffic to the router or initiated by it; a zone-pair carrying a policy that
 * inspects or passes lets traffic through. Book (show policy-map type inspect zone-pair): in a zone
 * firewall only the first packet of a flow matches the policy, the following ones match the session.
 *
 * Lab: INSIDE PC - FW - OUTSIDE PC, real frames; the tap on each PC counts the echo requests that
 * reach it, so "dropped by the firewall" means "never arrived", not "the ping failed".
 *
 * Measured with src stashed to HEAD: zones, zone-pairs and zone-member were stored and rendered and
 * nothing was evaluated, the show commands printed placeholders and `drop log` was refused, so 15 of
 * the 22 cases fall. Seven pass either way because their expected outcome is "traffic crosses":
 * the witness without zones, inspect (the packet crosses with or without a firewall), the
 * access-group class, two interfaces of one zone, removal of the zone-member, and the two
 * router-originated cases that expect traffic to reach a zone no pair restricts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import { zoneLab, ZONES, inspectPolicy, PAIR_IN_OUT } from './_helpers/zoneFirewallLab';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

describe('zone based firewall', () => {
  it('witness (passes either way): without any zone the router forwards', async () => {
    const lab = await zoneLab();
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).toContain('1 received');
  });

  it('zone members without a zone-pair: nothing crosses, in either direction', async () => {
    const lab = await zoneLab(ZONES);
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).not.toContain('1 received');
    expect(lab.seenByOutside.count).toBe(0);
    expect(await lab.outside.executeCommand('ping -c 1 10.0.1.10')).not.toContain('1 received');
    expect(lab.seenByInside.count).toBe(0);
  });

  it('inspect: the flow goes out and its return traffic comes back through the session', async () => {
    const lab = await zoneLab([...ZONES, ...inspectPolicy('icmp', 'inspect'), ...PAIR_IN_OUT]);
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).toContain('1 received');
    expect(lab.seenByOutside.count).toBe(1);
  });

  it('inspect is one-way: the outside cannot start the flow', async () => {
    const lab = await zoneLab([...ZONES, ...inspectPolicy('icmp', 'inspect'), ...PAIR_IN_OUT]);
    expect(await lab.outside.executeCommand('ping -c 1 10.0.1.10')).not.toContain('1 received');
    expect(lab.seenByInside.count).toBe(0);
  });

  it('pass is stateless: the request crosses, the reply has no pair and is dropped', async () => {
    const lab = await zoneLab([...ZONES, ...inspectPolicy('icmp', 'pass'), ...PAIR_IN_OUT]);
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).not.toContain('1 received');
    expect(lab.seenByOutside.count).toBe(1);
  });

  it('a protocol the policy does not name falls into class-default and is dropped (and logged)', async () => {
    const lab = await zoneLab([...ZONES, ...inspectPolicy('tcp', 'inspect'), ...PAIR_IN_OUT]);
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).not.toContain('1 received');
    expect(lab.seenByOutside.count).toBe(0);
    expect(await lab.fw.executeCommand('show logging')).toContain('DROP_PKT');
  });

  it('a class matched by access-group only lets the permitted flow through', async () => {
    const lab = await zoneLab([
      ...ZONES,
      'ip access-list extended ONLY-OUT', 'permit icmp host 10.0.1.10 host 10.0.2.10', 'exit',
      'class-map type inspect match-all C1', 'match access-group name ONLY-OUT', 'exit',
      'policy-map type inspect P1', 'class type inspect C1', 'inspect', 'exit', 'class class-default', 'drop', 'exit', 'exit',
      ...PAIR_IN_OUT,
    ]);
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).toContain('1 received');
  });

  it('a zone-pair without a service policy drops everything', async () => {
    const lab = await zoneLab([...ZONES, 'zone-pair security IN-OUT source INSIDE destination OUTSIDE', 'exit']);
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).not.toContain('1 received');
    expect(lab.seenByOutside.count).toBe(0);
  });

  it('two interfaces of the same zone forward freely', async () => {
    const lab = await zoneLab([
      'zone security BOTH', 'exit',
      'interface GigabitEthernet0/0', 'zone-member security BOTH', 'exit',
      'interface GigabitEthernet0/1', 'zone-member security BOTH', 'exit',
    ]);
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).toContain('1 received');
  });

  it('a zone member and an interface outside any zone do not talk', async () => {
    const lab = await zoneLab([
      'zone security INSIDE', 'exit', 'interface GigabitEthernet0/0', 'zone-member security INSIDE', 'exit',
    ]);
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).not.toContain('1 received');
    expect(lab.seenByOutside.count).toBe(0);
  });

  it('traffic to the router itself is allowed by default and controlled by a pair with the self zone', async () => {
    const open = await zoneLab(ZONES);
    expect(await open.outside.executeCommand('ping -c 1 10.0.2.1')).toContain('1 received');
    const closed = await zoneLab([
      ...ZONES,
      'class-map type inspect match-any C1', 'match protocol tcp', 'exit',
      'policy-map type inspect P-SELF', 'class type inspect C1', 'inspect', 'exit', 'class class-default', 'drop', 'exit', 'exit',
      'zone-pair security OUT-SELF source OUTSIDE destination self', 'service-policy type inspect P-SELF', 'exit',
    ]);
    expect(await closed.outside.executeCommand('ping -c 1 10.0.2.1')).not.toContain('1 received');
    expect(await closed.inside.executeCommand('ping -c 1 10.0.1.1')).toContain('1 received');
  });

  it('removing the zone-member restores forwarding', async () => {
    const lab = await zoneLab(ZONES);
    await lab.fw.executeCommand('configure terminal');
    await lab.fw.executeCommand('interface GigabitEthernet0/0');
    await lab.fw.executeCommand('no zone-member security');
    await lab.fw.executeCommand('interface GigabitEthernet0/1');
    await lab.fw.executeCommand('no zone-member security');
    await lab.fw.executeCommand('end');
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).toContain('1 received');
  });
});

describe('zone based firewall views', () => {
  it('show zone security lists the self zone, the zones and their member interfaces', async () => {
    const lab = await zoneLab(ZONES);
    const out = await lab.fw.executeCommand('show zone security');
    expect(out).toContain('zone self\n  Description: System defined zone');
    expect(out).toMatch(/zone INSIDE\n  Member Interfaces:\n    GigabitEthernet0\/0/);
    expect(await lab.fw.executeCommand('show zone security OUTSIDE')).toContain('GigabitEthernet0/1');
    expect(await lab.fw.executeCommand('show zone security NOPE')).toContain('Invalid input');
  });

  it('show zone-pair security prints the pair and its policy, filtered by source and destination', async () => {
    const lab = await zoneLab([...ZONES, ...inspectPolicy('icmp', 'inspect'), ...PAIR_IN_OUT]);
    const out = await lab.fw.executeCommand('show zone-pair security');
    expect(out).toContain('Zone-pair name IN-OUT');
    expect(out).toContain('Source-Zone INSIDE  Destination-Zone OUTSIDE');
    expect(out).toContain('service-policy P1');
    expect((await lab.fw.executeCommand('show zone-pair security source OUTSIDE')).trim()).toBe('');
  });

  it('the policy statistics count the sessions the firewall really created', async () => {
    const lab = await zoneLab([...ZONES, ...inspectPolicy('icmp', 'inspect'), ...PAIR_IN_OUT]);
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).toContain('1 received');
    const stats = await lab.fw.executeCommand('show policy-map type inspect zone-pair IN-OUT');
    expect(stats).toContain('Class-map: C1 (match-any)');
    expect(stats).toContain('Match: protocol icmp');
    expect(stats).toContain('Session creations since subsystem startup or last reset 1');
    expect(stats).toContain('Current session counts (estab/half-open/terminating) [1:0:0]');
    const sessions = await lab.fw.executeCommand('show policy-map type inspect zone-pair IN-OUT sessions');
    expect(sessions).toContain('Number of Established Sessions = 1');
    expect(sessions).toMatch(/\(10\.0\.1\.10:\d+\)=>\(10\.0\.2\.10:\d+\) icmp SIS_OPEN/);
  });

  it('dropped packets are counted in class-default', async () => {
    const lab = await zoneLab([...ZONES, ...inspectPolicy('tcp', 'inspect'), ...PAIR_IN_OUT]);
    await lab.inside.executeCommand('ping -c 1 10.0.2.10');
    const stats = await lab.fw.executeCommand('show policy-map type inspect zone-pair IN-OUT');
    expect(stats).toMatch(/Class-map: class-default \(match-any\)\n      Match: any\n      Drop\n        1 packets, 84 bytes/);
  });

  it('clear zone-pair deletes the sessions or resets the counters', async () => {
    const lab = await zoneLab([...ZONES, ...inspectPolicy('icmp', 'inspect'), ...PAIR_IN_OUT]);
    await lab.inside.executeCommand('ping -c 1 10.0.2.10');
    await lab.fw.executeCommand('clear zone-pair IN-OUT inspect session');
    expect(await lab.fw.executeCommand('show policy-map type inspect zone-pair IN-OUT sessions')).toContain('Number of Established Sessions = 0');
    await lab.fw.executeCommand('clear zone-pair counter');
    const stats = await lab.fw.executeCommand('show policy-map type inspect zone-pair IN-OUT');
    expect(stats).toContain('Session creations since subsystem startup or last reset 0');
    expect(stats).not.toContain('Last statistic reset never');
  });

  it('the drop log line is written when the action asks for it', async () => {
    const lab = await zoneLab([...ZONES, ...inspectPolicy('tcp', 'inspect'), ...PAIR_IN_OUT]);
    await lab.inside.executeCommand('ping -c 1 10.0.2.10');
    expect(await lab.fw.executeCommand('show logging')).toMatch(/%FW-6-DROP_PKT: Dropping icmp session 10\.0\.1\.10:\d+ 10\.0\.2\.10:\d+/);
  });
});

describe('zone based firewall, traffic sent by the router', () => {
  const SELF_TO_OUT_DROP = [
    'class-map type inspect match-any C-TCP', 'match protocol tcp', 'exit',
    'policy-map type inspect P-FROM-SELF', 'class type inspect C-TCP', 'inspect', 'exit', 'class class-default', 'drop', 'exit', 'exit',
    'zone-pair security SELF-OUT source self destination OUTSIDE', 'service-policy type inspect P-FROM-SELF', 'exit',
  ];

  it('witness (passes either way): without a pair the router reaches a host of a zone it is attached to', async () => {
    const lab = await zoneLab(ZONES);
    expect(await lab.fw.executeCommand('ping 10.0.2.10')).toContain('!');
    expect(lab.seenByOutside.count).toBeGreaterThan(0);
  });

  it('a self-to-zone pair that drops stops what the router sends: its own ping never leaves', async () => {
    const clock = installVirtualClock();
    const lab = await zoneLab([...ZONES, ...SELF_TO_OUT_DROP]);
    await clock.advanceUntilSettled(lab.fw.executeCommand('ping 10.0.2.10'));
    expect(lab.seenByOutside.count).toBe(0);
  });

  it('it also stops the router answering: the echo request arrives, the reply is never sent', async () => {
    const lab = await zoneLab([...ZONES, ...SELF_TO_OUT_DROP]);
    expect(await lab.outside.executeCommand('ping -c 1 10.0.2.1')).not.toContain('1 received');
  });

  it('the pair does not touch the other zone', async () => {
    const lab = await zoneLab([...ZONES, ...SELF_TO_OUT_DROP]);
    await lab.fw.executeCommand('ping 10.0.1.10');
    expect(lab.seenByInside.count).toBeGreaterThan(0);
  });
});
