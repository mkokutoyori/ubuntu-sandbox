/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security, Commands M to R):
 * `radius-server directed-request [restricted]` and `radius-server domain-stripping`.
 *
 *   directed-request   user@server: the request goes to that configured server first and only
 *                      `user` is sent; restricted forbids falling back to the other servers; a
 *                      host that is no configured server leaves the string whole
 *   domain-stripping   the domain is removed from the username before it is forwarded
 *                      (right-to-left, prefix-delimiter, delimiter, strip-suffix, vrf)
 *
 * Lab: shared with radius-server-deadtime-dead-criteria (a NAS and two RADIUS servers on one
 * switch, real frames). The first server (10.0.0.2) is up on the wire but silent; the second
 * (10.0.0.3) answers. What the server saw is read from the User-Name attribute of the Access-Request
 * as it ARRIVES on the server's port, not from the NAS's state.
 *
 * Measured with src stashed to HEAD: 10 of the 17 cases fall (the commands are rejected). Seven
 * pass either way: the two witnesses (without the commands the whole string is sent), "a host that
 * is no configured server leaves the string whole", and the four pure-function cases on the rule
 * engine, which do not go through the CLI.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import { DomainStripping } from '@/network/devices/router/aaa/UsernameRouting';
import { radiusLab, radiusLogin } from './_helpers/radiusAaaLab';
import type { VirtualTimeScheduler } from '@/events/Scheduler';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

describe('domain stripping on the wire', () => {
  it('witness: without the command the whole string reaches the server and is rejected', async () => {
    const { nas, toSilent, toLive } = await radiusLab([]);
    expect(await radiusLogin(clock, nas, 'alice@corp.example')).toBe(false);
    expect([...toSilent.usernames, ...toLive.usernames]).toContain('alice@corp.example');
  });

  it('the default rule strips the suffix at the first @ before it is sent', async () => {
    const { nas, toLive } = await radiusLab(['radius-server domain-stripping']);
    expect(await radiusLogin(clock, nas, 'alice@corp.example')).toBe(true);
    expect(toLive.usernames).toEqual(['alice']);
  });

  it('a prefix delimiter strips the prefix as well', async () => {
    const { nas, toLive } = await radiusLab(['radius-server domain-stripping prefix-delimiter /']);
    expect(await radiusLogin(clock, nas, 'corp/alice@corp.example')).toBe(true);
    expect(toLive.usernames).toEqual(['alice']);
  });

  it('strip-suffix strips only the named suffix', async () => {
    const { nas, toLive } = await radiusLab(['radius-server domain-stripping strip-suffix corp.example']);
    expect(await radiusLogin(clock, nas, 'alice@corp.example')).toBe(true);
    expect(await radiusLogin(clock, nas, 'alice@other.example')).toBe(false);
    expect(toLive.usernames).toEqual(['alice', 'alice@other.example']);
  });

  it('the vrf form applies only to servers reached through an interface of that VRF', async () => {
    const inVrf = ['ip vrf BANK', 'exit', 'interface GigabitEthernet0/0', 'ip vrf forwarding BANK',
      'ip address 10.0.0.1 255.255.255.0', 'exit'];
    const withVrf = await radiusLab([...inVrf, 'radius-server domain-stripping vrf BANK']);
    expect(await radiusLogin(clock, withVrf.nas, 'alice@corp.example')).toBe(true);
    expect(withVrf.toLive.usernames).toEqual(['alice']);
    const otherVrf = await radiusLab(['ip vrf OTHER', 'exit', 'radius-server domain-stripping vrf OTHER']);
    expect(await radiusLogin(clock, otherVrf.nas, 'alice@corp.example')).toBe(false);
    expect(otherVrf.toLive.usernames).toEqual(['alice@corp.example']);
  });

  it('rules are rendered and the no form removes them', async () => {
    const { nas } = await radiusLab([
      'radius-server domain-stripping right-to-left prefix-delimiter / delimiter @$',
      'radius-server domain-stripping strip-suffix corp.example',
    ]);
    const config = await nas.executeCommand('show running-config');
    expect(config).toContain('radius-server domain-stripping right-to-left prefix-delimiter / delimiter @$');
    expect(config).toContain('radius-server domain-stripping strip-suffix corp.example');
    await nas.executeCommand('configure terminal');
    await nas.executeCommand('no radius-server domain-stripping strip-suffix corp.example');
    await nas.executeCommand('no radius-server domain-stripping');
    await nas.executeCommand('end');
    expect(await nas.executeCommand('show running-config')).not.toContain('radius-server domain-stripping');
  });
});

