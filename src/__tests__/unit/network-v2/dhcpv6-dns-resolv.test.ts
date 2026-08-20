/**
 * What a DHCPv6 REPLY teaches the host beyond its address.
 *
 * The defect, established against an IPv4 witness built in the same
 * file: a `dns-server` configured under `ipv6 dhcp pool` is carried by
 * the pool, transported by the packet (`DHCPv6Packet.dnsServers` exists
 * and the server fills it) and DROPPED on arrival —
 * `requestDhcpv6Lease` read only the address from its REPLY.
 * `/etc/resolv.conf` stayed empty while the same lab in IPv4 writes it.
 *
 * The witness is indispensable: without it, "resolv.conf is empty" does
 * not tell a broken v6 client from a simulator that writes that file
 * for nobody.
 */

import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

const cfg = async (r: CiscoRouter, lines: string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const l of lines) out.push(await r.executeCommand(l));
  return out;
};

async function laboV6(options: { dns?: boolean } = {}): Promise<{ h: LinuxPC; outputs: string[] }> {
  const r = new CiscoRouter('R1');
  const h = new LinuxPC('H');
  h.powerOn();
  const outputs = await cfg(r, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'ipv6 dhcp pool LAB', 'address prefix 2001:db8:aa::/64',
    ...(options.dns === false ? [] : ['dns-server 2001:db8:aa::53', 'domain-name lab.local']),
    'exit',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:aa::1/64',
    'ipv6 dhcp server LAB', 'ipv6 nd managed-config-flag', 'no shutdown', 'end',
  ]);
  new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, h.getPort('eth0')!);
  return { h, outputs };
}

describe('le temoin IPv4, monte dans le meme simulateur', () => {
  it('un bail DHCPv4 ecrit bien /etc/resolv.conf', async () => {
    const r = new CiscoRouter('R1');
    const h = new LinuxPC('H');
    h.powerOn();
    await cfg(r, [
      'enable', 'configure terminal',
      'ip dhcp pool LAB', 'network 10.0.0.0 255.255.255.0',
      'default-router 10.0.0.1', 'dns-server 10.0.0.53', 'domain-name lab.local', 'exit',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end',
    ]);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, h.getPort('eth0')!);
    await h.executeCommand('dhclient eth0');

    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('nameserver 10.0.0.53');
    expect(resolv).toContain('search lab.local');
  });
});

describe('un bail DHCPv6 apprend aussi le resolveur', () => {
  it('le server de noms du pool atteint /etc/resolv.conf', async () => {
    const { h } = await laboV6();
    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('nameserver 2001:db8:aa::53');
  });

  it('le nom de domaine devient la line search', async () => {
    const { h } = await laboV6();
    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('search lab.local');
  });

  it('un pool sans server de noms n\'ecrit rien', async () => {
    const { h } = await laboV6({ dns: false });
    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    expect(resolv.trim()).toBe('');
  });
});

describe('les deux familles cohabitent', () => {
  it('le bail v6 n\'efface pas le resolveur appris en v4', async () => {
    // The v4 path rewrites the whole file; if v6 did the same, the
    // second lease would silently erase the first resolver.
    const r = new CiscoRouter('R1');
    const h = new LinuxPC('H');
    h.powerOn();
    await cfg(r, [
      'enable', 'configure terminal', 'ipv6 unicast-routing',
      'ip dhcp pool V4', 'network 10.0.0.0 255.255.255.0',
      'default-router 10.0.0.1', 'dns-server 10.0.0.53', 'exit',
      'ipv6 dhcp pool V6', 'address prefix 2001:db8:aa::/64',
      'dns-server 2001:db8:aa::53', 'exit',
      'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'ipv6 address 2001:db8:aa::1/64',
      'ipv6 dhcp server V6', 'no shutdown', 'end',
    ]);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, h.getPort('eth0')!);

    await h.executeCommand('dhclient eth0');
    await h.executeCommand('dhclient -6 eth0');

    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('nameserver 10.0.0.53');
    expect(resolv).toContain('nameserver 2001:db8:aa::53');
  });

  it('deux leases v6 de suite n\'ecrivent pas la line deux fois', async () => {
    const { h } = await laboV6();
    await h.executeCommand('dhclient -6 eth0');
    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    const lines = resolv.split('\n').filter((l) => l.includes('2001:db8:aa::53'));
    expect(lines.length).toBe(1);
  });
});
