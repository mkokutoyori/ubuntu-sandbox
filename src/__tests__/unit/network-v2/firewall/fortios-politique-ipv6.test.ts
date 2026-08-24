/**
 * Une politique IPv6 juge un paquet IPv6.
 *
 * L'entree `[politique] le TRANSIT IPv6 est refuse, faute de politique
 * v6`, que la phase 26 a inscrite comme son propre reste. La mesure la
 * confirme et trouve deux defauts qu'elle ne nomme pas :
 * `AddressObject.family` est ecrit et LU PAR PERSONNE, et les cinq
 * comparateurs d'`addressObjectMatches` passent par `tryIpToUint32`,
 * donc un candidat v6 ne peut correspondre qu'a `any` — et y
 * correspond.
 *
 * Ecrite A L'AVEUGLE contre ce que fait un vrai FortiGate 7.6 :
 *
 *   1. `config firewall address6` avec `set type ipprefix` / `set ip6`
 *      est acceptee et rendue.
 *   2. `all6` existe d'usine.
 *   3. `config firewall addrgrp6` groupe des objets v6.
 *   4. `srcaddr6` / `dstaddr6` existent sur `firewall policy` — c'est la
 *      politique UNIFIEE de FortiOS 6.4+, `policy6` ayant ete RETIREE.
 *   5. `config firewall policy6` est donc refusee, comme sur une vraie
 *      machine 7.6.
 *   6. Un paquet v6 traverse quand une regle le permet.
 *   7. Il ne traverse pas quand aucune regle ne le permet.
 *   8. Il ne traverse pas quand la regle nomme le mauvais prefixe.
 *   9. DEFAUT MESURE : une regle v4 `all` -> `all` ne doit PAS juger du
 *      trafic v6. Sans famille, `any` correspond a tout.
 *  10. Un objet adresse v6 ne correspond pas a un candidat v4, et
 *      reciproquement.
 *  11. `set ip6` refuse une valeur qui n'est pas un prefixe v6.
 *  12. TEMOIN : le meme laboratoire relaie en IPv4 sous sa regle v4.
 *
 * Discrimine par `git stash push -- src/network/` : 6 cas tombent avant
 * correctif. Les 5 qui passent des DEUX cotes sont nommes ici :
 *
 *   — le TEMOIN v4, dont c'est l'objet.
 *   — « `config firewall policy6` est refusee » : elle l'etait deja,
 *     faute d'existence, et le reste apres — le cas atteste qu'on n'a
 *     PAS ajoute une table que la 7.6 n'a pas, il n'atteste rien
 *     d'autre.
 *   — « `set ip6` refuse une valeur qui n'est pas un prefixe v6 » :
 *     avant correctif la table entiere etait refusee, donc le refus
 *     etait indiscernable de l'absence.
 *   — « sans regle v6, il ne traverse pas » et « une regle nommant le
 *     mauvais prefixe ne permet pas » : avant correctif RIEN ne
 *     traversait en v6 (verrou inconditionnel de la phase 26), donc un
 *     refus et une absence de mecanisme y sont indiscernables. Ces deux
 *     cas ne valent qu'accompagnes du cas 6, qui prouve qu'un paquet
 *     PEUT traverser.
 *
 * DEFAUT DE SOCLE TROUVE EN CHEMIN, et corrige avec : le cas 6 echouait
 * encore alors que la politique disait `allow` et que la requete
 * traversait. La trace du filtre l'a nomme — le voisin repondait depuis
 * son adresse SLAAC (`2001:db8:2::ff:fe00:d`) et non depuis celle qu'on
 * avait jointe (`2001:db8:2::10`), donc la reponse ne retombait sur
 * aucune session. `EndHost.handleICMPv6EchoRequest` choisissait
 * `port.getGlobalIPv6()`, c'est-a-dire la PREMIERE adresse globale du
 * port. RFC 4443 §4.2 est explicite : « The Source Address of an Echo
 * Reply sent in response to a unicast Echo Request message MUST be the
 * same as the destination address of that Echo Request message. » Le
 * defaut etait invisible tant que rien ne verifiait la source d'une
 * reponse ; le suivi de session du pare-feu la verifie.
 */

import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function run(sh: FortiShell, ...lines: string[]): string {
  const sorties: string[] = [];
  for (const line of lines) sorties.push(sh.execute(line));
  return sorties.filter(sortie => sortie !== '').join('\n');
}

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function runOn(device: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const command of commands) last = await device.executeCommand(command);
  return last;
}

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();
  const gauche = new LinuxPC('linux-pc', 'PCA', 200, 0);
  const droite = new LinuxPC('linux-pc', 'PCB', 400, 0);
  gauche.powerOn();
  droite.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, gauche.getPorts()[0]);
  new Cable('c2').connect(fw.getPort('port2')!, droite.getPorts()[0]);

  run(sh,
    'config system interface',
    'edit "port1"', 'config ipv6', 'set ip6-address 2001:db8:1::1/64',
    'set ip6-allowaccess ping', 'end', 'next',
    'edit "port2"', 'config ipv6', 'set ip6-address 2001:db8:2::1/64',
    'set ip6-allowaccess ping', 'end', 'next', 'end');

  await runOn(gauche,
    'ip link set eth0 up',
    'ip addr add 2001:db8:1::10/64 dev eth0',
    'ip route add default via 2001:db8:1::1');
  await runOn(droite,
    'ip link set eth0 up',
    'ip addr add 2001:db8:2::10/64 dev eth0',
    'ip route add default via 2001:db8:2::1');

  return { fw, sh, gauche, droite };
}

