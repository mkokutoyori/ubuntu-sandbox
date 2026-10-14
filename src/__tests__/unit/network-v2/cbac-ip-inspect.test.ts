/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security): `ip inspect name`,
 * `ip inspect <name> in|out`, `ip inspect alert-off`, `audit-trail`, `log drop-pkt`, `dns-timeout`,
 * `tcp idle-time|synwait-time|finwait-time`, `udp idle-time`, `max-incomplete high|low`,
 * `one-minute high|low`, `tcp max-incomplete host N block-time M`, `show ip inspect ...`,
 * `clear ip inspect session|statistics`.
 *
 * Book (ip inspect name): when inspection is configured for a protocol, the return traffic entering
 * the internal network is permitted only if it belongs to a valid existing session. Book
 * (max-incomplete host): above the threshold the router deletes the oldest half-open session of the
 * host per new request, or, with a block-time, deletes them all and blocks new connections.
 *
 * Lab: INSIDE PC - FW - OUTSIDE PC, real frames. An inbound ACL on the outside interface denies
 * everything, so the only way a reply gets back is the hole CBAC opens for a session. Taps on both PCs
 * count what arrives: "blocked" means "never arrived", not "the command failed".
 *
 * Measured with src stashed to HEAD: `ip inspect` was refused as an invalid command, so 17 of the 25
 * cases fall. Eight pass either way because their expected outcome is "the ACL blocks" or "nothing is
 * logged": the ACL-only witness, the outside-initiated flow, a protocol the rule does not name, an
 * undefined rule name, the removed binding, the per-protocol audit-trail off, the alert-off silence and
 * the refusal of malformed values.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import { zoneLab } from './_helpers/zoneFirewallLab';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const OUTSIDE_ACL = [
  'ip access-list extended OUT-IN', 'deny ip any any', 'exit',
  'interface GigabitEthernet0/1', 'ip access-group OUT-IN in', 'exit',
];

const configure = async (lab: Awaited<ReturnType<typeof zoneLab>>, ...lines: string[]): Promise<void> => {
  for (const line of ['configure terminal', ...lines, 'end']) await lab.fw.executeCommand(line);
};

const INSIDE_IN = (rule = 'R') => ['interface GigabitEthernet0/0', `ip inspect ${rule} in`, 'exit'];

describe('CBAC: return traffic of an inspected session', () => {
  it('witness (passes either way): the outside ACL alone stops the reply', async () => {
    const lab = await zoneLab(OUTSIDE_ACL);
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).not.toContain('1 received');
    expect(lab.seenByOutside.count).toBe(1);
  });

  it('icmp inspection on the inside interface lets the echo reply back through the ACL', async () => {
    const lab = await zoneLab([...OUTSIDE_ACL, 'ip inspect name R icmp', ...INSIDE_IN()]);
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).toContain('1 received');
  });

  it('the same rule applied outbound on the outside interface works too', async () => {
    const lab = await zoneLab([...OUTSIDE_ACL, 'ip inspect name R icmp', 'interface GigabitEthernet0/1', 'ip inspect R out', 'exit']);
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).toContain('1 received');
  });

  it('witness (passes either way): a flow started from the outside stays blocked', async () => {
    const lab = await zoneLab([...OUTSIDE_ACL, 'ip inspect name R icmp', ...INSIDE_IN()]);
    expect(await lab.outside.executeCommand('ping -c 1 10.0.1.10')).not.toContain('1 received');
    expect(lab.seenByInside.count).toBe(0);
  });

  it('witness (passes either way): a protocol the rule does not name is not inspected', async () => {
    const lab = await zoneLab([...OUTSIDE_ACL, 'ip inspect name R tcp', ...INSIDE_IN()]);
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).not.toContain('1 received');
  });

  it('tcp: the handshake completes through the ACL, and without inspection it does not', async () => {
    const without = await zoneLab(OUTSIDE_ACL);
    await without.outside.executeCommand('nc -l -p 8080 &');
    expect(await without.inside.executeCommand('nc -zv 10.0.2.10 8080')).not.toMatch(/succeeded/);

    Logger.reset(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
    const lab = await zoneLab([...OUTSIDE_ACL, 'ip inspect name R tcp', ...INSIDE_IN()]);
    await lab.outside.executeCommand('nc -l -p 8080 &');
    expect(await lab.inside.executeCommand('nc -zv 10.0.2.10 8080')).toMatch(/succeeded/);
  });

  it('an undefined rule name inspects nothing', async () => {
    const lab = await zoneLab([...OUTSIDE_ACL, 'ip inspect name R icmp', ...INSIDE_IN('OTHER')]);
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).not.toContain('1 received');
  });

  it('removing the interface binding closes the hole', async () => {
    const lab = await zoneLab([...OUTSIDE_ACL, 'ip inspect name R icmp', ...INSIDE_IN(),
      'interface GigabitEthernet0/0', 'no ip inspect R in', 'exit']);
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).not.toContain('1 received');
  });
});

