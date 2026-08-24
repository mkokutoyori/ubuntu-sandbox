/**
 * Une zone SD-WAN suit ses MEMBRES, et un membre reference est refuse.
 *
 * Les deux entrees `[sdwan]` de `TODO.md`, plus un troisieme defaut que
 * la mesure a trouve et qu'aucune des deux ne nomme : `delete` d'un
 * membre ne retire ni le membre ni sa route.
 *
 * Ecrite A L'AVEUGLE contre ce que fait un vrai FortiGate :
 *
 *   1. Ajouter un membre APRES la route de zone developpe sa route.
 *   2. Retirer un membre retire SA route et laisse les autres.
 *   3. Un membre retire ne sert plus a aiguiller.
 *   4. Retirer une ZONE entiere retire ses routes.
 *   5. `set interface` sur un membre est REFUSE quand une politique
 *      nomme encore cette interface — au niveau de la source de
 *      donnees, comme sur un vrai boitier :
 *        entry not found in datasource
 *        value parse error before 'port1'
 *   6. Meme refus quand une ROUTE STATIQUE la nomme encore.
 *   7. Meme refus quand une `config system zone` la nomme encore.
 *   8. TEMOIN : une interface que rien ne nomme est acceptee.
 *   9. Une fois membre, l'interface ne peut plus entrer dans une
 *      `config system zone` — la reciproque, transcription attestee.
 *  10. `diagnose sys cmdb refcnt show system.interface.name port1` NOMME
 *      ce qui reference l'interface. La forme des lignes est attestee :
 *        entry used by child table srcintf:name 'X' of table
 *          firewall.policy:policyid '6'
 *        entry used by table router.static:seq-num '1'
 *      (transcriptions : Simone-Zabberoni/misc-one-liners FORTIGATE.md,
 *      et le tip Fortinet « Verifying FortiGate configuration object
 *      references and dependencies »). Il n'y a PAS de ligne de total :
 *      une reference par ligne, rien du tout s'il n'y en a aucune.
 *  11. Ce qui a ete supprime ne parait plus.
 *  12. TEMOIN : une interface libre ne rend rien.
 *
 * Discrimine par `git stash push -- src/network/` : 11 cas tombent avant
 * correctif. Les 2 qui passent des DEUX cotes sont nommes ici plutot que
 * laisses a decouvrir, et aucun ne prouve quoi que ce soit — « ce qui a
 * ete supprime ne parait plus » et le TEMOIN de la derniere section sont
 * deux `not.toContain`, or avant correctif la commande n'existait pas et
 * rendait `Unknown action 0` : une absence de sortie et une sortie vide
 * y sont indiscernables. Ils gardent contre une regression, ils
 * n'attestent pas la fonction.
 */

import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();

  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', 'set ip 10.0.1.1 255.255.255.0', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.0.2.1 255.255.255.0', 'next',
    'edit "port3"', 'set mode static', 'set ip 10.0.3.1 255.255.255.0', 'next',
    'edit "port4"', 'set mode static', 'set ip 10.0.4.1 255.255.255.0', 'next', 'end');

  return { fw, sh };
}

function poserZoneEtMembres(sh: FortiShell, ...sequences: number[]): void {
  run(sh, 'config system sdwan', 'set status enable',
    'config zone', 'edit "virtual-wan-link"', 'next', 'end',
    'config members');
  for (const sequence of sequences) {
    run(sh, `edit ${sequence}`, `set interface "port${sequence}"`,
      `set gateway 10.0.${sequence}.254`, 'set zone "virtual-wan-link"', 'next');
  }
  run(sh, 'end', 'end');
}

function ajouterMembre(sh: FortiShell, sequence: number): string {
  return run(sh, 'config system sdwan', 'config members',
    `edit ${sequence}`, `set interface "port${sequence}"`,
    `set gateway 10.0.${sequence}.254`, 'set zone "virtual-wan-link"',
    'next', 'end', 'end');
}

function routeParLaZone(sh: FortiShell): void {
  run(sh, 'config router static', 'edit 1', 'set dst 0.0.0.0 0.0.0.0',
    'set device "virtual-wan-link"', 'next', 'end');
}

function passerelles(fw: FortiGate): string[] {
  return fw.getRouteTable().all()
    .filter(route => route.network === '0.0.0.0')
    .map(route => route.nextHop ?? '')
    .sort();
}

