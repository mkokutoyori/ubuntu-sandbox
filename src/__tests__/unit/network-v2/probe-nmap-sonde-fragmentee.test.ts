/**
 * `-f`, `-ff` et `--mtu` decoupent la sonde, et la cible la RECOLLE.
 *
 * Ecrit A L'AVEUGLE. C'est l'option d'evasion la plus ancienne de nmap et
 * la seule qui exerce un mecanisme que ce depot porte deja des deux
 * cotes : `fragmentIPv4` (RFC 791 §3.2) et `IPv4Reassembler`, jusqu'ici
 * employes par le seul ACHEMINEMENT — un routeur qui passe sur un lien
 * plus etroit. Ici c'est l'EMETTEUR qui decoupe deliberement, et l'hote
 * de destination qui recolle : `EndHost.handleIPv4` reassemble avant de
 * filtrer et de distribuer.
 *
 * ── Ce que valent les trois formes ──────────────────────────────────
 *
 * `nmap.cc:1082` : `-f` fait `o.fragscan += 8`, la forme longue `--ff`
 * `+= 16` (`nmap.cc:961`), et `--mtu N` POSE la valeur, refusant ce qui
 * n'est pas un multiple de 8 strictement positif — `fatal("Data payload
 * MTU must be >0 and multiple of 8")`. Ce n'est pas un caprice : le
 * champ « fragment offset » de l'en-tete IPv4 compte par HUIT octets, si
 * bien qu'un decoupage a une autre granularite ne serait pas
 * representable.
 *
 * `NmapOps.h:253` dit ce que la valeur MESURE : « 0 or MTU (without IPv4
 * header size) », donc la charge utile SEULE. Un `-f` decoupe une sonde
 * SYN — vingt octets d'en-tete TCP sans donnee — en TROIS fragments de
 * 8, 8 et 4 octets.
 *
 * ── DF est CLAIR sur une sonde de nmap ──────────────────────────────
 *
 * `scan_engine_raw.cc:1075` passe `false` a l'argument `df` de
 * `build_tcp_raw`, et `tcpip.cc:387` ne fragmente que
 * `!(ntohs(ip->ip_off) & IP_DF)`. Un datagramme qui interdit la
 * fragmentation et qu'on fragmente serait une contradiction : demander
 * `-f` CLAIRE donc le bit. Ce simulateur pose DF sur tout segment TCP
 * (decouverte de MTU de chemin), ce qui est juste pour une CONNEXION et
 * ne l'est pas pour une sonde apatride.
 *
 * ── La charge deja assez petite ─────────────────────────────────────
 *
 * `send_frag_ip_packet` (`libnetutil/netutil.cc:2748`) avertit
 * — « Warning: fragmentation (mtu=%lu) requested but the payload is too
 * small already (%lu) » — et emet le paquet ENTIER. C'est le cas de
 * `--mtu 24` face aux vingt octets d'un SYN.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * Attendue : les cas qui tapent `-f`, `-ff` ou `--mtu` tombent contre
 * l'etat d'avant, ou les trois sont refusees avant tout balayage. Le
 * TEMOIN — un balayage sans option, dont la capture montre UN segment —
 * doit passer des deux cotes.
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

function etatDuPort(sortie: string, port: number): string | null {
  const m = new RegExp(`^${port}/(?:tcp|udp)\\s+(\\S+)`, 'm').exec(sortie);
  return m ? m[1] : null;
}

/**
 * Les paquets IPv4 emis AVANT la premiere reponse, c'est-a-dire la sonde
 * elle-meme. Un balayage SYN en emet un SECOND apres coup — le RST que la
 * pile envoie au SYN/ACK d'une socket qu'elle n'a pas ouverte, ce qu'un
 * vrai `-sS` provoque aussi — donc compter toutes les lignes `SENT`
 * melangerait la sonde et sa consequence.
 */
function envoisDeLaSonde(sortie: string): string[] {
  const lignes = sortie.split('\n');
  const premiereReponse = lignes.findIndex((l) => /^RCVD \([^)]+\) (TCP|UDP|ICMP)/.test(l));
  const avant = premiereReponse < 0 ? lignes : lignes.slice(0, premiereReponse);
  return avant.filter((l) => /^SENT \(/.test(l) && l.includes(' IP ['));
}

