/**
 * `config system dhcp6 server` sert VRAIMENT, et `execute dhcp lease-list <interface>`
 * filtre pour de bon.
 *
 * Mesure de depart, sur un FortiGate cable a un poste Linux. (1) Le pare-feu
 * PORTE un `DHCPv6Server` depuis toujours — `FirewallIpv6` en construisait un —
 * mais `getDhcpv6ServerPool` rendait `undefined` sans condition et AUCUNE
 * commande ne pouvait declarer un pool : `config system dhcp6 server` repondait
 * « unknown configuration path ». Le moteur etait donc joignable par personne,
 * et `execute dhcp6 lease-list` n'existait pas davantage. (2) Cote v4, deux
 * defauts de la meme famille : `execute dhcp lease-list port3` rendait le bail
 * de PORT2 — l'interface documentee etait acceptee et lue par personne, si bien
 * qu'un operateur filtrant sur une interface lisait un bail qui n'y est pas —
 * et `execute dhcp lease-clear all`, que la reference decrit, etait passe comme
 * une ADRESSE au magasin et refuse par « no lease held for all. ».
 *
 * Discrimine par `git stash push -u` sur les fichiers du correctif : 10 cas
 * tombent. Les 2 autres sont les TEMOINS, nommes ici plutot que laisses a
 * decouvrir : `execute dhcp lease-list` SANS argument montre le bail des deux
 * cotes — la liste complete a toujours ete juste, et c'est ce qui prouve que le
 * filtre est un filtre et non une panne ; et l'adresse SLAAC
 * survit au retrait du bail, l'autoconfiguration ne dependant pas de DHCPv6,
 * ce qui distingue « le bail est parti » de « la machine a tout perdu ».
 *
 * J'avais annonce 8 cas et la mesure en donne 10 : la sonde unitaire du moteur
 * tombe elle aussi, `configurePoolRanges` n'existant pas avant le correctif —
 * c'est une discrimination de STRUCTURE, pas de comportement, et le dire evite
 * de la compter pour ce qu'elle n'est pas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { DHCPv6Server } from '@/network/dhcpv6/DHCPv6Server';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(c: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  await taper(pc, ['ip link set eth0 up']);

  await taper(fgt, [
    'config system interface',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping',
    'config ipv6', 'set ip6-address 2001:db8:1:1::1/64', 'end', 'next',
    'edit port3', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'next',
    'end',
    'config system dhcp server', 'edit 1',
    'set interface "port2"',
    'set default-gateway 192.168.10.1', 'set netmask 255.255.255.0',
    'config ip-range', 'edit 1',
    'set start-ip 192.168.10.100', 'set end-ip 192.168.10.199', 'next', 'end',
    'set status enable', 'next', 'end',
  ]);
  return { fgt, pc };
}

async function serveurDhcp6(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config system dhcp6 server', 'edit 1',
    'set interface "port2"',
    'set subnet 2001:db8:1:1::/64',
    'set lease-time 86400',
    'set dns-service specify',
    'set dns-server1 2001:db8:1:1::53',
    'set domain "lab.local"',
    'config ip-range', 'edit 1',
    'set start-ip 2001:db8:1:1::1000',
    'set end-ip 2001:db8:1:1::1fff',
    'next', 'end',
    'set status enable', 'next', 'end',
  ]);
}

describe('un serveur DHCPv6 declare sert, et un bail se liste par interface', () => {
  it('`config system dhcp6 server` est accepte et se relit', async () => {
    const { fgt } = await laboratoire();
    for (const ligne of await serveurDhcp6(fgt)) {
      expect(ligne).not.toMatch(/unknown configuration path|command parse error|Invalid/i);
    }

    const conf = await fgt.executeCommand('show system dhcp6 server');
    expect(conf).toContain('set interface "port2"');
    expect(conf).toContain('set subnet 2001:db8:1:1::/64');
    expect(conf).toContain('set start-ip 2001:db8:1:1::1000');
    expect(conf).toContain('set end-ip 2001:db8:1:1::1fff');
    expect(conf).toContain('set lease-time 86400');
  });

  it('un client obtient une adresse PRISE DANS LA PLAGE declaree', async () => {
    const { fgt, pc } = await laboratoire();
    await serveurDhcp6(fgt);

    await pc.executeCommand('dhclient -6 eth0');
    const adresses = await pc.executeCommand('ip -6 addr show eth0');
    expect(adresses).toContain('2001:db8:1:1::1000/64');
  });

  it('les options du pool arrivent au client', async () => {
    const { fgt, pc } = await laboratoire();
    await serveurDhcp6(fgt);
    await pc.executeCommand('dhclient -6 eth0');

    const resolv = await pc.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('nameserver 2001:db8:1:1::53');
    expect(resolv).toContain('search lab.local');
  });

  it('`execute dhcp6 lease-list` montre le bail reellement attribue', async () => {
    const { fgt, pc } = await laboratoire();
    await serveurDhcp6(fgt);
    await pc.executeCommand('dhclient -6 eth0');

    const vue = await fgt.executeCommand('execute dhcp6 lease-list');
    expect(vue).not.toMatch(/unknown action/i);
    expect(vue).toContain('port2');
    expect(vue).toContain('IPv6-Address');
    expect(vue).toContain('2001:db8:1:1::1000');
  });

  it('`execute dhcp6 lease-list <interface>` ne montre que cette interface', async () => {
    const { fgt, pc } = await laboratoire();
    await serveurDhcp6(fgt);
    await pc.executeCommand('dhclient -6 eth0');

    expect(await fgt.executeCommand('execute dhcp6 lease-list port2'))
      .toContain('2001:db8:1:1::1000');
    expect(await fgt.executeCommand('execute dhcp6 lease-list port3'))
      .not.toContain('2001:db8:1:1::1000');
  });

  it('`execute dhcp6 lease-clear <adresse>` retire ce bail-la', async () => {
    const { fgt, pc } = await laboratoire();
    await serveurDhcp6(fgt);
    await pc.executeCommand('dhclient -6 eth0');

    expect(await fgt.executeCommand('execute dhcp6 lease-clear 2001:db8:1:1::1000'))
      .not.toMatch(/Command fail|unknown action/i);
    expect(await fgt.executeCommand('execute dhcp6 lease-list'))
      .not.toContain('2001:db8:1:1::1000');
    expect(await fgt.executeCommand('execute dhcp6 lease-clear 2001:db8:1:1::9999'))
      .toContain('no lease held for 2001:db8:1:1::9999.');
  });

  it('TEMOIN : l\'adresse SLAAC survit au retrait du bail', async () => {
    const { fgt, pc } = await laboratoire();
    await serveurDhcp6(fgt);
    await pc.executeCommand('dhclient -6 eth0');
    await fgt.executeCommand('execute dhcp6 lease-clear all');

    expect(await pc.executeCommand('ip -6 addr show eth0'))
      .toContain('2001:db8:1:1:0:ff:fe00:b/64');
  });

  it('`execute dhcp6 lease-clear all` vide la table', async () => {
    const { fgt, pc } = await laboratoire();
    await serveurDhcp6(fgt);
    await pc.executeCommand('dhclient -6 eth0');

    expect(await fgt.executeCommand('execute dhcp6 lease-clear all'))
      .not.toMatch(/Command fail|unknown action/i);
    expect(await fgt.executeCommand('execute dhcp6 lease-list')).toBe('');
  });

  it('`execute dhcp lease-list <interface>` filtre le bail v4', async () => {
    const { fgt, pc } = await laboratoire();
    await pc.executeCommand('dhclient -v eth0');

    expect(await fgt.executeCommand('execute dhcp lease-list port2'))
      .toMatch(/192\.168\.10\.1\d{2}/);
    expect(await fgt.executeCommand('execute dhcp lease-list port3'))
      .not.toMatch(/192\.168\.10\.1\d{2}/);
  });

  it('TEMOIN : `execute dhcp lease-list` sans argument montre tout', async () => {
    const { fgt, pc } = await laboratoire();
    await pc.executeCommand('dhclient -v eth0');

    expect(await fgt.executeCommand('execute dhcp lease-list'))
      .toMatch(/192\.168\.10\.1\d{2}/);
  });

  it('`execute dhcp lease-clear all` vide la table v4', async () => {
    const { fgt, pc } = await laboratoire();
    await pc.executeCommand('dhclient -v eth0');

    expect(await fgt.executeCommand('execute dhcp lease-clear all'))
      .not.toMatch(/Command fail|no lease held/i);
    expect(await fgt.executeCommand('execute dhcp lease-list')).toBe('');
  });

  it('le moteur sert la PLAGE et ne deborde pas sur le prefixe', () => {
    const serveur = new DHCPv6Server();
    serveur.createPool('p');
    serveur.configurePoolPrefix('p', '2001:db8::', 64);
    serveur.configurePoolRanges('p', [{
      startIp: '2001:db8::100', endIp: '2001:db8::101',
    }]);

    const pris: string[] = [];
    for (let client = 0; client < 3; client++) {
      const offre = serveur.processSolicit(
        { clientDuid: `duid-${client}`, iaid: 1, transactionId: client }, 'p');
      if (!offre) break;
      serveur.processRequest({
        clientDuid: `duid-${client}`, iaid: 1, transactionId: client,
        requestedAddress: offre.address, serverDuid: serveur.getServerDuid(),
      }, 'p');
      pris.push(offre.address);
    }

    expect(pris).toEqual(['2001:db8::100', '2001:db8::101']);
    expect(serveur.processSolicit(
      { clientDuid: 'duid-trop', iaid: 1, transactionId: 9 }, 'p')).toBeNull();
  });
});
