/**
 * `--iflist` decrit les interfaces de la machine, `-e` choisit celle par
 * laquelle la sonde part.
 *
 * Ecrit A L'AVEUGLE. Les deux options etaient refusees comme non
 * implantees, alors que TOUTE la matiere existe : la machine porte ses
 * interfaces, leurs adresses, leurs MTU, leurs adresses de couche lien
 * et sa table de routage, et `ip addr` / `ip route` les rendent deja.
 * Ce qui manquait etait la porte, pas le moteur.
 *
 * ── Ce que `--iflist` rend ──────────────────────────────────────────
 *
 * `output.cc:294` (`print_iflist`) : deux tableaux, chacun sous une
 * banniere d'etoiles, et rien d'autre — la commande sort par `exit(0)`
 * (`nmap.cc:1958`) donc AUCUNE sonde n'est emise, meme si une cible est
 * nommee.
 *
 * Colonnes des interfaces : `DEV (SHORT) IP/MASK TYPE UP MTU MAC`. Le
 * type vaut `ethernet`, `loopback`, `point2point` ou `other`, et la
 * colonne MAC n'est remplie que pour une interface ethernet.
 *
 * Colonnes des routes : `DST/MASK DEV METRIC GATEWAY`, la passerelle
 * restant vide pour une route connectee.
 *
 * La mise en page est celle de `NmapOutputTable::printableTable`
 * (`NmapOutputTable.cc:203`) : chaque colonne a la largeur de sa plus
 * longue cellule, un blanc les separe, et aucun blanc ne traine en fin
 * de ligne. C'est exactement `NMAP_TABLE` du module de tableaux du
 * depot, qui existe deja et que la section `TRACEROUTE` emploie.
 *
 * ── Ce que `-e` decide ──────────────────────────────────────────────
 *
 * `nmap.cc:1074` range le nom du peripherique ; `nmap.cc:1756` en DEDUIT
 * l'adresse source quand `-S` n'en a pas donne, et sort par
 * « I cannot figure out what source address to use for device %s, does
 * it even exist? » quand le peripherique n'existe pas ou n'a pas
 * d'adresse. La sonde part alors PAR CETTE INTERFACE, ce qu'une machine
 * a deux cartes sur le meme segment rend observable : l'adresse de
 * couche lien SOURCE que voit la cible change.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * Mesure : 7 des 9 cas tombent contre l'etat d'avant. Les DEUX qui
 * passent des deux cotes sont nommes plutot que laisses a decouvrir. Le
 * premier est le TEMOIN — le balayage sans `-e`, qui part par
 * l'interface que le routage designe — et son role est de prouver que
 * l'egress ordinaire n'a pas bouge. Le second, « aucune sonde n'est
 * emise », passait avant pour une raison qui ne prouve RIEN : l'option
 * entiere etait refusee, donc rien n'etait balaye de toute facon ; il
 * garde le `exit(0)` maintenant que la commande existe.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const c of commands) last = await d.executeCommand(c);
  return last;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function segment() {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
  const scanner = new LinuxPC('linux-pc', 'SCANNER', 0, 0);
  const cible = new LinuxServer('linux-server', 'CIBLE', 200, 0);
  scanner.powerOn(); cible.powerOn();

  new Cable('c1').connect(scanner.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(scanner.getPort('eth1')!, sw.getPort('FastEthernet0/3')!);
  new Cable('c3').connect(cible.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);

  await taper(scanner,
    'sudo ip addr add 10.0.0.1/24 dev eth0', 'sudo ip link set eth0 up',
    'sudo ip addr add 10.0.0.3/24 dev eth1', 'sudo ip link set eth1 up');
  await taper(cible, 'sudo ip addr add 10.0.0.2/24 dev eth0', 'sudo ip link set eth0 up',
    'sudo systemctl start ssh');

  return { scanner, cible };
}

/** La ligne du tableau des interfaces qui decrit ce peripherique. */
function ligneInterface(sortie: string, dev: string): string {
  const m = new RegExp(`^${dev} +\\(${dev}\\).*$`, 'm').exec(sortie);
  return m === null ? '<absente>' : m[0];
}

/** Les adresses de couche lien SOURCE des sondes vues par la cible. */
function sourcesLien(capture: string): string[] {
  return [...capture.matchAll(/^\S+ (\S+) > \S+, ethertype IPv4/gm)].map((m) => m[1]);
}

