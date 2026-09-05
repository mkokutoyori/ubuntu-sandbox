/**
 * Une cible se DECRIT, elle ne se nomme pas une par une.
 *
 * Ecrit A L'AVEUGLE. `nmap 192.168.1.0/24` est l'invocation canonique de
 * l'outil, et le simulateur savait deja l'etendre — mais c'est la SEULE
 * forme qu'il connaissait. `10.0.0.1-3`, `10.0.0.2,3`, `10.0.0.*` et
 * `10.0.[0-1].2` repondaient tous « Failed to resolve », c'est-a-dire un
 * diagnostic de DNS pour une expression qui n'a rien a resoudre.
 *
 * ── La grammaire ────────────────────────────────────────────────────
 *
 * `libnetutil/NetBlock.cc:150` (`parse_ipv4_ranges`) : chaque octet
 * satisfait `(\*|#?(-#?)?(,#?(-#?)?)*)`, ou `#` est un entier de 0 a 255.
 * Donc `*` vaut 0-255, une borne gauche absente vaut 0, une borne droite
 * absente vaut 255, et la virgule enumere. Une borne hors [0,255] ou une
 * plage a l'envers est un REFUS de la grammaire — l'expression retombe
 * alors sur la resolution de nom, qui echoue, d'ou le message d'origine.
 *
 * `NetBlock.cc:433` : un masque s'applique APRES, octet par octet, et
 * ELARGIT chaque vecteur de bits — `10.0.0.1-3/24` couvre donc tout
 * 10.0.0.0-255, et non trois adresses.
 *
 * ── D'ou viennent les cibles ────────────────────────────────────────
 *
 * `libnetutil/netutil.cc:3792` : celles de la LIGNE DE COMMANDE d'abord,
 * puis celles du fichier de `-iL`. Le fichier se lit par jetons separes
 * par des blancs — donc plusieurs cibles par ligne — et `#` ouvre un
 * commentaire jusqu'a la fin de la ligne. Deux `-iL` sont un refus
 * (`nmap.cc:933`), et un fichier illisible aussi.
 *
 * `-iR n` tire n adresses IPv4 qui ne soient pas RESERVEES
 * (`NetBlock.cc:304`), en evitant l'ensemble d'exclusion.
 *
 * ── Ce qui est RETIRE ───────────────────────────────────────────────
 *
 * `targets.cc` : `--exclude` decoupe sur les VIRGULES avant d'analyser
 * chaque morceau, ce qui est une verrue reelle — `--exclude 10.0.0.2,3`
 * donne `10.0.0.2` puis `3`, et le second est refuse. `--excludefile`
 * lit le meme format que `-iL`. Une specification invalide est un refus
 * qui la NOMME.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * Mesure : 16 des 20 cas tombent contre l'etat d'avant. Les QUATRE qui
 * passent des deux cotes sont nommes plutot que laisses a decouvrir.
 * Deux sont les TEMOINS — la cible unique et le `/29`, les deux seules
 * formes que le simulateur savait deja etendre — et leur role est de
 * prouver que le laboratoire tient. Les deux autres sont les
 * specifications MALFORMEES (`10.0.0.1-999`, `10.0.0.9-2`) : elles
 * rendaient deja « Failed to resolve », mais parce que RIEN n'etait
 * analyse ; elles le rendent maintenant parce que la grammaire les
 * REFUSE et qu'un refus retombe sur la resolution de nom. Meme texte,
 * autre raison — elles gardent le repli, elles ne prouvent pas la
 * grammaire.
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
  const a = new LinuxServer('linux-server', 'A', 200, 0);
  const b = new LinuxServer('linux-server', 'B', 300, 0);
  scanner.powerOn(); a.powerOn(); b.powerOn();

  new Cable('c1').connect(scanner.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(a.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('c3').connect(b.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);

  await taper(scanner, 'sudo ip addr add 10.0.0.1/24 dev eth0', 'sudo ip link set eth0 up');
  await taper(a, 'sudo ip addr add 10.0.0.2/24 dev eth0', 'sudo ip link set eth0 up');
  await taper(b, 'sudo ip addr add 10.0.0.3/24 dev eth0', 'sudo ip link set eth0 up');

  return { scanner, a, b };
}

/** Le nombre d'adresses que la ligne finale declare avoir balayees. */
function adressesBalayees(rapport: string): number {
  const m = /Nmap done: (\d+) IP address(?:es)? /.exec(rapport);
  return m === null ? -1 : Number(m[1]);
}

function cibles(rapport: string): string[] {
  return [...rapport.matchAll(/Nmap scan report for ([\d.]+)/g)].map((m) => m[1]);
}

