/**
 * `local-in-policy6` garde le pare-feu lui-meme en IPv6, et une famille
 * ne juge pas l'autre.
 *
 * Ecrit A L'AVEUGLE, contre `official_docs/forti-cli-ref-60.txt`
 * p. 219-220. Le lot precedent a livre `local-in-policy` en IPv4 et a
 * DELIBEREMENT laisse la table v6 hors du schema plutot que de
 * l'accepter sans l'evaluer : le chemin IPv6 n'avait aucune porte pour
 * le trafic qui lui est destine, et enregistrer la table aurait range un
 * critere que rien ne juge. C'est ce lot qui pose la porte.
 *
 * La regle de bout de liste est la MEME qu'en IPv4, et pour la meme
 * raison : Fortinet ecrit « Unlike IPv4 policies, there is no default
 * implicit deny policy », et rien dans la reference ne distingue les
 * deux familles sur ce point. Ce qui ne correspond a rien retombe donc
 * sur `ip6-allowaccess`.
 *
 * **Le cas qui compte le plus est celui de la FAMILLE.** Ce depot a deja
 * paye cette facture une fois, sur la politique de transit : une regle
 * v4 `all` -> `all` jugeait du trafic v6 parce qu'`any` correspondait a
 * tout, faute de famille. Le meme piege existe ici, en double — une
 * politique local-in v4 ne doit pas couper un ping6, et une politique
 * local-in v6 ne doit pas couper un ping v4. Les deux sens sont
 * eprouves, parce qu'un seul ne prouverait rien de l'autre.
 *
 * Ce que la reference dit et que ce fichier suit : sur la forme v6 les
 * objets d'adresse sont ceux de `firewall.address6` / `addrgrp6`, et
 * `ha-mgmt-intf-only` n'existe PAS — c'est un attribut de la seule forme
 * v4.
 *
 * Discrimination, mesuree seam par seam. Contre l'etat d'avant le lot,
 * 6 cas tombent. En ne retirant que la porte du plan de donnees IPv6
 * (`l3/FirewallIpv6.ts`), 3 tombent — les trois qui observent un refus
 * applique. Le cas de la source de donnees se discrimine seul, contre le
 * controle de reference : avant, `set srcaddr "all"` sur la table v6
 * rendait la chaine VIDE, c'est-a-dire une acceptation silencieuse.
 *
 * Les 8 qui passent des deux cotes sont nommes plutot que laisses a
 * decouvrir : les 2 TEMOINS sans politique, le TEMOIN d'interface, les
 * deux sens de la separation des familles, « ne correspond a rien »,
 * « desactivee » et l'ordre — tous passent AUSSI avant le lot, parce
 * qu'une fonction qui n'existe pas ne bloque rien. Ils gardent le
 * correctif contre un exces de zele ; ils ne prouvent pas la fonction.
 * Les deux cas de familles sont a lire ensemble : chacun seul ne dirait
 * rien de l'autre sens.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function run(sh: FortiShell, ...lines: string[]): string {
  const out: string[] = [];
  for (const line of lines) out.push(sh.execute(line));
  return out.filter(o => o !== '').join('\n');
}

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function runOn(device: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const command of commands) last = await device.executeCommand(command);
  return last;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function laboratoire() {
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
    'edit "port1"', 'set mode static', 'set ip 192.168.1.1 255.255.255.0',
    'set allowaccess ping ssh',
    'config ipv6', 'set ip6-address 2001:db8:1::1/64',
    'set ip6-allowaccess ping', 'end', 'next',
    'edit "port2"', 'set mode static', 'set ip 192.168.2.1 255.255.255.0',
    'set allowaccess ping ssh',
    'config ipv6', 'set ip6-address 2001:db8:2::1/64',
    'set ip6-allowaccess ping', 'end', 'next', 'end',
    'config firewall address6',
    'edit "RESEAU-B6"', 'set type ipprefix', 'set ip6 2001:db8:2::/64', 'next', 'end');

  await runOn(gauche,
    'ip link set eth0 up',
    'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1',
    'ip addr add 2001:db8:1::10/64 dev eth0',
    'ip route add default via 2001:db8:1::1');
  await runOn(droite,
    'ip link set eth0 up',
    'ip addr add 192.168.2.10/24 dev eth0',
    'ip route add default via 192.168.2.1',
    'ip addr add 2001:db8:2::10/64 dev eth0',
    'ip route add default via 2001:db8:2::1');

  return { fw, sh, gauche, droite };
}

const REUSSI = /, 0% packet loss/;
const PERDU = /100% packet loss/;

describe('sans politique local-in v6, rien ne change', () => {
  it('TEMOIN: les deux postes joignent le pare-feu en IPv6', async () => {
    const { gauche, droite } = await laboratoire();

    expect(await runOn(gauche, 'ping6 -c 1 2001:db8:1::1')).toMatch(REUSSI);
    expect(await runOn(droite, 'ping6 -c 1 2001:db8:2::1')).toMatch(REUSSI);
  });

  it('TEMOIN: les deux postes joignent le pare-feu en IPv4', async () => {
    const { gauche, droite } = await laboratoire();

    expect(await runOn(gauche, 'ping -c 1 192.168.1.1')).toMatch(REUSSI);
    expect(await runOn(droite, 'ping -c 1 192.168.2.1')).toMatch(REUSSI);
  });
});

describe('une politique local-in v6 de refus bloque le trafic v6', () => {
  it('un refus sur port2 coupe le ping6 du poste droit', async () => {
    const { sh, droite } = await laboratoire();

    run(sh, 'config firewall local-in-policy6', 'edit 1',
      'set intf "port2"', 'set srcaddr "all6"', 'set dstaddr "all6"',
      'set service "ALL"', 'set action deny', 'set schedule "always"',
      'next', 'end');

    expect(await runOn(droite, 'ping6 -c 1 2001:db8:2::1')).toMatch(PERDU);
  });

  it('TEMOIN: ce refus ne touche PAS l autre interface', async () => {
    const { sh, gauche } = await laboratoire();

    run(sh, 'config firewall local-in-policy6', 'edit 1',
      'set intf "port2"', 'set srcaddr "all6"', 'set dstaddr "all6"',
      'set service "ALL"', 'set action deny', 'set schedule "always"',
      'next', 'end');

    expect(await runOn(gauche, 'ping6 -c 1 2001:db8:1::1')).toMatch(REUSSI);
  });

  it('un objet adresse v6 nomme restreint le refus', async () => {
    const { sh, gauche, droite } = await laboratoire();

    run(sh, 'config firewall local-in-policy6', 'edit 1',
      'set intf "any"', 'set srcaddr "RESEAU-B6"', 'set dstaddr "all6"',
      'set service "ALL"', 'set action deny', 'set schedule "always"',
      'next', 'end');

    expect(await runOn(droite, 'ping6 -c 1 2001:db8:2::1')).toMatch(PERDU);
    expect(await runOn(gauche, 'ping6 -c 1 2001:db8:1::1')).toMatch(REUSSI);
  });
});

describe('une famille ne juge pas l autre', () => {
  it('une politique local-in v6 ne coupe PAS le ping IPv4', async () => {
    const { sh, droite } = await laboratoire();

    run(sh, 'config firewall local-in-policy6', 'edit 1',
      'set intf "port2"', 'set srcaddr "all6"', 'set dstaddr "all6"',
      'set service "ALL"', 'set action deny', 'set schedule "always"',
      'next', 'end');

    expect(await runOn(droite, 'ping -c 1 192.168.2.1')).toMatch(REUSSI);
  });

  it('une politique local-in v4 ne coupe PAS le ping6', async () => {
    const { sh, droite } = await laboratoire();

    run(sh, 'config firewall local-in-policy', 'edit 1',
      'set intf "port2"', 'set srcaddr "all"', 'set dstaddr "all"',
      'set service "ALL"', 'set action deny', 'set schedule "always"',
      'next', 'end');

    expect(await runOn(droite, 'ping6 -c 1 2001:db8:2::1')).toMatch(REUSSI);
    expect(await runOn(droite, 'ping -c 1 192.168.2.1')).toMatch(PERDU);
  });
});

describe('il n y a PAS de refus implicite au bout de la liste v6', () => {
  it('une politique qui ne correspond a rien laisse passer le reste', async () => {
    const { sh, gauche } = await laboratoire();

    run(sh, 'config firewall local-in-policy6', 'edit 1',
      'set intf "port2"', 'set srcaddr "RESEAU-B6"', 'set dstaddr "all6"',
      'set service "ALL"', 'set action deny', 'set schedule "always"',
      'next', 'end');

    expect(await runOn(gauche, 'ping6 -c 1 2001:db8:1::1')).toMatch(REUSSI);
  });

  it('une autorisation placee AVANT le refus l emporte', async () => {
    const { sh, droite } = await laboratoire();

    run(sh, 'config firewall local-in-policy6',
      'edit 1', 'set intf "port2"', 'set srcaddr "RESEAU-B6"',
      'set dstaddr "all6"', 'set service "ALL"',
      'set action accept', 'set schedule "always"', 'next',
      'edit 2', 'set intf "port2"', 'set srcaddr "all6"',
      'set dstaddr "all6"', 'set service "ALL"',
      'set action deny', 'set schedule "always"', 'next', 'end');

    expect(await runOn(droite, 'ping6 -c 1 2001:db8:2::1')).toMatch(REUSSI);
  });

  it('une politique desactivee ne decide de rien', async () => {
    const { sh, droite } = await laboratoire();

    run(sh, 'config firewall local-in-policy6', 'edit 1',
      'set intf "port2"', 'set srcaddr "all6"', 'set dstaddr "all6"',
      'set service "ALL"', 'set action deny', 'set schedule "always"',
      'set status disable', 'next', 'end');

    expect(await runOn(droite, 'ping6 -c 1 2001:db8:2::1')).toMatch(REUSSI);
  });
});

describe('la table v6 est celle de la reference', () => {
  it('show firewall local-in-policy6 rend ce qui a ete tape', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall local-in-policy6', 'edit 1',
      'set intf "port2"', 'set srcaddr "RESEAU-B6"', 'set dstaddr "all6"',
      'set service "PING"', 'set action deny', 'set schedule "always"',
      'set comments "bloque le lab B"', 'next', 'end');

    const out = run(sh, 'show firewall local-in-policy6');

    expect(out).toContain('config firewall local-in-policy6');
    expect(out).toContain('set intf "port2"');
    expect(out).toContain('set srcaddr "RESEAU-B6"');
    expect(out).toContain('set comments "bloque le lab B"');
  });

  it('un objet adresse v4 n est pas une source de donnees pour la forme v6', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall local-in-policy6', 'edit 1');
    const refuse = sh.execute('set srcaddr "all"');
    const accepte = sh.execute('set srcaddr "all6"');
    run(sh, 'next', 'end');

    expect(refuse).toMatch(/not found in datasource/);
    expect(accepte).not.toMatch(/not found in datasource/);
  });

  it('ha-mgmt-intf-only n existe que sur la forme v4', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall local-in-policy', 'edit 1');
    const v4 = sh.execute('set ha-mgmt-intf-only enable');
    run(sh, 'abort');
    run(sh, 'config firewall local-in-policy6', 'edit 1');
    const v6 = sh.execute('set ha-mgmt-intf-only enable');
    run(sh, 'abort');

    expect(v4).not.toMatch(/Command fail|Unknown action|unknown/i);
    expect(v6).toMatch(/Command fail|Unknown action|unknown/i);
  });

  it('l action par defaut d une politique v6 est deny', async () => {
    const { sh, droite } = await laboratoire();

    run(sh, 'config firewall local-in-policy6', 'edit 1',
      'set intf "port2"', 'set srcaddr "all6"', 'set dstaddr "all6"',
      'set service "ALL"', 'set schedule "always"', 'next', 'end');

    expect(await runOn(droite, 'ping6 -c 1 2001:db8:2::1')).toMatch(PERDU);
  });
});
