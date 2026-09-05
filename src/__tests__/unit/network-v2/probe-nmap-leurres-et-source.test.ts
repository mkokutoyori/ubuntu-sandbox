/**
 * `-D` seme de VRAIES trames depuis des sources forgees, `-S` forge la
 * seule qu'il emet.
 *
 * Ecrit A L'AVEUGLE. Les deux options ne valent que si les paquets
 * partent pour de bon : un leurre qui ne quitterait pas la machine ne
 * cacherait rien, et une adresse source forgee qui ne serait pas sur le
 * fil n'empecherait aucune reponse de revenir. L'observable est donc la
 * CAPTURE sur la cible, pas le rapport.
 *
 * ── Ce que `-D` compose ─────────────────────────────────────────────
 *
 * `nmap.cc:1773` lit une liste separee par des virgules. `ME`
 * (insensible a la casse) marque la place de la VRAIE source et ne peut
 * paraitre qu'une fois — « Can only use 'ME' as a decoy once. » ; sans
 * lui, nmap l'INSERE a une place tiree au hasard (`nmap.cc:1826`).
 * `RND` / `RND:n` tire n adresses IPv4 qui ne soient pas RESERVEES, la
 * liste des blocs venant du registre IANA des adresses a usage special
 * (`libnetutil/netutil.cc:485`). Un nom qui ne se resout pas est un
 * refus, et la liste est bornee a 128 (`nmap.h:160`).
 *
 * `scan_engine_raw.cc:1218` : la boucle d'emission construit UNE sonde
 * par entree, chacune avec SA source, et seule celle de rang
 * `decoyturn` est suivie. C'est ce qui fait qu'un balayage a leurres
 * garde un resultat JUSTE tout en noyant l'origine.
 *
 * ── Ce que `-S` compose ─────────────────────────────────────────────
 *
 * `nmap.cc:1288` : une seule fois, sinon « You can only use the source
 * option once!  Use -D <decoy1> -D <decoy2> etc. for decoys ». La
 * consequence est celle qu'un apprenant doit voir : le port se lit
 * `filtered` alors que la cible a bel et bien traite la sonde.
 *
 * MESURE, contre l'ecriture a l'aveugle : la cible n'emet PAS le SYN/ACK
 * qu'on attendait. Elle doit d'abord resoudre 10.0.0.99, personne ne
 * repond, et la reponse ne quitte jamais la machine — ce qu'un vrai
 * Linux fait aussi, une entree de voisinage ne se resolvant pas. La
 * preuve qu'elle a repondu AILLEURS est donc l'ARP `who-has 10.0.0.99`,
 * et c'est la bonne : elle nomme l'adresse vers laquelle elle partait.
 *
 * ── Les deux exigent l'acces brut ───────────────────────────────────
 *
 * `nmap.cc:1054` et `:1292` posent `raw_scan_options`, donc un balayage
 * CONNECTE les accepte, avertit et ne les honore pas.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * Attendue : tous les cas qui tapent `-D` ou `-S` tombent contre l'etat
 * d'avant, ou les deux options sont refusees avant tout balayage. Le
 * TEMOIN — le balayage sans option, dont la capture ne montre qu'une
 * source — doit passer des deux cotes.
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

/** Les SYN vers le port 22 vus par la cible, dans l'ordre, par source. */
function sourcesDesSyn(capture: string): string[] {
  const out: string[] = [];
  for (const ligne of capture.split('\n')) {
    const m = /^(?:\S+\s+)?IP (\d+\.\d+\.\d+\.\d+)\.\d+ > 10\.0\.0\.2\.22: Flags \[S\]/
      .exec(ligne.trim());
    if (m) out.push(m[1]);
  }
  return out;
}

async function captureDuBalayage(commande: string): Promise<{
  sources: string[]; rapport: string;
}> {
  const { scanner, cible } = await segment();
  await taper(cible, 'tcpdump -nn -i eth0 tcp port 22 -w leurres.pcap &');
  const rapport = await taper(scanner, commande);
  const capture = await taper(cible, 'tcpdump -r leurres.pcap -nn');
  return { sources: sourcesDesSyn(capture), rapport };
}