describe('un octet se decrit par une plage, une liste ou un joker', () => {
  it('une plage couvre ses deux bornes incluses', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn 10.0.0.1-3');

    expect(sortie).not.toContain('Failed to resolve');
    expect(adressesBalayees(sortie)).toBe(3);
    expect(cibles(sortie)).toEqual(['10.0.0.2', '10.0.0.3']);
  });

  it('une liste enumere, et l ordre reste croissant', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn 10.0.0.3,1,2');

    expect(adressesBalayees(sortie)).toBe(3);
    expect(cibles(sortie)).toEqual(['10.0.0.2', '10.0.0.3']);
  });

  it('un joker vaut 0-255', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn 10.0.0.*');

    expect(adressesBalayees(sortie)).toBe(256);
    expect(cibles(sortie)).toEqual(['10.0.0.2', '10.0.0.3']);
  });

  it('une borne gauche absente vaut 0, une borne droite absente vaut 255', async () => {
    const { scanner } = await segment();

    expect(adressesBalayees(await taper(scanner, 'nmap -sn 10.0.0.-3'))).toBe(4);
    expect(adressesBalayees(await taper(scanner, 'nmap -sn 10.0.0.253-'))).toBe(3);
  });

  it('la plage n est pas reservee au dernier octet', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn 10.0.0-1.2');

    expect(adressesBalayees(sortie)).toBe(2);
    expect(cibles(sortie)).toEqual(['10.0.0.2']);
  });

  it('un masque ELARGIT la plage au lieu de la restreindre', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn 10.0.0.1-3/24');

    expect(adressesBalayees(sortie)).toBe(256);
  });

  it('une borne hors bornes retombe sur la resolution de nom, qui echoue', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn 10.0.0.1-999');

    expect(sortie).toContain('Failed to resolve "10.0.0.1-999".');
    expect(adressesBalayees(sortie)).toBe(0);
  });

  it('une plage a l envers est refusee de la meme facon', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn 10.0.0.9-2');

    expect(sortie).toContain('Failed to resolve "10.0.0.9-2".');
  });
});

describe('les cibles peuvent venir d un fichier', () => {
  it('-iL lit un jeton par blanc et ignore les commentaires', async () => {
    const { scanner } = await segment();
    await taper(scanner,
      'echo "10.0.0.2 10.0.0.3" > cibles.txt',
      'echo "# 10.0.0.9 un commentaire" >> cibles.txt');

    const sortie = await taper(scanner, 'nmap -sn -iL cibles.txt');

    expect(sortie).not.toContain('not implemented');
    expect(adressesBalayees(sortie)).toBe(2);
    expect(cibles(sortie)).toEqual(['10.0.0.2', '10.0.0.3']);
  });

  it('les cibles de la ligne de commande passent AVANT celles du fichier', async () => {
    const { scanner } = await segment();
    await taper(scanner, 'echo "10.0.0.3" > cibles.txt');

    const sortie = await taper(scanner, 'nmap -sn -iL cibles.txt 10.0.0.2');

    expect(adressesBalayees(sortie)).toBe(2);
    expect(cibles(sortie)).toEqual(['10.0.0.2', '10.0.0.3']);
  });

  it('deux fichiers d entree sont un refus', async () => {
    const { scanner } = await segment();
    await taper(scanner, 'echo "10.0.0.2" > cibles.txt');

    const sortie = await taper(scanner, 'nmap -sn -iL cibles.txt -iL cibles.txt');

    expect(sortie).toContain('Only one input filename allowed');
    expect(sortie).not.toContain('Nmap scan report');
  });

  it('un fichier illisible est un refus qui le nomme', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn -iL /absent.txt');

    expect(sortie).toContain('Failed to open input file /absent.txt for reading');
    expect(sortie).not.toContain('Nmap scan report');
  });
});

describe('une cible peut etre RETIREE', () => {
  it('--exclude retire une adresse de la plage', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn --exclude 10.0.0.3 10.0.0.1-3');

    expect(sortie).not.toContain('not implemented');
    expect(adressesBalayees(sortie)).toBe(2);
    expect(cibles(sortie)).toEqual(['10.0.0.2']);
  });

  it('--exclude accepte la meme grammaire que la cible', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn --exclude 10.0.0.2-3 10.0.0.*');

    expect(adressesBalayees(sortie)).toBe(254);
    expect(cibles(sortie)).toEqual([]);
  });

  it('--exclude decoupe sur les virgules AVANT d analyser, verrue comprise', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn --exclude 10.0.0.2,3 10.0.0.1-3');

    expect(sortie).toContain('Invalid address specification: 3');
    expect(sortie).not.toContain('Nmap scan report');
  });

  it('--excludefile lit le meme format que -iL', async () => {
    const { scanner } = await segment();
    await taper(scanner, 'echo "10.0.0.2 # le serveur A" > horsjeu.txt');

    const sortie = await taper(scanner, 'nmap -sn --excludefile horsjeu.txt 10.0.0.1-3');

    expect(adressesBalayees(sortie)).toBe(2);
    expect(cibles(sortie)).toEqual(['10.0.0.3']);
  });
});

describe('-iR tire des adresses au hasard', () => {
  it('il en tire le nombre demande, et aucune n est reservee', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn -iR 3');

    expect(sortie).not.toContain('not implemented');
    expect(adressesBalayees(sortie)).toBe(3);
    expect(sortie).toContain('(0 hosts up)');
    expect(sortie).not.toMatch(/for (10|127|192\.168|172\.(1[6-9]|2\d|3[01])|0)\./);
  });

  it('un nombre qui n en est pas un est un refus', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn -iR zorglub');

    expect(sortie).toContain('ERROR: -iR argument must be the maximum number'
      + ' of random IPs you wish to scan');
    expect(sortie).not.toContain('Nmap scan report');
  });
});

describe('TEMOINS', () => {
  it('une cible unique reste une cible unique', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn 10.0.0.2');

    expect(adressesBalayees(sortie)).toBe(1);
    expect(cibles(sortie)).toEqual(['10.0.0.2']);
  });

  it('un /29 s etend comme avant', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn 10.0.0.0/29');

    expect(adressesBalayees(sortie)).toBe(8);
    expect(cibles(sortie)).toEqual(['10.0.0.2', '10.0.0.3']);
  });
});
