/**
 * `--traceroute` releve le chemin, et une cible du MEME segment n'emet
 * aucune sonde.
 *
 * Ecrit A L'AVEUGLE. L'option etait dans la famille « connue de nmap,
 * non implantee ici » : refusee en nommant le simulateur. Elle est
 * desormais reelle, et la marche par duree de vie limitee est celle de
 * la machine — `executeTraceroute`, deja seul emetteur de paquets a TTL
 * decroissant du depot. Ce que `nmap` ajoute est le CHOIX de la sonde,
 * le repli des sauts partages et la mise en page, pas une seconde
 * implantation.
 *
 * ── Ce que le depot de nmap dit, et qui ne se devine pas ────────────
 *
 * (1) `traceroute()` (`traceroute.cc:1547`) separe les cibles
 * DIRECTEMENT CONNECTEES des autres, et `traceroute_direct`
 * (`traceroute.cc:1461`) « send[s] no probes at all, only fill[s] in a
 * TracerouteHop structure » : distance connue de 1, un seul saut, et
 * comme il n'y a pas de sonde le `traceroute_probespec` reste `PS_NONE`
 * — l'en-tete est alors `TRACEROUTE` tout court, sans port ni protocole
 * (`output.cc:2277`).
 *
 * (2) L'en-tete nomme la sonde qui a fait REPONDRE l'hote
 * (`get_probe`, `traceroute.cc:533`, qui lit `target->pingprobe`), et
 * `pingprobe_score` (`scan_engine.cc:1755`) explique un classement
 * contre-intuitif : un RST de port FERME vaut 60, un echo ICMP 50, un
 * SYN/ACK de port OUVERT 30. Plus la reponse est difficile a
 * contrefaire, plus elle est sure. Donc un hote qui repond au ping ET
 * porte un port ouvert fait ecrire `using proto 1/icmp`, et le meme
 * hote balaye sur un port FERME fait ecrire `using port N/tcp`.
 *
 * (3) Sans aucune sonde ayant repondu — `-Pn` et rien d'ouvert —
 * l'echo ICMP est SUPPOSE, « as the most likely to get a response ».
 *
 * (4) Deux cibles derriere le meme routeur partagent leurs premiers
 * sauts : le cache de sauts les etiquette de la premiere cible qui les
 * a trouves, et la seconde ecrit `Hops 1-N are the same as for <ip>`
 * (`output.cc:2290`) sur une ligne dont la largeur ne compte PAS dans
 * celle de la colonne — le `fullrow` de `NmapOutputTable`.
 *
 * (5) La section vient APRES la table des ports et l'identification du
 * service (`nmap.cc:2345`), et un hote sans aucun saut n'en a pas du
 * tout (`output.cc:2255`).
 *
 * ── Ce qui n'est PAS fait, et c'est un choix ────────────────────────
 *
 * `nmap` exige les privileges pour `--traceroute` (`nmap.cc:1590`), et
 * `-A` ne l'active que « if (o.isr00t) ». Ce simulateur ne modelise ce
 * partage pour AUCUNE option — `-sS`, `-sU` et `-O` y fonctionnent sans
 * `sudo` — donc `--traceroute` suit ses soeurs. Poser la garde sur elle
 * seule ne serait pas de la fidelite, ce serait une incoherence de plus.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * TREIZE cas sur quinze tombent contre l'etat d'avant. Les deux autres
 * sont nommes : le TEMOIN, dont c'est le role de passer des deux cotes,
 * et « `-n` la coupe », qui passait pour une raison qui ne prouve rien
 * — il n'y avait aucune section, donc aucun nom a couper.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const c of commands) last = await d.executeCommand(c);
  return last;
}

const M24 = new SubnetMask('255.255.255.0');

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

/**
 * SCANNER 10.0.1.2 — R1 10.0.1.1/10.0.2.1 — R2 10.0.2.2/10.0.3.1 —
 * CIBLE 10.0.3.2 et AUTRE 10.0.3.3, plus VOISIN 10.0.1.3 sur le segment
 * du scanner.
 */