describe('une zone SD-WAN suit ses membres', () => {
  it('un membre ajoute APRES la route developpe sa route', () => {
    const { fw, sh } = laboratoire();
    poserZoneEtMembres(sh, 1, 2);
    routeParLaZone(sh);

    ajouterMembre(sh, 3);

    expect(passerelles(fw)).toEqual(['10.0.1.254', '10.0.2.254', '10.0.3.254']);
  });

  it('un membre retire perd SA route, les autres restent', () => {
    const { fw, sh } = laboratoire();
    poserZoneEtMembres(sh, 1, 2, 3);
    routeParLaZone(sh);

    run(sh, 'config system sdwan', 'config members', 'delete 2', 'end', 'end');

    expect(passerelles(fw)).toEqual(['10.0.1.254', '10.0.3.254']);
  });

  it('un membre retire ne sert plus a aiguiller', () => {
    const { fw, sh } = laboratoire();
    poserZoneEtMembres(sh, 1, 2);

    run(sh, 'config system sdwan', 'config members', 'delete 2', 'end', 'end');

    const membres = fw.getSdwanTable().membersOfZone('virtual-wan-link');
    expect(membres.map(member => member.sequence)).toEqual([1]);
  });

  it('retirer la zone retire ses routes', () => {
    const { fw, sh } = laboratoire();
    poserZoneEtMembres(sh, 1, 2);
    routeParLaZone(sh);

    run(sh, 'config system sdwan', 'config members', 'delete 1', 'delete 2', 'end',
      'config zone', 'delete "virtual-wan-link"', 'end', 'end');

    expect(passerelles(fw)).toEqual([]);
  });
});

describe('un membre reference ailleurs est refuse', () => {
  function politiqueVers(sh: FortiShell, iface: string): void {
    run(sh, 'config firewall policy', 'edit 1',
      'set srcintf "port4"', `set dstintf "${iface}"`,
      'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
      'set action accept', 'set schedule "always"', 'next', 'end');
  }

  it('une politique nommant l interface refuse le membre', () => {
    const { sh } = laboratoire();
    politiqueVers(sh, 'port1');

    const refus = ajouterMembre(sh, 1);

    expect(refus).toContain('entry not found in datasource');
    expect(refus).toContain("value parse error before 'port1'");
  });

  it('une route statique nommant l interface refuse le membre', () => {
    const { sh } = laboratoire();
    run(sh, 'config router static', 'edit 7', 'set dst 192.168.9.0 255.255.255.0',
      'set device "port1"', 'set gateway 10.0.1.254', 'next', 'end');

    const refus = ajouterMembre(sh, 1);

    expect(refus).toContain('entry not found in datasource');
  });

  it('une zone systeme nommant l interface refuse le membre', () => {
    const { sh } = laboratoire();
    run(sh, 'config system zone', 'edit "dmz"', 'set interface "port1"', 'next', 'end');

    const refus = ajouterMembre(sh, 1);

    expect(refus).toContain('entry not found in datasource');
  });

  it('TEMOIN : une interface que rien ne nomme est acceptee', () => {
    const { fw, sh } = laboratoire();

    const sortie = ajouterMembre(sh, 1);

    expect(sortie).not.toContain('entry not found in datasource');
    expect(fw.getSdwanTable().member(1)?.iface).toBe('port1');
  });

  it('une interface deja membre ne peut plus entrer dans une zone systeme', () => {
    const { sh } = laboratoire();
    poserZoneEtMembres(sh, 1);

    const refus = run(sh, 'config system zone', 'edit "dmz"',
      'set interface "port1"', 'next', 'end');

    expect(refus).toContain('entry not found in datasource');
  });
});

describe('`diagnose sys cmdb refcnt show` compte les references', () => {
  it('la politique qui nomme l interface est comptee et NOMMEE', () => {
    const { sh } = laboratoire();
    run(sh, 'config firewall policy', 'edit 1',
      'set srcintf "port4"', 'set dstintf "port1"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
      'set action accept', 'set schedule "always"', 'next', 'end');

    const vu = run(sh, 'diagnose sys cmdb refcnt show system.interface.name port1');

    expect(vu).toContain(
      "entry used by child table dstintf:name 'port1' of table firewall.policy:policyid '1'");
  });

  it('une route statique est nommee par la forme sans table enfant', () => {
    const { sh } = laboratoire();
    run(sh, 'config router static', 'edit 7', 'set dst 192.168.9.0 255.255.255.0',
      'set device "port1"', 'set gateway 10.0.1.254', 'next', 'end');

    const vu = run(sh, 'diagnose sys cmdb refcnt show system.interface.name port1');

    expect(vu).toContain("entry used by table router.static:seq-num '7'");
  });

  it('ce qui a ete supprime ne parait plus', () => {
    const { sh } = laboratoire();
    run(sh, 'config firewall policy', 'edit 1',
      'set srcintf "port4"', 'set dstintf "port1"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
      'set action accept', 'set schedule "always"', 'next', 'end');
    run(sh, 'config firewall policy', 'delete 1', 'end');

    const vu = run(sh, 'diagnose sys cmdb refcnt show system.interface.port1');

    expect(vu).not.toContain('firewall.policy');
  });

  it('TEMOIN : une interface libre ne rend rien', () => {
    const { sh } = laboratoire();

    const vu = run(sh, 'diagnose sys cmdb refcnt show system.interface.name port3');

    expect(vu).not.toContain('entry used by');
  });
});