describe('-D met de vraies trames sur le fil depuis des sources forgees', () => {
  it('sans option, la cible ne voit qu une source', async () => {
    const { sources, rapport } = await captureDuBalayage(
      'nmap -Pn -sS -p 22 10.0.0.2');

    expect(sources).toEqual(['10.0.0.1']);
    expect(etatDuPort(rapport, 22)).toBe('open');
  });

  it('ME garde sa place dans la liste, et le port reste juste', async () => {
    const { sources, rapport } = await captureDuBalayage(
      'nmap -Pn -sS -D 10.0.0.7,ME,10.0.0.8 -p 22 10.0.0.2');

    expect(rapport).not.toContain('not implemented');
    expect(sources).toEqual(['10.0.0.7', '10.0.0.1', '10.0.0.8']);
    expect(etatDuPort(rapport, 22)).toBe('open');
  });

  it('sans ME, la vraie source est INSEREE parmi les leurres', async () => {
    const { sources, rapport } = await captureDuBalayage(
      'nmap -Pn -sS -D 10.0.0.7,10.0.0.8 -p 22 10.0.0.2');

    expect(sources).toHaveLength(3);
    expect(sources).toContain('10.0.0.1');
    expect(sources).toContain('10.0.0.7');
    expect(sources).toContain('10.0.0.8');
    expect(etatDuPort(rapport, 22)).toBe('open');
  });

  it('RND:3 tire trois adresses qui ne sont pas reservees', async () => {
    const { sources, rapport } = await captureDuBalayage(
      'nmap -Pn -sS -D RND:3 -p 22 10.0.0.2');

    expect(sources).toHaveLength(4);
    const forgees = sources.filter((s) => s !== '10.0.0.1');
    expect(forgees).toHaveLength(3);
    for (const forgee of forgees) {
      const o = forgee.split('.').map(Number);
      expect(o[0]).not.toBe(0);
      expect(o[0]).not.toBe(10);
      expect(o[0]).not.toBe(127);
      expect(o[0]).toBeLessThan(240);
      expect(`${o[0]}.${o[1]}`).not.toBe('192.168');
      expect(`${o[0]}.${o[1]}`).not.toBe('169.254');
    }
    expect(etatDuPort(rapport, 22)).toBe('open');
  });

  it('ME deux fois est refuse', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS -D ME,10.0.0.7,ME -p 22 10.0.0.2');

    expect(sortie).toContain("Can only use 'ME' as a decoy once.");
    expect(sortie).not.toContain('Nmap scan report');
  });

  it('un leurre qui ne se resout pas est refuse en le nommant', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS -D zorglub -p 22 10.0.0.2');

    expect(sortie).toContain('Failed to resolve decoy host "zorglub"');
    expect(sortie).not.toContain('Nmap scan report');
  });

  it('la liste est bornee a 128', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS -D RND:200 -p 22 10.0.0.2');

    expect(sortie).toContain('You are only allowed 128 decoys');
    expect(sortie).not.toContain('Nmap scan report');
  });
});

describe('-S forge la source, et la reponse ne revient plus', () => {
  it('la sonde part de l adresse forgee et le port se lit filtered', async () => {
    const { sources, rapport } = await captureDuBalayage(
      'nmap -Pn -sS -S 10.0.0.99 -p 22 10.0.0.2');

    expect(rapport).not.toContain('not implemented');
    expect(sources).toEqual(['10.0.0.99']);
    expect(etatDuPort(rapport, 22)).toBe('filtered');
  });

  it('la cible cherche pourtant a repondre, mais ailleurs', async () => {
    const { scanner, cible } = await segment();

    await taper(cible, 'tcpdump -nn -i eth0 -w usurpe.pcap &');
    await taper(scanner, 'nmap -Pn -sS -S 10.0.0.99 -p 22 10.0.0.2');
    const capture = await taper(cible, 'tcpdump -r usurpe.pcap -nn');

    expect(capture).toContain('IP 10.0.0.99.32768 > 10.0.0.2.22: Flags [S]');
    expect(capture).toContain('ARP, Request who-has 10.0.0.99 tell 10.0.0.2');
    expect(capture).not.toMatch(/10\.0\.0\.2\.22 > 10\.0\.0\.1\./);
  });

  it('deux fois est refuse et renvoie vers -D', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner,
      'nmap -Pn -sS -S 10.0.0.99 -S 10.0.0.98 -p 22 10.0.0.2');

    expect(sortie).toContain('You can only use the source option once!'
      + '  Use -D <decoy1> -D <decoy2> etc. for decoys');
    expect(sortie).not.toContain('Nmap scan report');
  });
});

describe('les deux exigent l acces brut', () => {
  it('un balayage CONNECTE avertit et n honore ni -D ni -S', async () => {
    const { sources, rapport } = await captureDuBalayage(
      'nmap -Pn -sT -D 10.0.0.7,ME -p 22 10.0.0.2');

    expect(rapport).toContain(
      'You have specified some options that require raw socket access.');
    expect(sources).toEqual(['10.0.0.1']);
    expect(etatDuPort(rapport, 22)).toBe('open');
  });
});