describe('la sonde se decoupe et la cible la recolle', () => {
  it('sans option, un seul paquet part et le port est ouvert', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner,
      'nmap -Pn -sS --packet-trace -p 22 10.0.0.2');

    expect(envoisDeLaSonde(sortie)).toHaveLength(1);
    expect(etatDuPort(sortie, 22)).toBe('open');
  });

  it('-f decoupe les vingt octets du SYN en trois fragments', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS -f --packet-trace -p 22 10.0.0.2');

    expect(sortie).not.toContain('not implemented');
    expect(envoisDeLaSonde(sortie)).toHaveLength(3);
    expect(etatDuPort(sortie, 22)).toBe('open');
  });

  it('les fragments portent leur decalage et le drapeau MF, sauf le dernier', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS -f --packet-trace -p 22 10.0.0.2');
    const lignes = envoisDeLaSonde(sortie);

    expect(lignes[0]).toContain('frag offset=0+');
    expect(lignes[1]).toContain('frag offset=8+');
    expect(lignes[2]).toContain('frag offset=16');
    expect(lignes[2]).not.toContain('frag offset=16+');
  });

  it('-ff decoupe plus large : deux fragments de seize et quatre', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS -ff --packet-trace -p 22 10.0.0.2');

    expect(envoisDeLaSonde(sortie)).toHaveLength(2);
    expect(envoisDeLaSonde(sortie)[1]).toContain('frag offset=16');
  });

  it('--mtu 8 fait la meme chose que -f', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner,
      'nmap -Pn -sS --mtu 8 --packet-trace -p 22 10.0.0.2');

    expect(envoisDeLaSonde(sortie)).toHaveLength(3);
  });
});

describe('la cible voit passer des fragments, pas un segment', () => {
  it('tcpdump sur la cible compte trois paquets pour une sonde', async () => {
    const { scanner, cible } = await segment();

    await taper(cible, 'tcpdump -nn -i eth0 -w frag.pcap &');
    await taper(scanner, 'nmap -Pn -sS -f -p 22 10.0.0.2');
    const capture = await taper(cible, 'tcpdump -r frag.pcap -nn -v');

    // Les trois fragments d'une meme sonde partagent son identifiant.
    const fragments = capture.split('\n').filter((l) => / id 1, offset /.test(l));
    expect(fragments).toHaveLength(3);
    // `-f` CLAIRE le bit DF, qu'un datagramme fragmente ne peut porter,
    // et pose « more fragments » sur tout sauf le dernier.
    expect(fragments[0]).toContain('offset 0, flags [+]');
    expect(fragments[1]).toContain('offset 8, flags [+]');
    expect(fragments[2]).toContain('offset 16, flags [none]');
    // Un fragment reste `proto TCP (6)` : le nom vient du NUMERO de
    // l'en-tete IP et non de ce que la capture a su decoder.
    for (const f of fragments) expect(f).toContain('proto TCP (6)');
    // `print-ip.c:506` : hors du premier fragment il n'y a pas d'en-tete
    // de transport a lire, donc pas de ports ni de drapeaux a annoncer.
    expect(capture).toContain('10.0.0.1 > 10.0.0.2: ip-proto-6');
  });
});

describe('ce que la commande refuse et ce dont elle avertit', () => {
  it('une MTU qui n est pas un multiple de 8 est refusee', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS --mtu 10 -p 22 10.0.0.2');

    expect(sortie).toContain('Data payload MTU must be >0 and multiple of 8');
    expect(sortie).not.toContain('Nmap scan report');
  });

  it('une MTU nulle est refusee', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS --mtu 0 -p 22 10.0.0.2');

    expect(sortie).toContain('Data payload MTU must be >0 and multiple of 8');
  });

  it('une charge deja plus petite que la MTU est signalee et part entiere', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner,
      'nmap -Pn -sS --mtu 24 --packet-trace -p 22 10.0.0.2');

    expect(sortie).toContain(
      'Warning: fragmentation (mtu=24) requested but the payload is too small already (20)');
    expect(envoisDeLaSonde(sortie)).toHaveLength(1);
    expect(etatDuPort(sortie, 22)).toBe('open');
  });

  it('un balayage CONNECTE avertit et ne decoupe rien', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sT -f -p 22 10.0.0.2');

    expect(sortie).toContain(
      'You have specified some options that require raw socket access.');
    expect(etatDuPort(sortie, 22)).toBe('open');
  });
});