describe('--iflist decrit la machine et ne balaye rien', () => {
  it('les deux bannieres et les deux en-tetes sont la', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap --iflist');

    expect(sortie).not.toContain('not implemented');
    expect(sortie).toContain(
      '************************INTERFACES************************');
    expect(sortie).toContain(
      '**************************ROUTES**************************');
    expect(sortie).toMatch(/^DEV +\(SHORT\) +IP\/MASK +TYPE +UP +MTU +MAC$/m);
    expect(sortie).toMatch(/^DST\/MASK +DEV +METRIC +GATEWAY$/m);
  });

  it('une carte ethernet porte son adresse, son type et sa MAC', async () => {
    const { scanner } = await segment();

    const ligne = ligneInterface(await taper(scanner, 'nmap --iflist'), 'eth0');

    expect(ligne).toContain('10.0.0.1/24');
    expect(ligne).toContain('ethernet');
    expect(ligne).toContain('up');
    expect(ligne).toContain('1500');
    expect(ligne).toMatch(/([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
  });

  it('la boucle vient en tete, typee loopback et sans MAC', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap --iflist');
    const ligne = ligneInterface(sortie, 'lo');

    expect(sortie.split('\n')[1]).toMatch(/^DEV/);
    expect(sortie.split('\n')[2]).toMatch(/^lo /);

    expect(ligne).toContain('127.0.0.1/8');
    expect(ligne).toContain('loopback');
    expect(ligne).not.toMatch(/([0-9A-F]{2}:){5}[0-9A-F]{2}/);
  });

  it('la table des routes rend le reseau connecte', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap --iflist');

    expect(sortie).toMatch(/^10\.0\.0\.0\/24 +eth0 +\d+$/m);
  });

  it('aucune sonde n est emise, meme avec une cible', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'tcpdump -nn -i eth0 tcp -w iflist.pcap &');

    const sortie = await taper(scanner, 'nmap --iflist -p 22 10.0.0.2');
    const capture = await taper(cible, 'tcpdump -r iflist.pcap -nn');

    expect(sortie).not.toContain('Nmap scan report');
    expect(capture).toContain('0 packets captured');
  });
});

describe('-e choisit l interface d emission', () => {
  it('la sonde part par la carte nommee', async () => {
    const { scanner, cible } = await segment();
    const macEth1 = scanner.getPort('eth1')!.getMAC().toString();
    await taper(cible, 'tcpdump -e -nn -i eth0 tcp port 22 -w choix.pcap &');

    const rapport = await taper(scanner, 'nmap -Pn -sS -e eth1 -p 22 10.0.0.2');
    const capture = await taper(cible, 'tcpdump -r choix.pcap -nn -e');

    expect(rapport).not.toContain('not implemented');
    expect(rapport).toMatch(/22\/tcp\s+open\s+ssh/);
    expect(sourcesLien(capture)).toContain(macEth1.toLowerCase());
  });

  it('un peripherique inconnu est un refus qui le nomme', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS -e zorglub -p 22 10.0.0.2');

    expect(sortie).toContain('I cannot figure out what source address to use'
      + ' for device zorglub, does it even exist?');
    expect(sortie).not.toContain('Nmap scan report');
  });

  it('une carte sans adresse est refusee de la meme facon', async () => {
    const { scanner } = await segment();
    await taper(scanner, 'sudo ip addr del 10.0.0.3/24 dev eth1');

    const sortie = await taper(scanner, 'nmap -Pn -sS -e eth1 -p 22 10.0.0.2');

    expect(sortie).toContain('does it even exist?');
    expect(sortie).not.toContain('Nmap scan report');
  });
});

describe('TEMOIN', () => {
  it('sans -e, la sonde part par l interface que le routage designe', async () => {
    const { scanner, cible } = await segment();
    const macEth0 = scanner.getPort('eth0')!.getMAC().toString();
    await taper(cible, 'tcpdump -e -nn -i eth0 tcp port 22 -w defaut.pcap &');

    await taper(scanner, 'nmap -Pn -sS -p 22 10.0.0.2');
    const capture = await taper(cible, 'tcpdump -r defaut.pcap -nn -e');

    expect(sourcesLien(capture)).toContain(macEth0.toLowerCase());
  });
});