describe('the documented stripping examples on the rule engine (witnesses: pure function)', () => {
  it('left to right strips at the first @, right to left at the last delimiter', () => {
    const left = new DomainStripping();
    left.configure(undefined, {});
    expect(left.apply('user@cisco.com@cisco.net', null)).toBe('user');
    const right = new DomainStripping();
    right.configure(undefined, { rightToLeft: true });
    expect(right.apply('user@cisco.com@cisco.net', null)).toBe('user@cisco.com');
  });

  it('book example: right-to-left with delimiters @ \\ $', () => {
    const rules = new DomainStripping();
    rules.configure(undefined, { rightToLeft: true, suffixDelimiters: '@\\$' });
    expect(rules.apply('cisco/user@cisco.com$cisco.net', null)).toBe('cisco/user@cisco.com');
  });

  it('book example: prefix delimiter / then default suffix @', () => {
    const rules = new DomainStripping();
    rules.configure(undefined, { prefixDelimiters: '/' });
    expect(rules.apply('cisco/user@cisco.com', null)).toBe('user');
  });

  it('strip-suffix disables generic stripping and needs delimiter and suffix to match', () => {
    const rules = new DomainStripping();
    rules.addSuffix(undefined, 'cisco.net');
    expect(rules.apply('user@cisco.net', null)).toBe('user');
    expect(rules.apply('user@cisco.com', null)).toBe('user@cisco.com');
  });
});

describe('radius-server directed-request on the wire', () => {
  it('witness: without it user@host is sent whole to the first server of the group', async () => {
    const { nas, toSilent } = await radiusLab([]);
    await radiusLogin(clock, nas, 'alice@10.0.0.3');
    expect(toSilent.usernames).toEqual(['alice@10.0.0.3']);
  });

  it('the request goes to the directed server, with the bare username, and the other is not contacted', async () => {
    const { nas, toSilent, toLive } = await radiusLab(['radius-server directed-request']);
    expect(await radiusLogin(clock, nas, 'alice@10.0.0.3')).toBe(true);
    expect(toLive.usernames).toEqual(['alice']);
    expect(toSilent.count).toBe(0);
  });

  it('without restricted the other servers are tried when the directed one is silent', async () => {
    const { nas, toSilent, toLive } = await radiusLab(['radius-server directed-request']);
    expect(await radiusLogin(clock, nas, 'alice@10.0.0.2')).toBe(true);
    expect(toSilent.usernames).toEqual(['alice']);
    expect(toLive.usernames).toEqual(['alice']);
  });

  it('with restricted a silent directed server is the only one asked', async () => {
    const { nas, toSilent, toLive } = await radiusLab(['radius-server directed-request restricted']);
    expect(await radiusLogin(clock, nas, 'alice@10.0.0.2')).toBe(false);
    expect(toSilent.usernames).toEqual(['alice']);
    expect(toLive.count).toBe(0);
  });

  it('a host that is no configured server leaves the string whole', async () => {
    const { nas, toSilent } = await radiusLab(['radius-server directed-request']);
    await radiusLogin(clock, nas, 'alice@nowhere.example');
    expect(toSilent.usernames).toEqual(['alice@nowhere.example']);
  });

  it('directed-request is applied before domain stripping', async () => {
    const { nas, toLive } = await radiusLab(['radius-server directed-request', 'radius-server domain-stripping']);
    expect(await radiusLogin(clock, nas, 'alice@corp.example@10.0.0.3')).toBe(true);
    expect(toLive.usernames).toEqual(['alice']);
  });

  it('rendering, and the no forms (restricted alone, then the whole command)', async () => {
    const { nas } = await radiusLab(['radius-server directed-request restricted']);
    expect(await nas.executeCommand('show running-config')).toContain('radius-server directed-request restricted');
    await nas.executeCommand('configure terminal');
    await nas.executeCommand('no radius-server directed-request restricted');
    await nas.executeCommand('end');
    const kept = await nas.executeCommand('show running-config');
    expect(kept).toMatch(/radius-server directed-request\n/);
    expect(kept).not.toContain('directed-request restricted');
    await nas.executeCommand('configure terminal');
    await nas.executeCommand('no radius-server directed-request');
    await nas.executeCommand('end');
    expect(await nas.executeCommand('show running-config')).not.toContain('radius-server directed-request');
  });
});
