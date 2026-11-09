/*
 * Probe: `config system vdom-property` (FortiOS CLI Reference 7.4.12 p.2055: "Maximum guaranteed number of ..." per
 * resource, "Not Specified" by default) was an unknown path, so a multi-tenant lab could not cap what a VDOM may hold.
 * The table now has one entry per VDOM, kept in step with `config vdom`, and the maximum of each resource it names is
 * ENFORCED in that VDOM: firewall policies, addresses, address groups, custom services, service groups, schedules, local
 * users, user groups and IPsec interface tunnels refuse a new entry past the ceiling (predefined objects such as `all`
 * do not count), and the session table refuses a new session past `session`. A guaranteed share only means something when
 * several VDOMs draw on one pool, which the simulator does not model: it is validated (never above the maximum) and stored,
 * not arbitrated.
 *
 * Discriminated with git stash on src/network: 8 of 9 fall before the fix; the witness (without a limit the VDOM takes as
 * many addresses as asked) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
});

async function run(device: FortiGate, ...lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of lines) out.push(await device.executeCommand(line));
  return out;
}

const address = (name: string, ip: string) => [
  'config firewall address', `edit "${name}"`, 'set type ipmask', `set subnet ${ip} 255.255.255.255`, 'next', 'end',
];

const FULL = /maximum number of entries has been reached/;

describe('system vdom-property', () => {
  it('witness: without a limit the VDOM takes as many addresses as asked', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const out = await run(fgt, ...address('a', '10.0.0.1'), ...address('b', '10.0.0.2'), ...address('c', '10.0.0.3'));
    expect(out.join('\n')).not.toMatch(FULL);
  });

  it('keeps one entry per VDOM, in step with config vdom', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    await run(fgt, 'config system global', 'set vdom-mode multi-vdom', 'end', 'config vdom', 'edit TENANT', 'next', 'end');
    const shown = await fgt.executeCommand('show system vdom-property');
    expect(shown).toContain('edit "root"');
    expect(shown).toContain('edit "TENANT"');
  });

  it('accepts a maximum and a guaranteed share, shows them', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const out = await run(fgt, 'config system vdom-property', 'edit root', 'set firewall-address 5 2', 'next', 'end');
    expect(out.join('\n')).not.toMatch(/Command fail|unknown/i);
    expect(await fgt.executeCommand('show system vdom-property root')).toContain('set firewall-address 5 2');
  });

  it('refuses a guaranteed share above the maximum', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const out = await run(fgt, 'config system vdom-property', 'edit root', 'set firewall-address 2 5', 'next', 'end');
    expect(out.join('\n')).toMatch(/guaranteed number exceeds the maximum/);
  });

  it('refuses a property for a VDOM that does not exist', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const out = await run(fgt, 'config system vdom-property', 'edit GHOST', 'set session 10', 'next', 'end');
    expect(out.join('\n')).toMatch(/does not exist/);
  });

  it('caps firewall addresses, and the predefined `all` does not count', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    await run(fgt, 'config system vdom-property', 'edit root', 'set firewall-address 2', 'next', 'end');
    const out = await run(fgt, ...address('a', '10.0.0.1'), ...address('b', '10.0.0.2'), ...address('c', '10.0.0.3'));
    expect(out.slice(0, 12).join('\n')).not.toMatch(FULL);
    expect(out.slice(12).join('\n')).toMatch(FULL);
  });

  it('caps firewall policies', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    await run(fgt, 'config system vdom-property', 'edit root', 'set firewall-policy 1', 'next', 'end');
    const policy = (id: number) => ['config firewall policy', `edit ${id}`, 'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'set schedule "always"', 'next', 'end'];
    expect((await run(fgt, ...policy(1))).join('\n')).not.toMatch(FULL);
    expect((await run(fgt, ...policy(2))).join('\n')).toMatch(FULL);
  });

  it('caps local users and user groups', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    await run(fgt, 'config system vdom-property', 'edit root', 'set user 1', 'set user-group 1', 'next', 'end');
    const user = (name: string) => ['config user local', `edit "${name}"`, 'set type password', 'set passwd "Secret2026!"', 'next', 'end'];
    const group = (name: string) => ['config user group', `edit "${name}"`, 'next', 'end'];
    const out = await run(fgt, ...user('u1'), ...user('u2'), ...group('g1'), ...group('g2'));
    expect(out.slice(0, 6).join('\n')).not.toMatch(FULL);
    expect(out.slice(6, 12).join('\n')).toMatch(FULL);
    expect(out.slice(12, 16).join('\n')).not.toMatch(FULL);
    expect(out.slice(16).join('\n')).toMatch(FULL);
  });

  describe.each<[string, (n: number) => string[]]>([
    ['firewall-addrgrp', n => ['config firewall addrgrp', `edit "g${n}"`, 'set member "all"', 'next', 'end']],
    ['custom-service', n => ['config firewall service custom', `edit "s${n}"`, 'set tcp-portrange 8080', 'next', 'end']],
    ['service-group', n => ['config firewall service group', `edit "sg${n}"`, 'set member "HTTP"', 'next', 'end']],
    ['onetime-schedule', n => ['config firewall schedule onetime', `edit "o${n}"`, 'set start 00:00 2030/01/01',
      'set end 01:00 2030/01/02', 'next', 'end']],
    ['recurring-schedule', n => ['config firewall schedule recurring', `edit "r${n}"`, 'set start 08:00', 'set end 18:00',
      'set day monday', 'next', 'end']],
    ['ipsec-phase1-interface', n => ['config vpn ipsec phase1-interface', `edit "t${n}"`, 'set interface "port1"',
      `set remote-gw 10.9.0.${n}`, 'set psksecret sekret123', 'next', 'end']],
  ])('the %s ceiling', (resource, create) => {
    it('lets the first entry in and refuses the second', async () => {
      const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
      await run(fgt, 'config system vdom-property', 'edit root', `set ${resource} 1`, 'next', 'end');
      expect((await run(fgt, ...create(1))).join('\n')).not.toMatch(FULL);
      expect((await run(fgt, ...create(2))).join('\n')).toMatch(FULL);
    });
  });

  it('caps IPsec phase 2 interface tunnels', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    await run(fgt, 'config vpn ipsec phase1-interface', 'edit "t1"', 'set interface "port1"', 'set remote-gw 10.9.0.1',
      'set psksecret sekret123', 'next', 'end', 'config system vdom-property', 'edit root',
      'set ipsec-phase2-interface 1', 'next', 'end');
    const phase2 = (name: string) => ['config vpn ipsec phase2-interface', `edit "${name}"`, 'set phase1name "t1"', 'next', 'end'];
    expect((await run(fgt, ...phase2('q1'))).join('\n')).not.toMatch(FULL);
    expect((await run(fgt, ...phase2('q2'))).join('\n')).toMatch(FULL);
  });

  describe('the session ceiling', () => {
    async function sessionLab(limited: boolean) {
      const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      const web = new LinuxServer('linux-server', 'WEB', 0, 0);
      new Cable('a').connect(pc.getPort('eth0')!, fgt.getPort('port1')!);
      new Cable('b').connect(fgt.getPort('port2')!, web.getPort('eth0')!);
      await run(fgt, 'config system interface', 'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next',
        'edit port2', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next', 'end',
        'config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "port2"', 'set srcaddr "all"',
        'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'set schedule "always"', 'next', 'end',
        ...(limited ? ['config system vdom-property', 'edit root', 'set session 1', 'next', 'end'] : []));
      for (const c of ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1']) await pc.executeCommand(c);
      for (const c of ['ip link set eth0 up', 'ip addr add 203.0.113.9/24 dev eth0', 'ip route add default via 203.0.113.1', 'systemctl start nginx']) await web.executeCommand(c);
      return { pc };
    }

    it('witness: without a ceiling a second flow is served while the first session is still open', async () => {
      const { pc } = await sessionLab(false);
      expect(await pc.executeCommand('ping -c 1 203.0.113.9')).toContain('1 received');
      expect(await pc.executeCommand('curl -s -m 3 http://203.0.113.9/')).toMatch(/Welcome to nginx/);
    });

    it('with `set session 1`, the first session fills the VDOM and a second flow is refused', async () => {
      const { pc } = await sessionLab(true);
      expect(await pc.executeCommand('ping -c 1 203.0.113.9')).toContain('1 received');
      expect(await pc.executeCommand('curl -s -m 3 http://203.0.113.9/')).not.toMatch(/Welcome to nginx/);
    });
  });
});
