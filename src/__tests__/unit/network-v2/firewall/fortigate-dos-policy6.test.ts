/**
 * `firewall DoS-policy6` mesure une anomalie IPv6, et une famille ne
 * juge pas l'autre.
 *
 * Ecrit A L'AVEUGLE, contre `official_docs/forti-cli-ref-60.txt`
 * p. 193-194. Le lot precedent a livre `DoS-policy` en IPv4 et a
 * DELIBEREMENT laisse la table v6 hors du schema plutot que de
 * l'accepter sans l'evaluer : le chemin IPv6 ne traverse pas le pipeline
 * ou vit l'etage `dos-policy`. C'est ce lot qui pose la porte.
 *
 * La reference decrit la forme v6 avec la MEME structure `config
 * anomaly` que la v4, et les memes noms d'anomalie — seuls changent les
 * objets d'adresse, qui sont ceux de `firewall.address6` / `addrgrp6`,
 * et l'absence d'`ha-mgmt-intf-only`. Ce que la version CHANGE est ce
 * que les noms designent : `icmp_flood` sur une politique v6 compte de
 * l'ICMPv6 — protocole 58 — et non le protocole 1, qu'aucun paquet IPv6
 * ne porte. Se tromper la donnerait une anomalie qui ne se declenche
 * JAMAIS, c'est-a-dire un decor qui passe pour une protection.
 *
 * **Le cas qui compte le plus est celui de la famille**, et il porte
 * dans les deux sens : une politique DoS v4 ne doit pas compter un
 * paquet v6, et une politique DoS v6 ne doit pas compter un paquet v4.
 * Un seul sens ne prouverait rien de l'autre.
 *
 * Les TEMOINS portent egalement dans les deux sens : sans politique une
 * rafale v6 passe entiere, et une anomalie desactivee ou en action
 * `pass` la laisse passer aussi.
 *
 * DEFAUT DU LABORATOIRE, trouve en le mesurant et ecrit ici plutot que
 * tu, parce qu'il apprend quelque chose sur la fonction : le cas « ne
 * vaut que sur l'interface nommee » visait d'abord `port2` sur une
 * maquette a DEUX ports, et il echouait — a juste titre. Un echo est un
 * aller-RETOUR : les reponses de PCB ARRIVENT sur port2, donc une
 * politique DoS posee la les compte, et c'est ce qu'un vrai FortiGate
 * fait puisqu'une politique DoS inspecte ce qui ENTRE par l'interface
 * qu'elle nomme. Sur une maquette a deux ports, « l'autre interface »
 * n'existe donc pas : il faut un troisieme port qui ne porte AUCUN
 * trafic, et c'est pour cette raison que le cas jumeau du lot IPv4
 * passait. Le laboratoire porte desormais `port3`.
 *
 * Discrimination : 4 cas tombent contre l'etat d'avant le lot, et 2 en
 * retirant seulement la porte du plan de donnees IPv6 — les deux qui
 * observent un blocage. Les autres relevent du schema. Les cas qui
 * passent des deux cotes sont les TEMOINS et les deux sens de la
 * separation des familles ; ce dernier passe AUSSI avant le lot, parce
 * qu'une porte v6 inexistante ne compte rien — il garde le correctif
 * contre un exces de zele, il ne prouve pas la fonction.
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
  const pcA = new LinuxPC('linux-pc', 'PCA', 200, 0);
  const pcB = new LinuxPC('linux-pc', 'PCB', 400, 0);
  pcA.powerOn(); pcB.powerOn();

  new Cable('c1').connect(fw.getPort('port1')!, pcA.getPorts()[0]);
  new Cable('c2').connect(fw.getPort('port2')!, pcB.getPorts()[0]);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static', 'set ip 10.1.0.1 255.255.255.0',
    'config ipv6', 'set ip6-address 2001:db8:1::1/64', 'end', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.2.0.1 255.255.255.0',
    'config ipv6', 'set ip6-address 2001:db8:2::1/64', 'end', 'next',
    'edit "port3"', 'set mode static', 'set ip 10.3.0.1 255.255.255.0',
    'config ipv6', 'set ip6-address 2001:db8:3::1/64', 'end', 'next', 'end',
    'config firewall address6',
    'edit "RESEAU-A6"', 'set type ipprefix', 'set ip6 2001:db8:1::/64', 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set srcaddr6 "all6"', 'set dstaddr6 "all6"',
    'set service "ALL"', 'set schedule "always"', 'set action accept', 'next', 'end');

  await runOn(pcA, 'ip link set eth0 up',
    'ip addr add 10.1.0.10/24 dev eth0', 'ip route add default via 10.1.0.1',
    'ip addr add 2001:db8:1::10/64 dev eth0',
    'ip route add default via 2001:db8:1::1');
  await runOn(pcB, 'ip link set eth0 up',
    'ip addr add 10.2.0.10/24 dev eth0', 'ip route add default via 10.2.0.1',
    'ip addr add 2001:db8:2::10/64 dev eth0',
    'ip route add default via 2001:db8:2::1');

  return { fw, sh, pcA, pcB };
}

function anomalieV6(sh: FortiShell, nom: string, seuil: number, action: string): string {
  return run(sh, 'config firewall DoS-policy6', 'edit 1',
    'set interface "port1"', 'set srcaddr "all6"', 'set dstaddr "all6"',
    'set service "ALL"',
    'config anomaly', `edit "${nom}"`,
    'set status enable', `set action ${action}`, `set threshold ${seuil}`,
    'next', 'end', 'next', 'end');
}

const TOUT_PASSE = /, 0% packet loss/;

describe('sans politique DoS v6, la rafale passe entiere', () => {
  it('TEMOIN: deux echos IPv6 traversent', async () => {
    const { pcA } = await laboratoire();

    expect(await runOn(pcA, 'ping6 -c 2 -i 0.2 2001:db8:2::10')).toMatch(TOUT_PASSE);
  });

  it('TEMOIN: deux echos IPv4 traversent', async () => {
    const { pcA } = await laboratoire();

    expect(await runOn(pcA, 'ping -c 2 -i 0.2 10.2.0.10')).toMatch(TOUT_PASSE);
  });
});

describe('un DEBIT IPv6 au-dela du seuil est bloque', () => {
  it('icmp_flood a 1 laisse passer un echo et bloque le suivant', async () => {
    const { sh, pcA } = await laboratoire();
    anomalieV6(sh, 'icmp_flood', 1, 'block');

    const sortie = await runOn(pcA, 'ping6 -c 2 -i 0.2 2001:db8:2::10');

    expect(sortie).toMatch(/2 packets transmitted, 1 received/);
  });

  it('TEMOIN: la meme anomalie DESACTIVEE laisse tout passer', async () => {
    const { sh, pcA } = await laboratoire();
    run(sh, 'config firewall DoS-policy6', 'edit 1',
      'set interface "port1"', 'set srcaddr "all6"', 'set dstaddr "all6"',
      'set service "ALL"',
      'config anomaly', 'edit "icmp_flood"',
      'set status disable', 'set action block', 'set threshold 1',
      'next', 'end', 'next', 'end');

    expect(await runOn(pcA, 'ping6 -c 2 -i 0.2 2001:db8:2::10')).toMatch(TOUT_PASSE);
  });

  it('TEMOIN: l action `pass` laisse passer au-dela du seuil', async () => {
    const { sh, pcA } = await laboratoire();
    anomalieV6(sh, 'icmp_flood', 1, 'pass');

    expect(await runOn(pcA, 'ping6 -c 2 -i 0.2 2001:db8:2::10')).toMatch(TOUT_PASSE);
  });

  it('l anomalie ne vaut que sur l interface nommee', async () => {
    const { sh, pcA } = await laboratoire();
    run(sh, 'config firewall DoS-policy6', 'edit 1',
      'set interface "port3"', 'set srcaddr "all6"', 'set dstaddr "all6"',
      'set service "ALL"',
      'config anomaly', 'edit "icmp_flood"',
      'set status enable', 'set action block', 'set threshold 1',
      'next', 'end', 'next', 'end');

    expect(await runOn(pcA, 'ping6 -c 2 -i 0.2 2001:db8:2::10')).toMatch(TOUT_PASSE);
  });

  it('un objet adresse v6 nomme restreint la politique', async () => {
    const { sh, pcA } = await laboratoire();
    run(sh, 'config firewall DoS-policy6', 'edit 1',
      'set interface "port1"', 'set srcaddr "RESEAU-A6"', 'set dstaddr "all6"',
      'set service "ALL"',
      'config anomaly', 'edit "icmp_flood"',
      'set status enable', 'set action block', 'set threshold 1',
      'next', 'end', 'next', 'end');

    expect(await runOn(pcA, 'ping6 -c 2 -i 0.2 2001:db8:2::10'))
      .toMatch(/2 packets transmitted, 1 received/);
  });
});

describe('une famille ne juge pas l autre', () => {
  it('une politique DoS v6 ne compte PAS un paquet IPv4', async () => {
    const { sh, pcA } = await laboratoire();
    anomalieV6(sh, 'icmp_flood', 1, 'block');

    expect(await runOn(pcA, 'ping -c 2 -i 0.2 10.2.0.10')).toMatch(TOUT_PASSE);
  });

  it('une politique DoS v4 ne compte PAS un paquet IPv6', async () => {
    const { sh, pcA } = await laboratoire();
    run(sh, 'config firewall DoS-policy', 'edit 1',
      'set interface "port1"', 'set srcaddr "all"', 'set dstaddr "all"',
      'set service "ALL"',
      'config anomaly', 'edit "icmp_flood"',
      'set status enable', 'set action block', 'set threshold 1',
      'next', 'end', 'next', 'end');

    expect(await runOn(pcA, 'ping6 -c 2 -i 0.2 2001:db8:2::10')).toMatch(TOUT_PASSE);
    expect(await runOn(pcA, 'ping -c 2 -i 0.2 10.2.0.10'))
      .toMatch(/2 packets transmitted, 1 received/);
  });
});

describe('la table v6 est celle de la reference', () => {
  it('show firewall DoS-policy6 rend ce qui a ete tape', async () => {
    const { sh } = await laboratoire();
    anomalieV6(sh, 'icmp_flood', 1, 'block');

    const out = run(sh, 'show firewall DoS-policy6');

    expect(out).toContain('config firewall DoS-policy6');
    expect(out).toContain('set interface "port1"');
    expect(out).toContain('config anomaly');
    expect(out).toContain('edit "icmp_flood"');
    expect(out).toContain('set threshold 1');
  });

  it('un objet adresse v4 n est pas une source de donnees pour la forme v6', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall DoS-policy6', 'edit 1');
    const refuse = sh.execute('set srcaddr "all"');
    const accepte = sh.execute('set srcaddr "all6"');
    run(sh, 'next', 'end');

    expect(refuse).toMatch(/not found in datasource/);
    expect(accepte).not.toMatch(/not found in datasource/);
  });

  it('un nom d anomalie invente est refuse', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall DoS-policy6', 'edit 1', 'config anomaly');
    const refuse = run(sh, 'edit "zorglub_flood"');

    expect(refuse).toMatch(/Command fail|does not exist/);
  });

  it('ha-mgmt-intf-only n existe pas sur la forme v6', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall DoS-policy6', 'edit 1');
    const refuse = sh.execute('set ha-mgmt-intf-only enable');
    run(sh, 'abort');

    expect(refuse).toMatch(/Command fail|Unknown action|unknown/i);
  });
});
