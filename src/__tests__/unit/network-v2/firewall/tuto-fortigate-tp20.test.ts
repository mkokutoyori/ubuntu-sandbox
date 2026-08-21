/**
 * TP 20 — un SD-WAN a deux liens, rejoue commande par commande.
 *
 * Ecrit A L'AVEUGLE contre le tutoriel avant toute lecture du code. Onze
 * des quatorze cas tombaient, et les trois qui passaient sont le refus
 * d'une zone inconnue, la declaration de la zone seule, et la relecture
 * de `show system sdwan`.
 *
 * Ce que la mesure a trouve, et qu'aucune de ces commandes n'annoncait :
 *
 *   1. `set zone` sur un membre REFUSAIT la zone declaree trois lignes
 *      plus haut, dans le meme bloc : une table ENFANT n'etait visible
 *      d'aucune resolution de reference, faute d'etre enregistree comme
 *      une table a part entiere.
 *   2. `set server "A" "B"` — la forme documentee par Fortinet — etait
 *      refusee, l'attribut etant declare a valeur unique.
 *   3. `sla_map` etait la CHAINE `0x0`, toujours, y compris pour un
 *      membre qui respectait son contrat. `slaMet()` existait et
 *      n'etait lu par personne. C'est le champ que le tutoriel dit de
 *      lire en premier.
 *   4. `failtime` et `recoverytime` etaient ranges et lus par personne :
 *      un seul tour de sonde suffisait a declarer un membre mort, et un
 *      seul a le ressusciter.
 *   5. Une route statique ne pouvait pas nommer la ZONE, donc la route
 *      par defaut du SD-WAN — l'objet meme de l'etape 6 — etait
 *      impossible a ecrire.
 *   6. La REGLE de service ne pilotait AUCUN paquet : `preferredMember`
 *      n'etait lu que par un afficheur. Le trafic ne changeait jamais de
 *      chemin, ce qui est la seule chose que ce TP promet.
 *
 * Les formats rendus sont ceux de FortiOS, releves sur la documentation
 * Fortinet et non ecrits de memoire : `diagnose sys sdwan member` separe
 * ses champs par DEUX-POINTS (`interface: port1`) la ou la sonde de sante
 * utilise des parentheses, et la vue de service liste TOUS les membres
 * avec `Seq_num(<n> <interface>)`, `sla(0x..)`, `cfg_order(..)` et
 * `selected` sur ceux qui sont retenus — d'ou des verifications sur la
 * PREMIERE ligne, la seule qui dise par ou le trafic part.
 *
 * Le laboratoire mene les deux liens au MEME serveur par une dorsale
 * commune : une bascule qui « marche » parce que le second lien ne mene
 * nulle part ne prouverait rien.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

function propre(sorties: string[]): void {
  for (const s of sorties) {
    expect(s).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
  }
}

const SONDE_A = '100.64.0.10';
const SONDE_B = '100.64.0.11';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const lan = new LinuxPC('linux-pc', 'PC-LAN', -100, 0);
  const fai1 = new CiscoRouter('R1-EDGE', 100, -60);
  const fai2 = new CiscoRouter('R2-EDGE', 100, 60);
  const dorsale = new GenericSwitch('switch-generic', 'DORSALE', 8, 220, 0);
  const cible = new LinuxPC('linux-pc', 'CIBLE', 320, 0);

  const cableA = new Cable('wan-a');
  const cableB = new Cable('wan-b');
  new Cable('lan').connect(lan.getPort('eth0')!, fgt.getPort('port2')!);
  cableA.connect(fgt.getPort('port1')!, fai1.getPort('GigabitEthernet0/0')!);
  cableB.connect(fgt.getPort('port4')!, fai2.getPort('GigabitEthernet0/0')!);
  new Cable('d1').connect(fai1.getPort('GigabitEthernet0/1')!, dorsale.getPort('eth0')!);
  new Cable('d2').connect(fai2.getPort('GigabitEthernet0/1')!, dorsale.getPort('eth1')!);
  new Cable('d3').connect(cible.getPort('eth0')!, dorsale.getPort('eth2')!);

  await taper(fgt, [
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.100.99 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port4"', 'set mode static',
    'set ip 192.168.101.99 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config firewall address',
    'edit "NET-LAN"', 'set subnet 192.168.10.0 255.255.255.0', 'next', 'end',
  ]);

  for (const [routeur, wan, dorsaleIp] of [
    [fai1, '192.168.100.1', '100.64.0.1'],
    [fai2, '192.168.101.1', '100.64.0.2'],
  ] as const) {
    await taper(routeur, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', `ip address ${wan} 255.255.255.0`,
      'no shutdown', 'exit',
      'interface GigabitEthernet0/1', `ip address ${dorsaleIp} 255.255.255.0`,
      'no shutdown', 'exit', 'end',
    ]);
  }

  await taper(lan, [
    'ip link set eth0 up', 'ip addr add 192.168.10.10/24 dev eth0',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(cible, [
    'ip link set eth0 up', `ip addr add ${SONDE_A}/24 dev eth0`,
    `ip addr add ${SONDE_B}/24 dev eth0`,
    'ip route add 192.168.100.0/24 via 100.64.0.1',
    'ip route add 192.168.101.0/24 via 100.64.0.2',
  ]);

  return { fgt, lan, fai1, fai2, cableA, cableB };
}

async function zoneEtMembres(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config system sdwan',
    'set status enable',
    'config zone', 'edit "SDWAN-INTERNET"', 'next', 'end',
    'config members',
    'edit 1', 'set interface "port1"', 'set zone "SDWAN-INTERNET"',
    'set gateway 192.168.100.1', 'set priority 1', 'next',
    'edit 2', 'set interface "port4"', 'set zone "SDWAN-INTERNET"',
    'set gateway 192.168.101.1', 'set priority 2', 'next',
    'end',
    'end',
  ]);
}

async function moniteur(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config system sdwan',
    'config health-check',
    'edit "Qualite"',
    `set server "${SONDE_A}" "${SONDE_B}"`,
    'set protocol ping',
    'set interval 500',
    'set failtime 5',
    'set recoverytime 5',
    'set members 1 2',
    'config sla',
    'edit 1',
    'set latency-threshold 150',
    'set jitter-threshold 30',
    'set packetloss-threshold 2',
    'next', 'end',
    'next', 'end',
    'end',
  ]);
}

async function service(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config system sdwan',
    'config service',
    'edit 1',
    'set name "Trafic-critique"',
    'set mode sla',
    'set dst "all"',
    'set src "NET-LAN"',
    'config sla', 'edit "Qualite"', 'set id 1', 'next', 'end',
    'set priority-members 1 2',
    'next', 'end',
    'end',
  ]);
}

describe('TP 20 — Un SD-WAN a deux liens', () => {
  it('etape 2 : la ZONE se declare et se relit', async () => {
    const { fgt } = await laboratoire();
    propre(await taper(fgt, [
      'config system sdwan', 'set status enable',
      'config zone', 'edit "SDWAN-INTERNET"', 'next', 'end', 'end',
    ]));

    const conf = await fgt.executeCommand('show system sdwan');
    expect(conf).toContain('set status enable');
    expect(conf).toContain('config zone');
    expect(conf).toContain('edit "SDWAN-INTERNET"');
  });

  it('etape 3 : les membres nomment leur zone', async () => {
    const { fgt } = await laboratoire();
    propre(await zoneEtMembres(fgt));

    const conf = await fgt.executeCommand('show system sdwan');
    expect(conf).toContain('set interface "port1"');
    expect(conf).toContain('set zone "SDWAN-INTERNET"');
    expect(conf).toContain('set gateway 192.168.101.1');
  });

  it('etape 3 : une zone NON declaree est refusee sur un membre', async () => {
    const { fgt } = await laboratoire();
    const sorties = await taper(fgt, [
      'config system sdwan', 'set status enable',
      'config members', 'edit 1', 'set interface "port1"',
      'set zone "ZONE-FANTOME"', 'next', 'end', 'end',
    ]);

    expect(sorties.join('\n')).toMatch(/does not exist in `system sdwan zone`/);
  });

  it('etape 4 : le moniteur accepte DEUX serveurs et ses temporisateurs',
    async () => {
      const { fgt } = await laboratoire();
      await zoneEtMembres(fgt);
      propre(await moniteur(fgt));

      const conf = await fgt.executeCommand('show system sdwan');
      expect(conf).toContain(`set server "${SONDE_A}" "${SONDE_B}"`);
      expect(conf).toContain('set interval 500');
      expect(conf).toContain('set failtime 5');
      expect(conf).toContain('set recoverytime 5');
      expect(conf).toContain('set latency-threshold 150');
      expect(conf).toContain('set packetloss-threshold 2');
    });

  it('etape 5 : la mesure rend `sla_map=0x1` quand le contrat est TENU',
    async () => {
      const { fgt } = await laboratoire();
      await zoneEtMembres(fgt);
      await moniteur(fgt);
      await fgt.runSdwanHealthChecks();

      const vue = await fgt.executeCommand('diagnose sys sdwan health-check');
      expect(vue).toContain('Health Check(Qualite):');
      expect(vue).toMatch(/Seq\(1 port1\): state\(alive\)/);
      expect(vue).toMatch(/Seq\(2 port4\): state\(alive\)/);
      expect(vue).toMatch(/Seq\(1 port1\).*sla_map=0x1/);
    });

  it('etape 5 : un lien DEGRADE au-dessus du seuil rend `sla_map=0x0`',
    async () => {
      const { fgt, cableA } = await laboratoire();
      await zoneEtMembres(fgt);
      await moniteur(fgt);
      cableA.setPacketLossRate(0.6);
      await fgt.runSdwanHealthChecks();

      const vue = await fgt.executeCommand('diagnose sys sdwan health-check');
      expect(vue).toMatch(/Seq\(1 port1\).*sla_map=0x0/);
      expect(vue).toMatch(/Seq\(2 port4\).*sla_map=0x1/);
    });

  it('etape 6 : une route statique nomme la ZONE et paraît dans la table',
    async () => {
      const { fgt } = await laboratoire();
      await zoneEtMembres(fgt);
      propre(await taper(fgt, [
        'config router static',
        'edit 1', 'set dst 0.0.0.0 0.0.0.0', 'set device "SDWAN-INTERNET"',
        'next', 'end',
      ]));

      const conf = await fgt.executeCommand('show router static');
      expect(conf).toContain('set device "SDWAN-INTERNET"');

      const table = await fgt.executeCommand('get router info routing-table all');
      expect(table).toMatch(/S\*\s+0\.0\.0\.0\/0 \[10\/0\] via 192\.168\.100\.1, port1/);
      expect(table).not.toMatch(/192\.168\.101\.1, port4/);

      const base = await fgt.executeCommand('get router info routing-table database');
      expect(base).toMatch(/192\.168\.100\.1, port1/);
      expect(base).toMatch(/192\.168\.101\.1, port4.*inactive/);
    });

  it('etape 6 : la route de la ZONE disparait avec la route qui la nommait',
    async () => {
      const { fgt } = await laboratoire();
      await zoneEtMembres(fgt);
      await taper(fgt, [
        'config router static',
        'edit 1', 'set dst 0.0.0.0 0.0.0.0', 'set device "SDWAN-INTERNET"',
        'next', 'end',
      ]);
      expect(await fgt.executeCommand('get router info routing-table all'))
        .toMatch(/0\.0\.0\.0\/0/);

      await taper(fgt, ['config router static', 'delete 1', 'end']);

      expect(await fgt.executeCommand('get router info routing-table all'))
        .not.toMatch(/0\.0\.0\.0\/0/);
    });

  it('etape 7 : la regle de service se declare avec son contrat', async () => {
    const { fgt } = await laboratoire();
    await zoneEtMembres(fgt);
    await moniteur(fgt);
    propre(await service(fgt));

    const conf = await fgt.executeCommand('show system sdwan');
    expect(conf).toContain('set name "Trafic-critique"');
    expect(conf).toContain('set mode sla');
    expect(conf).toContain('set src "NET-LAN"');
    expect(conf).toContain('edit "Qualite"');
    expect(conf).toContain('set priority-members 1 2');
  });

  it('etape 7 : le service choisit le membre de PRIORITE la plus basse',
    async () => {
      const { fgt } = await laboratoire();
      await zoneEtMembres(fgt);
      await moniteur(fgt);
      await service(fgt);
      await fgt.runSdwanHealthChecks();

      const vue = await fgt.executeCommand('diagnose sys sdwan service');
      expect(vue).toContain('Mode(sla), sla-compare-order');
      expect(vue).toContain('Members(2):');
      expect(vue).toMatch(/^ {4}1: Seq_num\(1 port1\), alive, sla\(0x1\).*selected$/m);
      expect(vue).toMatch(/^ {4}2: Seq_num\(2 port4\), alive, sla\(0x1\).*selected$/m);
    });

  it('etape 8 : la DEGRADATION fait basculer le service, lien INTACT',
    async () => {
      const { fgt, cableA } = await laboratoire();
      await zoneEtMembres(fgt);
      await moniteur(fgt);
      await service(fgt);
      await fgt.runSdwanHealthChecks();
      expect(await fgt.executeCommand('diagnose sys sdwan service'))
        .toMatch(/^ {4}1: Seq_num\(1 port1\)/m);

      cableA.setPacketLossRate(0.6);
      await fgt.runSdwanHealthChecks();

      expect(cableA.isConnected()).toBe(true);
      const vue = await fgt.executeCommand('diagnose sys sdwan health-check');
      expect(vue).toMatch(/Seq\(1 port1\): state\(alive\)/);

      const service1 = await fgt.executeCommand('diagnose sys sdwan service');
      expect(service1).toMatch(/^ {4}1: Seq_num\(2 port4\).*selected$/m);
      expect(service1).toMatch(/^ {4}2: Seq_num\(1 port1\), alive, sla\(0x0\)/m);
      expect(service1).not.toMatch(/^ {4}2: Seq_num\(1 port1\).*selected$/m);
    });

  it('etape 8 : `recoverytime` retarde le retour, il ne l\'empeche pas',
    async () => {
      const { fgt, fai1, cableA } = await laboratoire();
      await zoneEtMembres(fgt);
      await moniteur(fgt);
      await service(fgt);
      cableA.disconnect();
      await fgt.runSdwanHealthChecks();
      expect(await fgt.executeCommand('diagnose sys sdwan service'))
        .toMatch(/^ {4}1: Seq_num\(2 port4\)/m);

      cableA.connect(fgt.getPort('port1')!, fai1.getPort('GigabitEthernet0/0')!);
      for (let tour = 1; tour < 5; tour++) await fgt.runSdwanHealthChecks();
      expect(await fgt.executeCommand('diagnose sys sdwan health-check'))
        .toMatch(/Seq\(1 port1\): state\(dead\)/);

      await fgt.runSdwanHealthChecks();
      expect(await fgt.executeCommand('diagnose sys sdwan health-check'))
        .toMatch(/Seq\(1 port1\): state\(alive\)/);
      expect(await fgt.executeCommand('diagnose sys sdwan service'))
        .toMatch(/^ {4}1: Seq_num\(1 port1\)/m);
    });

  it('etape 8 : `failtime` retarde la chute, il ne l\'empeche pas', async () => {
    const { fgt, cableA } = await laboratoire();
    await zoneEtMembres(fgt);
    await moniteur(fgt);
    await service(fgt);
    await fgt.runSdwanHealthChecks();
    expect(await fgt.executeCommand('diagnose sys sdwan health-check'))
      .toMatch(/Seq\(1 port1\): state\(alive\)/);

    cableA.disconnect();
    for (let tour = 1; tour < 5; tour++) await fgt.runSdwanHealthChecks();
    expect(await fgt.executeCommand('diagnose sys sdwan health-check'))
      .toMatch(/Seq\(1 port1\): state\(alive\)/);

    await fgt.runSdwanHealthChecks();
    expect(await fgt.executeCommand('diagnose sys sdwan health-check'))
      .toMatch(/Seq\(1 port1\): state\(dead\)/);
  });

  it('etape 8 : le TRAFIC lui-meme change de membre, mesure sur le fil',
    async () => {
      const { fgt, lan, fai1, fai2, cableA } = await laboratoire();
      await zoneEtMembres(fgt);
      await moniteur(fgt);
      await service(fgt);
      await taper(fgt, [
        'config firewall policy',
        'edit 1', 'set srcintf "port2"', 'set dstintf "port1"',
        'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
        'set action accept', 'set nat enable', 'next',
        'edit 2', 'set srcintf "port2"', 'set dstintf "port4"',
        'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
        'set action accept', 'set nat enable', 'next', 'end',
        'config router static',
        'edit 1', 'set dst 0.0.0.0 0.0.0.0', 'set device "SDWAN-INTERNET"',
        'next', 'end',
      ]);
      await fgt.runSdwanHealthChecks();

      const parti = (routeur: CiscoRouter): number =>
        routeur.getPort('GigabitEthernet0/0')!.getCounters().framesIn;

      const avant1 = parti(fai1);
      const avant2 = parti(fai2);
      await lan.executeCommand(`ping -c 2 ${SONDE_A}`);
      expect(parti(fai1)).toBeGreaterThan(avant1);
      expect(parti(fai2)).toBe(avant2);

      cableA.setPacketLossRate(0.6);
      await fgt.runSdwanHealthChecks();

      const pivot1 = parti(fai1);
      const pivot2 = parti(fai2);
      await lan.executeCommand(`ping -c 2 ${SONDE_B}`);
      expect(parti(fai2)).toBeGreaterThan(pivot2);
      expect(parti(fai1)).toBe(pivot1);
    });

  it('la vue des membres est celle de FortiOS, deux-points compris', async () => {
    const { fgt } = await laboratoire();
    await zoneEtMembres(fgt);

    const vue = await fgt.executeCommand('diagnose sys sdwan member');
    expect(vue).toContain(
      'Member(1): interface: port1, gateway: 192.168.100.1, priority: 1');
    expect(vue).toContain(
      'Member(2): interface: port4, gateway: 192.168.101.1, priority: 2');
  });
});