async function chaine() {
  const scanner = new LinuxPC('linux-pc', 'SCANNER', 0, 0);
  const voisin = new LinuxServer('linux-server', 'VOISIN', 0, 100);
  const cible = new LinuxServer('linux-server', 'CIBLE', 400, 0);
  const autre = new LinuxServer('linux-server', 'AUTRE', 400, 100);
  const r1 = new CiscoRouter('R1', 150, 0);
  const r2 = new CiscoRouter('R2', 300, 0);
  scanner.powerOn(); voisin.powerOn(); cible.powerOn(); autre.powerOn();

  r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), M24);
  r1.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), M24);
  r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.2.2'), M24);
  r2.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.3.1'), M24);
  r1.addStaticRoute(new IPAddress('10.0.3.0'), M24, new IPAddress('10.0.2.2'));
  r2.addStaticRoute(new IPAddress('10.0.1.0'), M24, new IPAddress('10.0.2.1'));

  const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 8, 75, 0);
  const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 8, 350, 0);
  new Cable('c1').connect(scanner.getPort('eth0')!, sw1.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(voisin.getPort('eth0')!, sw1.getPort('FastEthernet0/2')!);
  new Cable('c3').connect(sw1.getPort('FastEthernet0/3')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('c4').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('c5').connect(r2.getPort('GigabitEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);
  new Cable('c6').connect(cible.getPort('eth0')!, sw2.getPort('FastEthernet0/2')!);
  new Cable('c7').connect(autre.getPort('eth0')!, sw2.getPort('FastEthernet0/3')!);

  await taper(scanner, 'ip link set eth0 up', 'ip addr add 10.0.1.2/24 dev eth0',
    'ip route add default via 10.0.1.1');
  await taper(cible, 'ip link set eth0 up', 'ip addr add 10.0.3.2/24 dev eth0',
    'ip route add default via 10.0.3.1', 'sudo systemctl start ssh');
  await taper(voisin, 'ip link set eth0 up', 'ip addr add 10.0.1.3/24 dev eth0',
    'sudo systemctl start ssh');
  await taper(autre, 'ip link set eth0 up', 'ip addr add 10.0.3.3/24 dev eth0',
    'ip route add default via 10.0.3.1', 'sudo systemctl start ssh');

  return { scanner, voisin, cible, autre, r1, r2 };
}

async function segmentSeul() {
  const { scanner, voisin } = await chaine();
  return { scanner, voisin };
}

function bloc(sortie: string): string[] {
  const lines = sortie.split('\n');
  const i = lines.findIndex((l) => l.startsWith('TRACEROUTE'));
  if (i < 0) return [];
  const out: string[] = [];
  for (let k = i; k < lines.length && lines[k] !== ''; k++) out.push(lines[k]);
  return out;
}

describe('une cible distante se trace pour de vrai', () => {
  it('les trois sauts paraissent, dans l ordre', async () => {
    const { scanner, voisin, cible } = await chaine();
    void voisin; void cible;

    const sortie = await taper(scanner, 'nmap --traceroute -n -p 22 10.0.3.2');

    const t = bloc(sortie);
    expect(t[1]).toMatch(/^HOP RTT +ADDRESS$/);
    expect(t[2]).toMatch(/^1\s+\S+ ms\s+10\.0\.1\.1$/);
    expect(t[3]).toMatch(/^2\s+\S+ ms\s+10\.0\.2\.2$/);
    expect(t[4]).toMatch(/^3\s+\S+ ms\s+10\.0\.3\.2$/);
    expect(t).toHaveLength(5);
  });

  it('des paquets a duree de vie limitee partent VRAIMENT', async () => {
    const { scanner } = await chaine();
    await taper(scanner, 'sudo tcpdump -i eth0 -w /tmp/tr.pcap &');

    await taper(scanner, 'nmap --traceroute -n -Pn -p 22 10.0.3.2');

    const vu = await taper(scanner, 'sudo tcpdump -r /tmp/tr.pcap -nn');
    expect(vu).toContain('10.0.1.1 > 10.0.1.2: ICMP time exceeded');
    expect(vu).toContain('10.0.2.2 > 10.0.1.2: ICMP time exceeded');
  });

  it('la section vient APRES la table des ports', async () => {
    const { scanner } = await chaine();

    const sortie = await taper(scanner, 'nmap --traceroute -n -p 22 10.0.3.2');

    expect(sortie.indexOf('22/tcp')).toBeGreaterThan(0);
    expect(sortie.indexOf('TRACEROUTE')).toBeGreaterThan(sortie.indexOf('22/tcp'));
  });
});

describe('l en-tete nomme la sonde qui a fait repondre l hote', () => {
  it('un hote qui repond au ping fait ecrire le protocole ICMP', async () => {
    const { scanner } = await chaine();

    const sortie = await taper(scanner, 'nmap --traceroute -n -p 22 10.0.3.2');

    expect(sortie).toContain('TRACEROUTE (using proto 1/icmp)');
  });

  it('un port FERME l emporte sur l echo, parce qu un RST se contrefait mal', async () => {
    const { scanner } = await chaine();

    const sortie = await taper(scanner, 'nmap --traceroute -n -p 8888 10.0.3.2');

    expect(sortie).toContain('TRACEROUTE (using port 8888/tcp)');
  });

  it('sans aucune sonde ayant repondu, l echo ICMP est suppose', async () => {
    const { scanner } = await chaine();

    const sortie = await taper(scanner, 'nmap --traceroute -n -Pn -sn 10.0.3.2');

    expect(sortie).toContain('TRACEROUTE (using proto 1/icmp)');
  });
});

describe('une cible du MEME segment n emet aucune sonde', () => {
  it('l en-tete est nu et le saut unique', async () => {
    const { scanner } = await segmentSeul();

    const sortie = await taper(scanner, 'nmap --traceroute -n -p 22 10.0.1.3');

    const t = bloc(sortie);
    expect(t[0]).toBe('TRACEROUTE');
    expect(t[1]).toMatch(/^HOP RTT +ADDRESS$/);
    expect(t[2]).toMatch(/^1\s+\S+ ms\s+10\.0\.1\.3$/);
    expect(t).toHaveLength(3);
  });

  it('aucune trame de plus ne part a cause de la trace', async () => {
    const { scanner } = await segmentSeul();
    let sans = 0;
    const stop1 = scanner.getBus().subscribe('port.frame.tx-requested', () => { sans++; });
    await taper(scanner, 'nmap -n -p 22 10.0.1.3');
    stop1();

    let avec = 0;
    const stop2 = scanner.getBus().subscribe('port.frame.tx-requested', () => { avec++; });
    await taper(scanner, 'nmap --traceroute -n -p 22 10.0.1.3');
    stop2();

    expect(avec).toBe(sans);
  });
});

describe('deux cibles derriere le meme routeur replient leurs sauts', () => {
  it('la seconde renvoie a la premiere', async () => {
    const { scanner } = await chaine();

    const sortie = await taper(scanner, 'nmap --traceroute -n -p 22 10.0.3.2 10.0.3.3');

    expect(sortie).toContain('Hops 1-2 are the same as for 10.0.3.2');
    expect(sortie).toMatch(/-\s+Hops 1-2 are the same as for 10\.0\.3\.2/);
  });

  it('la ligne repliee n elargit pas la colonne des temps', async () => {
    const { scanner } = await chaine();

    const sortie = await taper(scanner, 'nmap --traceroute -n -p 22 10.0.3.2 10.0.3.3');

    const entetes = sortie.split('\n').filter((l) => l.startsWith('HOP '));
    expect(entetes).toHaveLength(2);
    expect(entetes[1]).toBe(entetes[0]);
    expect(entetes[1]).toMatch(/^HOP RTT {2,6}ADDRESS$/);
  });
});

describe('la resolution inverse nomme les sauts', () => {
  it('un saut connu du fichier hosts sort `nom (adresse)`', async () => {
    const { scanner } = await chaine();
    await taper(scanner, 'sudo sh -c "echo 10.0.1.1 passerelle >> /etc/hosts"');

    const sortie = await taper(scanner, 'nmap --traceroute -p 22 10.0.3.2');

    expect(sortie).toContain('passerelle (10.0.1.1)');
  });

  it('`-n` la coupe', async () => {
    const { scanner } = await chaine();
    await taper(scanner, 'sudo sh -c "echo 10.0.1.1 passerelle >> /etc/hosts"');

    const sortie = await taper(scanner, 'nmap --traceroute -n -p 22 10.0.3.2');

    expect(sortie).not.toContain('passerelle');
  });
});

describe('les portes de l option', () => {
  it('`--traceroute` n est plus refusee', async () => {
    const { scanner } = await chaine();

    const sortie = await taper(scanner, 'nmap --traceroute -n -p 22 10.0.3.2');

    expect(sortie).not.toContain('not implemented');
  });

  it('`-A` l active, comme sur une machine privilegiee', async () => {
    const { scanner } = await chaine();

    const sortie = await taper(scanner, 'nmap -A -n -p 22 10.0.3.2');

    expect(sortie).toContain('TRACEROUTE');
  });

  it('TEMOIN: sans l option, aucune section', async () => {
    const { scanner } = await chaine();

    const sortie = await taper(scanner, 'nmap -n -p 22 10.0.3.2');

    expect(sortie).not.toContain('TRACEROUTE');
  });
});
