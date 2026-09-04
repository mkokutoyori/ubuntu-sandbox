/**
 * `--packet-trace` montre les paquets que le balayage MET SUR LE FIL.
 *
 * Ecrit A L'AVEUGLE. L'option etait dans la famille « connue de nmap,
 * non implantee ici ». Elle est la seule qui rende VISIBLE, depuis le
 * terminal de l'apprenant, le fait que ce simulateur emet de vraies
 * trames — ce que les sondes de ce depot ne verifient jusqu'ici qu'en
 * lancant un `tcpdump` a cote.
 *
 * ── Les trois formes, relevees dans le depot de nmap ────────────────
 *
 * (1) **`SENT`/`RCVD` pour un paquet IP** (`tcpip.cc:290`) :
 * `%s (%.4fs) %s`, ou le dernier champ vient d'`ippackethdrinfo`
 * (`libnetutil/packettrace.cc:506`). Au niveau de detail par defaut —
 * `LOW_DETAIL`, celui de `--packet-trace` sans `-d` — la description
 * d'un segment TCP est `TCP [<src>:<sport> > <dst>:<dport> <drapeaux>
 * seq=<n> ack=<n>]`, suivie de ` IP [<ipinfo>]`.
 *
 * (2) **`SENT`/`RCVD` pour une trame ARP** (`tcpip.cc:157`) :
 * `ARP who-has <cible> tell <emetteur>` et
 * `ARP reply <adresse> is-at <MAC>`, la MAC en MAJUSCULES (`%02X`).
 *
 * (3) **`CONN`** (`tcpip.cc:355`) :
 * `CONN (%.4fs) TCP localhost > <ip>:<port> => <errbuf>`, ou `errbuf`
 * vaut `Connected` quand l'appel reussit et le `strerror` de l'errno
 * sinon. C'est la SEULE forme qu'un balayage CONNECTE produit sur une
 * vraie machine : `connect()` laisse le noyau emettre les paquets, donc
 * nmap ne les voit jamais. Ce simulateur, lui, les voit — les rendre
 * ferait ecrire a un balayage `-sT` des lignes qu'aucun vrai nmap
 * n'ecrit.
 *
 * ── Deux details qui ne s'inventent pas ─────────────────────────────
 *
 * **Le bloc IP finit par une ESPACE avant son crochet.** Le format est
 * `"ttl=%d id=%hu iplen=%hu%s %s%s%s"` et les trois derniers champs sont
 * vides tant que l'en-tete ne porte pas d'options : la sortie est donc
 * `IP [ttl=64 id=1234 iplen=44 ]`. La meme chose vaut pour un message
 * ICMP sans champ propre, `(type=11/code=0) ]`.
 *
 * **L'ordre des drapeaux TCP n'est pas celui de `tcpdump`.**
 * `tcpflagsinfo` (`packettrace.cc:451`) traite six combinaisons par un
 * `switch` — `A`, `PA`, `S`, `SA`, `F`, `FA` — puis retombe sur un ordre
 * ecrit S, F, R, P, A, U, E, C. Un SYN+FIN sort donc `SF` la ou
 * `tcpdump` ecrit `FS`, et ce depot rend les deux au meme instant sans
 * qu'aucun des deux soit faux.
 *
 * ── Le niveau de debogage l'allume tout seul ────────────────────────
 *
 * `NmapOps.h:127` : `packetTrace()` rend vrai des que le niveau de
 * debogage atteint 3, meme sans l'option. Ce simulateur n'avait AUCUN
 * niveau de debogage — `-d` etait traite comme un synonyme de `-v` —
 * alors que `nmap.cc:1057` leve les DEUX ensemble, `-dN` les posant a N
 * et chaque `d` supplementaire les montant d'un cran. Sans ce niveau, la
 * definition meme de `packetTrace()` n'aurait pas ete representable.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * Les TREIZE cas tombent contre l'etat d'avant — y compris les deux
 * TEMOINS, l'option etant alors refusee avant tout balayage.
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
  new Cable('c2').connect(cible.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);

  await taper(scanner, 'ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0');
  await taper(cible, 'ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0');
  await taper(cible, 'sudo systemctl start ssh');

  return { sw, scanner, cible };
}

function traces(sortie: string): string[] {
  return sortie.split('\n').filter((l) => /^(SENT|RCVD|CONN) \(/.test(l));
}

describe('un balayage a segments montre ce qu il emet', () => {
  it('le SYN et le SYN/ACK paraissent dans la forme de nmap', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS --packet-trace -p 22 10.0.0.2');

    expect(sortie).toMatch(
      /^SENT \(\d+\.\d{4}s\) TCP \[10\.0\.0\.1:\d+ > 10\.0\.0\.2:22 S seq=\d+\] IP \[ttl=\d+ id=\d+ iplen=\d+ \]$/m);
    expect(sortie).toMatch(
      /^RCVD \(\d+\.\d{4}s\) TCP \[10\.0\.0\.2:22 > 10\.0\.0\.1:\d+ SA seq=\d+ ack=\d+\] IP \[ttl=\d+ id=\d+ iplen=\d+ \]$/m);
  });

  it('les drapeaux suivent l ordre de nmap, pas celui de tcpdump', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner,
      'nmap -Pn --scanflags SYNFIN --packet-trace -p 22 10.0.0.2');

    expect(sortie).toMatch(/> 10\.0\.0\.2:22 SF seq=/);
    expect(sortie).not.toMatch(/> 10\.0\.0\.2:22 FS seq=/);
  });

  it('la trace precede le rapport', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS --packet-trace -p 22 10.0.0.2');

    const premiere = sortie.split('\n').findIndex((l) => /^SENT \(/.test(l));
    const rapport = sortie.split('\n').findIndex((l) => l.startsWith('Nmap scan report'));
    expect(premiere).toBeGreaterThan(0);
    expect(rapport).toBeGreaterThan(premiere);
  });
});

describe('la resolution de couche lien parait aussi', () => {
  it('la demande et la reponse ARP, la MAC en majuscules', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap --packet-trace -p 22 10.0.0.2');

    expect(sortie).toMatch(
      /^SENT \(\d+\.\d{4}s\) ARP who-has 10\.0\.0\.2 tell 10\.0\.0\.1$/m);
    expect(sortie).toMatch(
      /^RCVD \(\d+\.\d{4}s\) ARP reply 10\.0\.0\.2 is-at ([0-9A-F]{2}:){5}[0-9A-F]{2}$/m);
  });
});

describe('un balayage CONNECTE ne montre que ses appels', () => {
  it('un port ouvert rend `Connected`', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sT --packet-trace -p 22 10.0.0.2');

    expect(sortie).toMatch(
      /^CONN \(\d+\.\d{4}s\) TCP localhost > 10\.0\.0\.2:22 => Connected$/m);
  });

  it('un port ferme rend le message de l errno', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sT --packet-trace -p 8888 10.0.0.2');

    expect(sortie).toMatch(
      /^CONN \(\d+\.\d{4}s\) TCP localhost > 10\.0\.0\.2:8888 => Connection refused$/m);
  });

  it('et AUCUNE ligne de segment pour ces sondes', async () => {
    const { scanner } = await segment();

    const connecte = await taper(scanner, 'nmap -Pn -sT --packet-trace -p 22 10.0.0.2');
    const demiOuvert = await taper(scanner, 'nmap -Pn -sS --packet-trace -p 22 10.0.0.2');

    // La decouverte de couche lien, elle, reste visible des deux cotes :
    // c'est `nmap` qui l'emet, pas le noyau.
    expect(traces(connecte).some((l) => l.includes('TCP ['))).toBe(false);
    expect(traces(demiOuvert).some((l) => l.includes('TCP ['))).toBe(true);
  });
});

describe('la decouverte par echo se montre aussi', () => {
  it('la requete et la reponse ICMP', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner,
      'nmap --disable-arp-ping -sn --packet-trace 10.0.0.2');

    expect(sortie).toMatch(
      /^SENT \(\d+\.\d{4}s\) ICMP \[10\.0\.0\.1 > 10\.0\.0\.2 Echo request \(type=8\/code=0\) id=\d+ seq=\d+\] IP \[ttl=\d+ id=\d+ iplen=\d+ \]$/m);
    expect(sortie).toMatch(
      /^RCVD \(\d+\.\d{4}s\) ICMP \[10\.0\.0\.2 > 10\.0\.0\.1 Echo reply \(type=0\/code=0\) id=\d+ seq=\d+\] IP \[ttl=\d+ id=\d+ iplen=\d+ \]$/m);
  });
});

describe('le niveau de debogage l allume tout seul', () => {
  it('`-d3` trace sans que l option soit ecrite', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS -d3 -p 22 10.0.0.2');

    expect(traces(sortie).some((l) => l.includes('TCP ['))).toBe(true);
  });

  it('`-d` seul ne suffit pas, il ne monte que d un cran', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS -d -p 22 10.0.0.2');

    expect(traces(sortie)).toHaveLength(0);
  });

  it('`-ddd` monte de trois crans et suffit', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS -ddd -p 22 10.0.0.2');

    expect(traces(sortie).some((l) => l.includes('TCP ['))).toBe(true);
  });
});

describe('les temoins', () => {
  it('TEMOIN: sans l option, aucune ligne de trace', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS --packet-trace -p 22 10.0.0.2');
    const sans = await taper(scanner, 'nmap -Pn -sS -p 22 10.0.0.2');

    expect(traces(sortie).length).toBeGreaterThan(0);
    expect(traces(sans)).toHaveLength(0);
  });

  it('TEMOIN: le rapport lui-meme ne change pas', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS --packet-trace -p 22 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh/);
    expect(sortie).not.toContain('not implemented');
  });
});