describe('CBAC: sessions, timers and logs', () => {
  it('show ip inspect sessions lists the icmp session, which ages out after the icmp idle time', async () => {
    const clock = installVirtualClock();
    const lab = await zoneLab([...OUTSIDE_ACL, 'ip inspect name R icmp', ...INSIDE_IN()]);
    await lab.inside.executeCommand('ping -c 1 10.0.2.10');
    const shown = await lab.fw.executeCommand('show ip inspect sessions');
    expect(shown).toContain('Established Sessions');
    expect(shown).toMatch(/\(10\.0\.1\.10:\d+\)=>\(10\.0\.2\.10:\d+\) icmp SIS_OPEN/);
    clock.advance(11_000);
    expect(await lab.fw.executeCommand('show ip inspect sessions')).not.toContain('icmp');
  });

  it('a per-protocol timeout overrides the idle time of the protocol', async () => {
    const clock = installVirtualClock();
    const lab = await zoneLab([...OUTSIDE_ACL, 'ip inspect name R icmp timeout 60', ...INSIDE_IN()]);
    await lab.inside.executeCommand('ping -c 1 10.0.2.10');
    clock.advance(11_000);
    expect(await lab.fw.executeCommand('show ip inspect sessions')).toContain('icmp SIS_OPEN');
    clock.advance(50_000);
    expect(await lab.fw.executeCommand('show ip inspect sessions')).not.toContain('icmp');
  });

  it('audit-trail logs the start and the end of the session', async () => {
    const clock = installVirtualClock();
    const lab = await zoneLab(['ip inspect audit-trail', ...OUTSIDE_ACL, 'ip inspect name R icmp', ...INSIDE_IN()]);
    await lab.inside.executeCommand('ping -c 1 10.0.2.10');
    expect(await lab.fw.executeCommand('show logging')).toContain('%FW-6-SESS_AUDIT_TRAIL_START: Start icmp session: initiator (10.0.1.10:');
    clock.advance(12_000);
    const log = await lab.fw.executeCommand('show logging');
    expect(log).toMatch(/%FW-6-SESS_AUDIT_TRAIL: Stop icmp session: initiator \(10\.0\.1\.10:\d+\) sent \d+ bytes -- responder \(10\.0\.2\.10:\d+\) sent \d+ bytes/);
  });

  it('audit-trail off on one protocol silences it although the global audit trail is on', async () => {
    const lab = await zoneLab(['ip inspect audit-trail', ...OUTSIDE_ACL, 'ip inspect name R icmp audit-trail off', ...INSIDE_IN()]);
    await lab.inside.executeCommand('ping -c 1 10.0.2.10');
    expect(await lab.fw.executeCommand('show logging')).not.toContain('SESS_AUDIT_TRAIL');
  });

  it('clear ip inspect session deletes the session, and the next reply is blocked again', async () => {
    const lab = await zoneLab([...OUTSIDE_ACL, 'ip inspect name R icmp', ...INSIDE_IN()]);
    await lab.inside.executeCommand('ping -c 1 10.0.2.10');
    expect(await lab.fw.executeCommand('show ip inspect sessions')).toContain('icmp');
    await lab.fw.executeCommand('clear ip inspect session');
    expect(await lab.fw.executeCommand('show ip inspect sessions')).not.toContain('icmp');
  });

  it('session limiting: a second session past max-sessions is dropped and logged', async () => {
    const lab = await zoneLab([...OUTSIDE_ACL, 'ip inspect name R parameter max-sessions 1 icmp', ...INSIDE_IN()]);
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).toContain('1 received');
    const before = lab.seenByOutside.count;
    expect(await lab.inside.executeCommand('ping -c 1 10.0.2.10')).not.toContain('1 received');
    expect(lab.seenByOutside.count).toBe(before);
    expect(await lab.fw.executeCommand('show logging')).toContain('%FW-4-SESSION_THRESHOLD_EXCEEDED');
  });

  it('log drop-pkt logs the packet the firewall dropped, and alert-off does not silence it', async () => {
    const lab = await zoneLab(['ip inspect log drop-pkt', 'ip inspect alert-off', ...OUTSIDE_ACL,
      'ip inspect name R parameter max-sessions 1 icmp', ...INSIDE_IN()]);
    await lab.inside.executeCommand('ping -c 1 10.0.2.10');
    await lab.inside.executeCommand('ping -c 1 10.0.2.10');
    const log = await lab.fw.executeCommand('show logging');
    expect(log).toMatch(/%FW-6-DROP_PKT: Dropping icmp pkt 10\.0\.1\.10:\d+ => 10\.0\.2\.10:\d+ with ip ident \d+ due to Session limiting/);
    expect(log).not.toContain('SESSION_THRESHOLD_EXCEEDED');
  });
});