function reglePermissiveV6(sh: FortiShell, source = 'all6', destination = 'all6'): string {
  return run(sh, 'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    `set srcaddr6 "${source}"`, `set dstaddr6 "${destination}"`,
    'set service "ALL"', 'set action accept', 'set schedule "always"',
    'next', 'end');
}

describe('les objets adresse IPv6 existent', () => {
  it('`config firewall address6` est acceptee et rendue', async () => {
    const { sh } = await laboratoire();

    const sortie = run(sh, 'config firewall address6', 'edit "reseau-b"',
      'set type ipprefix', 'set ip6 2001:db8:2::/64', 'next', 'end');

    expect(sortie).not.toMatch(/Command fail|parse error/);
    expect(run(sh, 'show firewall address6')).toContain('set ip6 2001:db8:2::/64');
  });

  it('`all6` existe d usine comme source de donnees', async () => {
    const { fw, sh } = await laboratoire();

    const accepte = run(sh, 'config firewall policy', 'edit 1',
      'set srcaddr6 "all6"', 'next', 'end');
    const refuse = run(sh, 'config firewall policy', 'edit 2',
      'set srcaddr6 "inexistant6"', 'next', 'end');

    expect(accepte).not.toMatch(/not found in datasource/);
    expect(refuse).toMatch(/not found in datasource/);
    expect(fw.getObjectStore().matchesAddress('all6', '2001:db8::1')).toBe(true);
  });

  it('`config firewall addrgrp6` groupe des objets v6', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config firewall address6', 'edit "reseau-b"',
      'set type ipprefix', 'set ip6 2001:db8:2::/64', 'next', 'end');

    const sortie = run(sh, 'config firewall addrgrp6', 'edit "distants"',
      'set member "reseau-b"', 'next', 'end');

    expect(sortie).not.toMatch(/Command fail|parse error/);
    expect(run(sh, 'show firewall addrgrp6')).toContain('set member "reseau-b"');
  });

  it('`set ip6` refuse une valeur qui n est pas un prefixe v6', async () => {
    const { sh } = await laboratoire();

    const refus = run(sh, 'config firewall address6', 'edit "faux"',
      'set type ipprefix', 'set ip6 192.168.1.0/24', 'next', 'end');

    expect(refus).toMatch(/parse error|Command fail/);
  });
});

describe('la politique unifiee porte les deux familles', () => {
  it('`srcaddr6` et `dstaddr6` existent sur `firewall policy`', async () => {
    const { sh } = await laboratoire();

    expect(reglePermissiveV6(sh)).not.toMatch(/Command fail|parse error/);
    expect(run(sh, 'show firewall policy')).toContain('set srcaddr6 "all6"');
  });

  it('`config firewall policy6` est refusee, comme sur une 7.6', async () => {
    const { sh } = await laboratoire();

    expect(run(sh, 'config firewall policy6'))
      .toMatch(/unknown configuration path|Command fail/);
  });
});

describe('le verdict suit la famille', () => {
  it('un paquet v6 traverse quand une regle le permet', async () => {
    const { sh, gauche } = await laboratoire();
    reglePermissiveV6(sh);

    const vu = await runOn(gauche, 'ping6 -c 3 2001:db8:2::10');

    expect(vu).not.toMatch(/100% packet loss/);
  });

  it('sans regle v6, il ne traverse pas', async () => {
    const { sh, gauche } = await laboratoire();
    run(sh, 'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
      'set action accept', 'set schedule "always"', 'next', 'end');

    const vu = await runOn(gauche, 'ping6 -c 2 2001:db8:2::10');

    expect(vu).toMatch(/100% packet loss/);
  });

  it('une regle nommant le mauvais prefixe ne permet pas', async () => {
    const { sh, gauche } = await laboratoire();
    run(sh, 'config firewall address6', 'edit "ailleurs"',
      'set type ipprefix', 'set ip6 2001:db8:9::/64', 'next', 'end');
    reglePermissiveV6(sh, 'all6', 'ailleurs');

    const vu = await runOn(gauche, 'ping6 -c 2 2001:db8:2::10');

    expect(vu).toMatch(/100% packet loss/);
  });

  it('un objet v6 ne correspond pas a un candidat v4', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config firewall address6', 'edit "reseau-b"',
      'set type ipprefix', 'set ip6 2001:db8:2::/64', 'next', 'end');

    const objets = fw.getObjectStore();

    expect(objets.matchesAddress('reseau-b', '2001:db8:2::10')).toBe(true);
    expect(objets.matchesAddress('reseau-b', '192.168.2.10')).toBe(false);
    expect(objets.matchesAddress('all', '2001:db8:2::10')).toBe(false);
    expect(objets.matchesAddress('all6', '192.168.2.10')).toBe(false);
  });

  it('TEMOIN : le meme laboratoire relaie en IPv4 sous sa regle v4', async () => {
    const { sh, gauche } = await laboratoire();
    run(sh, 'config system interface',
      'edit "port1"', 'set mode static', 'set ip 192.168.1.1 255.255.255.0',
      'set allowaccess ping', 'next',
      'edit "port2"', 'set mode static', 'set ip 192.168.2.1 255.255.255.0',
      'set allowaccess ping', 'next', 'end');
    run(sh, 'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
      'set action accept', 'set schedule "always"', 'next', 'end');
    await runOn(gauche,
      'ip addr add 192.168.1.10/24 dev eth0',
      'ip route add default via 192.168.1.1');

    const vu = await runOn(gauche, 'ping -c 2 192.168.2.1');

    expect(vu).toMatch(/, 0% packet loss/);
  });
});
