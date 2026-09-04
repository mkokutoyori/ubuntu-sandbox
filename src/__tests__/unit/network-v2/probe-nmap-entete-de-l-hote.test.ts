/**
 * La ligne d'etat de l'hote dit ce qui a ete MESURE.
 *
 * Ecrit A L'AVEUGLE. `write_host_status` (`output.cc:1453`) tient en six
 * lignes, et ce simulateur en manquait quatre.
 *
 * (1) **La latence est en SECONDES.** `num_to_string_sigdigits(srtt /
 * 1000000.0, 2)` : le compteur interne est en microsecondes, la sortie
 * en secondes, et le nombre porte DEUX chiffres significatifs — pas
 * quatre decimales. Ce simulateur ecrivait `latencyMs.toFixed(4)` suivi
 * d'un `s`, donc il annoncait des MILLISECONDES sous l'etiquette des
 * secondes : un aller-retour de 0,576 ms ressortait `0.5762s latency`,
 * mille fois trop, et c'est le seul chiffre de la sortie qu'un
 * apprenant compare a son `ping`.
 *
 * (2) **`--reason` ajoute ` ttl N`** quand la reponse en portait un
 * (`output.cc:1457`). La valeur existait deja ici — `osFromInitialTtl`
 * la lit pour deviner le systeme — et elle etait jetee juste apres.
 *
 * (3) **Un hote MORT porte sa raison DANS le crochet** :
 * `Nmap scan report for <ip> [host down, received no-response]`
 * (`output.cc:1390`), et `no-response` est le libelle de la table
 * (`portreasons.cc:137`).
 *
 * (4) **La decouverte de couche lien MESURE elle aussi son
 * aller-retour.** Elle rendait un `mac` et rien d'autre, si bien que la
 * latence retombait sur la constante de repli `0.001` — la meme valeur
 * pour toute machine et toute topologie, c'est-a-dire un nombre qui
 * n'est la mesure de rien.
 *
 * ── Ce qui ne se devine pas ────────────────────────────────────────
 *
 * `num_to_string_sigdigits` ARRONDIT a la puissance de dix puis remet
 * l'echelle, et le nombre de decimales imprimees vient de cette meme
 * puissance : `%.*f` avec `MAX(0, -shift)`. C'est ce qui fait que 0,15
 * sort `0.15` et 1234 sort `1200` — deux chiffres significatifs dans
 * les deux cas, mais zero decimale dans le second. Une implantation par
 * `toPrecision(2)` rendrait `1.2e+3`.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * NEUF cas sur onze tombent contre l'etat d'avant. Les deux autres sont
 * les TEMOINS : la reponse ARP qui ne doit porter AUCUN TTL, et le
 * crochet nu sans `--reason` — dont c'est l'objet de passer des deux
 * cotes.
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
import { numToStringSigdigits } from '@/network/scan/nmap/NmapFormatter';

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

function latence(sortie: string): number {
  const m = /\(([\d.]+)s latency\)/.exec(sortie);
  return m ? Number(m[1]) : NaN;
}

describe('num_to_string_sigdigits garde DEUX chiffres significatifs', () => {
  it('un sous-milliseme garde ses deux chiffres et ses decimales', () => {
    expect(numToStringSigdigits(0.0005762, 2)).toBe('0.00058');
  });

  it('zero s ecrit avec le nombre de decimales demande', () => {
    expect(numToStringSigdigits(0, 2)).toBe('0.00');
  });

  it('les grandeurs ordinaires', () => {
    expect(numToStringSigdigits(0.15, 2)).toBe('0.15');
    expect(numToStringSigdigits(1.234, 2)).toBe('1.2');
    expect(numToStringSigdigits(12.34, 2)).toBe('12');
  });

  it('au-dela de deux chiffres entiers, il n y a plus de decimale', () => {
    expect(numToStringSigdigits(1234, 2)).toBe('1200');
  });
});

describe('la latence est en secondes, pas en millisecondes', () => {
  it('elle vaut le millieme de l aller-retour du ping', async () => {
    const { scanner } = await segment();

    const ping = await taper(scanner, 'ping -c 1 10.0.0.2');
    const rttMs = Number(/time=([\d.]+) ms/.exec(ping)?.[1] ?? NaN);
    const sortie = await taper(scanner, 'nmap --disable-arp-ping -p 22 10.0.0.2');

    expect(rttMs).toBeGreaterThan(0);
    expect(latence(sortie)).toBeLessThan(rttMs / 100);
  });

  it('elle ne porte que deux chiffres significatifs', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap --disable-arp-ping -p 22 10.0.0.2');

    const chiffres = /\(([\d.]+)s latency\)/.exec(sortie)?.[1] ?? '';
    expect(chiffres.replace(/^0\.0*/, '').replace('.', '')).toHaveLength(2);
  });
});

describe('`--reason` dit le TTL de la reponse', () => {
  it('un echo-reply porte son TTL', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap --reason --disable-arp-ping -p 22 10.0.0.2');

    expect(sortie).toMatch(/Host is up, received echo-reply ttl 64 \([\d.]+s latency\)\./);
  });

  it('une reponse ARP n en porte aucun, et rien n est ecrit', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap --reason -p 22 10.0.0.2');

    expect(sortie).toContain('received arp-response');
    expect(sortie).not.toMatch(/arp-response ttl/);
  });
});

describe('un hote mort porte sa raison dans le crochet', () => {
  it('`--reason` la nomme', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap --reason -p 22 10.0.0.77');

    expect(sortie).toContain('[host down, received no-response]');
  });

  it('TEMOIN: sans `--reason` le crochet reste nu', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -p 22 10.0.0.77');

    expect(sortie).toContain('[host down]');
    expect(sortie).not.toContain('no-response');
  });
});

describe('la decouverte de couche lien mesure son aller-retour', () => {
  it('la latence n est plus la constante de repli', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -p 22 10.0.0.2');

    expect(sortie).toContain('MAC Address:');
    expect(latence(sortie)).not.toBe(0.001);
    expect(latence(sortie)).toBeGreaterThan(0);
  });
});