describe('CBAC: half-open session protection', () => {
  const HALF_OPEN_TARGET = '10.0.2.99';
  const attempts = async (lab: Awaited<ReturnType<typeof zoneLab>>, count: number): Promise<void> => {
    for (let i = 0; i < count; i++) await lab.inside.executeCommand(`nc -z -w 1 ${HALF_OPEN_TARGET} 80`);
  };
  const halfOpen = async (lab: Awaited<ReturnType<typeof zoneLab>>): Promise<number> =>
    ((await lab.fw.executeCommand('show ip inspect sessions')).match(/SIS_OPENING/g) ?? []).length;

  it('the per-host threshold keeps at most N half-open sessions and logs the excess', async () => {
    const clock = installVirtualClock();
    const lab = await zoneLab([...OUTSIDE_ACL, 'ip inspect tcp max-incomplete host 2 block-time 0', 'ip inspect name R tcp', ...INSIDE_IN()]);
    await clock.advanceUntilSettled(attempts(lab, 4));
    expect(await halfOpen(lab)).toBe(2);
    expect(await lab.fw.executeCommand('show logging')).toContain(`%FW-4-HOST_TCP_ALERT_ON: Max tcp half-open connections (2) exceeded for host ${HALF_OPEN_TARGET}.`);
  });

  it('with a block-time the host is blocked, then released when the time expires', async () => {
    const clock = installVirtualClock();
    const lab = await zoneLab([...OUTSIDE_ACL, 'ip inspect tcp max-incomplete host 2 block-time 1', 'ip inspect name R tcp', ...INSIDE_IN()]);
    await clock.advanceUntilSettled(attempts(lab, 4));
    const log = await lab.fw.executeCommand('show logging');
    expect(log).toContain(`%FW-4-BLOCK_HOST: Blocking new TCP connections to host ${HALF_OPEN_TARGET} for 1 minutes`);
    expect(await halfOpen(lab)).toBe(0);
    clock.advance(61_000);
    expect(await lab.fw.executeCommand('show logging')).toContain(`%FW-4-UNBLOCK_HOST: New TCP connections to host ${HALF_OPEN_TARGET} no longer blocked`);
  });

  it('above max-incomplete high the firewall gets aggressive and deletes the oldest half-open session', async () => {
    const clock = installVirtualClock();
    const lab = await zoneLab([...OUTSIDE_ACL, 'ip inspect max-incomplete high 2', 'ip inspect max-incomplete low 1',
      'ip inspect tcp max-incomplete host 250 block-time 0', 'ip inspect name R tcp', ...INSIDE_IN()]);
    await clock.advanceUntilSettled(attempts(lab, 6));
    expect(await halfOpen(lab)).toBeLessThanOrEqual(3);
    expect(await lab.fw.executeCommand('show logging')).toMatch(/%FW-4-ALERT_ON: getting aggressive, count \(\d+\/2\) current 1-min rate: \d+/);
  });

  it('alert-off silences the aggressive-mode alert although the protection still acts', async () => {
    const clock = installVirtualClock();
    const lab = await zoneLab(['ip inspect alert-off', ...OUTSIDE_ACL, 'ip inspect max-incomplete high 2', 'ip inspect max-incomplete low 1',
      'ip inspect tcp max-incomplete host 250 block-time 0', 'ip inspect name R tcp', ...INSIDE_IN()]);
    await clock.advanceUntilSettled(attempts(lab, 6));
    expect(await halfOpen(lab)).toBeLessThanOrEqual(3);
    expect(await lab.fw.executeCommand('show logging')).not.toContain('ALERT_ON');
  });
});

