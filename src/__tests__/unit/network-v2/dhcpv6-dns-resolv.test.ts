/**
 * Ce qu'une REPLY DHCPv6 apprend a l'hote, en plus de son adresse.
 *
 * Le defaut, mesure contre un temoin IPv4 monte dans le meme fichier :
 * un `dns-server` configure sous `ipv6 dhcp pool` est porte par le pool,
 * transporte par le paquet (`DHCPv6Packet.dnsServers` existe et le
 * serveur le remplit) et JETE a l'arrivee — `requestDhcpv6Lease` ne
 * lisait de sa REPLY que l'adresse. `/etc/resolv.conf` restait vide,
 * alors que le meme laboratoire en IPv4 l'ecrit.
 *
 * Le temoin est indispensable : sans lui, « resolv.conf est vide » ne
 * distingue pas un client v6 defaillant d'un simulateur qui n'ecrirait
 * ce fichier pour personne.
 */

import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

const cfg = async (r: CiscoRouter, lignes: string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const l of lignes) out.push(await r.executeCommand(l));
  return out;
};

async function laboV6(options: { dns?: boolean } = {}): Promise<{ h: LinuxPC; sorties: string[] }> {
  const r = new CiscoRouter('R1');
  const h = new LinuxPC('H');
  h.powerOn();
  const sorties = await cfg(r, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'ipv6 dhcp pool LAB', 'address prefix 2001:db8:aa::/64',
    ...(options.dns === false ? [] : ['dns-server 2001:db8:aa::53', 'domain-name lab.local']),
    'exit',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:aa::1/64',
    'ipv6 dhcp server LAB', 'ipv6 nd managed-config-flag', 'no shutdown', 'end',
  ]);
  new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, h.getPort('eth0')!);
  return { h, sorties };
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
  it('le serveur de noms du pool atteint /etc/resolv.conf', async () => {
    const { h } = await laboV6();
    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('nameserver 2001:db8:aa::53');
  });

  it('le nom de domaine devient la ligne search', async () => {
    const { h } = await laboV6();
    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('search lab.local');
  });

  it('un pool sans serveur de noms n\'ecrit rien', async () => {
    const { h } = await laboV6({ dns: false });
    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    expect(resolv.trim()).toBe('');
  });
});

describe('les deux familles cohabitent', () => {
  it('le bail v6 n\'efface pas le resolveur appris en v4', async () => {
    // Le chemin v4 reecrit le fichier entier ; si le v6 faisait de meme,
    // le second bail effacerait silencieusement le premier resolveur.
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

  it('deux baux v6 de suite n\'ecrivent pas la ligne deux fois', async () => {
    const { h } = await laboV6();
    await h.executeCommand('dhclient -6 eth0');
    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    const lignes = resolv.split('\n').filter((l) => l.includes('2001:db8:aa::53'));
    expect(lignes.length).toBe(1);
  });
});