describe('CBAC: configuration and views', () => {
  it('show ip inspect config prints the defaults the book prints', async () => {
    const lab = await zoneLab();
    expect(await lab.fw.executeCommand('show ip inspect config')).toBe([
      'Session audit trail is disabled',
      'one-minute (sampling period) thresholds are [400:500] connections',
      'max-incomplete sessions thresholds are [400:500]',
      'max-incomplete tcp connections per host is 50. Block-time 0 minute.',
      'tcp synwait-time is 30 sec -- tcp finwait-time is 5 sec',
      'tcp idle-time is 3600 sec -- udp idle-time is 30 sec',
      'dns-timeout is 5 sec',
    ].join('\n'));
  });

  it('every global setting is shown, rendered in the running-config, and reset by its no form', async () => {
    const lab = await zoneLab([
      'ip inspect audit-trail', 'ip inspect dns-timeout 9', 'ip inspect tcp idle-time 1800', 'ip inspect tcp synwait-time 20',
      'ip inspect tcp finwait-time 7', 'ip inspect udp idle-time 15', 'ip inspect max-incomplete high 900', 'ip inspect max-incomplete low 800',
      'ip inspect one-minute high 1000', 'ip inspect one-minute low 950', 'ip inspect tcp max-incomplete host 40 block-time 2',
    ]);
    const config = await lab.fw.executeCommand('show ip inspect config');
    expect(config).toContain('Session audit trail is enabled');
    expect(config).toContain('one-minute (sampling period) thresholds are [950:1000] connections');
    expect(config).toContain('max-incomplete sessions thresholds are [800:900]');
    expect(config).toContain('max-incomplete tcp connections per host is 40. Block-time 2 minute.');
    expect(config).toContain('tcp synwait-time is 20 sec -- tcp finwait-time is 7 sec');
    expect(config).toContain('tcp idle-time is 1800 sec -- udp idle-time is 15 sec');
    expect(config).toContain('dns-timeout is 9 sec');
    const running = await lab.fw.executeCommand('show running-config');
    for (const line of ['ip inspect audit-trail', 'ip inspect dns-timeout 9', 'ip inspect tcp idle-time 1800', 'ip inspect tcp max-incomplete host 40 block-time 2',
      'ip inspect one-minute high 1000', 'ip inspect max-incomplete low 800']) expect(running).toContain(line);
    for (const line of ['ip inspect audit-trail', 'ip inspect dns-timeout', 'ip inspect tcp idle-time', 'ip inspect tcp synwait-time', 'ip inspect tcp finwait-time',
      'ip inspect udp idle-time', 'ip inspect max-incomplete high', 'ip inspect max-incomplete low', 'ip inspect one-minute high', 'ip inspect one-minute low',
      'ip inspect tcp max-incomplete host']) await configure(lab, `no ${line}`);
    expect(await lab.fw.executeCommand('show ip inspect config')).toContain('tcp idle-time is 3600 sec -- udp idle-time is 30 sec');
  });

  it('an out-of-range or malformed value is refused', async () => {
    const lab = await zoneLab();
    await lab.fw.executeCommand('configure terminal');
    expect(await lab.fw.executeCommand('ip inspect tcp max-incomplete host 251 block-time 0')).toContain('% Invalid input');
    expect(await lab.fw.executeCommand('ip inspect tcp idle-time zorglub')).toContain('% Invalid input');
    expect(await lab.fw.executeCommand('ip inspect name R zorglub')).toContain('% Invalid input');
  });

  it('show ip inspect name, interfaces and all follow the book layout', async () => {
    const lab = await zoneLab([...OUTSIDE_ACL, 'ip inspect name R tcp', 'ip inspect name R udp timeout 15', 'ip inspect name R ftp alert off', ...INSIDE_IN()]);
    const name = await lab.fw.executeCommand('show ip inspect name R');
    expect(name).toContain('Inspection Rule Configuration');
    expect(name).toContain(' Inspection name R');
    expect(name).toContain('tcp alert is on audit-trail is off timeout 3600');
    expect(name).toContain('udp alert is on audit-trail is off timeout 15');
    expect(name).toContain('ftp alert is off audit-trail is off timeout 3600');
    const interfaces = await lab.fw.executeCommand('show ip inspect interfaces');
    expect(interfaces).toContain('Interface Configuration');
    expect(interfaces).toContain(' Interface GigabitEthernet0/0');
    expect(interfaces).toContain('  Inbound inspection rule is R');
    expect(interfaces).toContain('  Outgoing inspection rule is not set');
    expect(interfaces).toContain('  Inbound access list is not set');
    const all = await lab.fw.executeCommand('show ip inspect all');
    expect(all).toContain('Session audit trail is disabled');
    expect(all).toContain('Interface Configuration');
    expect(await lab.fw.executeCommand('show ip inspect name NOPE')).toContain('% Invalid input');
  });

  it('the running-config renders rules and bindings, and no ip inspect name removes a protocol, a set, or everything', async () => {
    const lab = await zoneLab([...OUTSIDE_ACL, 'ip inspect name R tcp', 'ip inspect name R udp timeout 15 audit-trail on', 'ip inspect name Q icmp', ...INSIDE_IN()]);
    const running = await lab.fw.executeCommand('show running-config');
    expect(running).toContain('ip inspect name R tcp');
    expect(running).toContain('ip inspect name R udp audit-trail on timeout 15');
    expect(running).toContain(' ip inspect R in');
    await configure(lab, 'no ip inspect name R udp');
    expect(await lab.fw.executeCommand('show ip inspect name R')).not.toContain('udp');
    await configure(lab, 'no ip inspect name Q');
    expect(await lab.fw.executeCommand('show ip inspect name Q')).toContain('% Invalid input');
    await configure(lab, 'no ip inspect name');
    expect(await lab.fw.executeCommand('show ip inspect name R')).toContain('% Invalid input');
  });

  it('show ip inspect statistics counts the sessions created and clear ip inspect statistics resets them', async () => {
    const lab = await zoneLab([...OUTSIDE_ACL, 'ip inspect name R icmp', ...INSIDE_IN()]);
    await lab.inside.executeCommand('ping -c 1 10.0.2.10');
    const stats = await lab.fw.executeCommand('show ip inspect statistics');
    expect(stats).toContain('Interfaces configured for inspection 1');
    expect(stats).toContain('Session creations since subsystem startup or last reset 1');
    expect(stats).toContain('Current session counts (estab/half-open/terminating) [1:0:0]');
    await lab.fw.executeCommand('clear ip inspect statistics');
    const cleared = await lab.fw.executeCommand('show ip inspect statistics');
    expect(cleared).toContain('Session creations since subsystem startup or last reset 0');
    expect(cleared).not.toContain('Last statistic reset never');
  });
});
