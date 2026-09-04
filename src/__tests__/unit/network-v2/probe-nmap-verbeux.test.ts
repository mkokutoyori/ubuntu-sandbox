/**
 * `-v` etait analyse, range, et lu par PERSONNE.
 *
 * Ecrit A L'AVEUGLE. `NmapOptions.verbose` est ecrit par `-v`, `-vv` et
 * `-d`, et `grep` sur tout `scan/nmap/` ne trouve aucun lecteur : la
 * sortie de `nmap -v` est mot pour mot celle de `nmap`. C'est la forme
 * exacte que ce depot referme sans cesse — un critere accepte, affiche
 * dans la configuration, et qui ne decide rien.
 *
 * Ce que `-v` ajoute sur une vraie machine, lu dans la source plutot que
 * rappele. `timing.cc:765` : `Initiating %s at %02d:%02d`, et a la fin
 * `Completed %s at %02d:%02d, %.2fs elapsed`, chacun suivi de
 * ` (%s)` quand une precision existe. `scan_engine.cc:2777` :
 * `Scanning %s [%d port%s%s]`, dont le `s` du pluriel est explicitement
 * conditionne a `numprobes != 1`. `scan_engine.cc:2828` : la precision
 * finale est `%lu total hosts` pour un balayage de DECOUVERTE et
 * `%lu total ports` sinon — deux unites, parce que les deux phases ne
 * comptent pas la meme chose.
 *
 * Le nom de chaque phase vient de `scan_lists.cc:529` (`scantype2str`) et
 * n'est pas devinable : le balayage connecte s'appelle `Connect Scan`, le
 * `-sS` `SYN Stealth Scan`, le `-sX` `XMAS Scan` en capitales, le `-sM`
 * `Maimon Scan`, le `-sW` `Window Scan`. La decouverte par ARP est une
 * phase A PART, `ARP Ping Scan`, distincte de `Ping Scan`, ce qui rend
 * VISIBLE le fait que l'ARP remplace les sondes IP au lieu de s'y
 * ajouter.
 *
 * `nmap.cc:2143` enfin : sous `-v`, un hote TROUVE MORT est rapporte
 * (`currenths->flags & HOST_UP || (o.verbose && !o.openOnly())`), la ou
 * un balayage ordinaire ne liste que ce qu'il a trouve.
 *
 * Une decision assumee et ecrite plutot que tue : la duree d'une phase
 * n'est pas MESUREE. Ce simulateur livre ses trames de facon synchrone,
 * donc aucune phase ne dure ; la duree affichee est celle que la ligne
 * finale annonce deja, repartie sur les phases. En inventer une autre
 * ferait dire deux choses a une meme sortie. Les cas ci-dessous
 * n'eprouvent donc que la FORME du nombre, jamais sa valeur.
 *
 * Discrimination : 7 cas tombent avant correctif. Les 3 qui passent des
 * deux cotes sont les TEMOINS, et c'est exactement leur role — sans `-v`
 * aucune ligne de phase ne paraissait ni ne doit paraitre, un hote mort
 * n'etait pas liste sous `-sn` et ne doit toujours pas l'etre, et le
 * verdict des ports ne devait pas bouger.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

describe('`-v` nomme les PHASES du balayage', () => {
  it('la phase de ports est ouverte, comptee et fermee', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -v -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/Initiating Connect Scan at \d{2}:\d{2}/);
    expect(sortie).toContain('Scanning 10.0.0.2 [2 ports]');
    expect(sortie).toMatch(/Completed Connect Scan at \d{2}:\d{2}, \d+\.\d{2}s elapsed \(2 total ports\)/);
  });

  it('un seul port se dit au SINGULIER', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -v -p 22 10.0.0.2');

    expect(sortie).toContain('Scanning 10.0.0.2 [1 port]');
    expect(sortie).not.toContain('[1 ports]');
  });

  it('la decouverte par ARP est une phase A PART', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -v -sn 10.0.0.2');

    expect(sortie).toMatch(/Initiating ARP Ping Scan at \d{2}:\d{2}/);
    expect(sortie).toMatch(/Completed ARP Ping Scan at \d{2}:\d{2}, \d+\.\d{2}s elapsed \(1 total host\)/);
    expect(sortie).not.toContain('total ports');
  });

  it('hors du segment, la decouverte s appelle `Ping Scan`', async () => {
    const routeur = new CiscoRouter('R1', 100, 0);
    const scanner = new LinuxPC('linux-pc', 'SCANNER', 0, 0);
    const cible = new LinuxServer('linux-server', 'CIBLE', 200, 0);
    routeur.powerOn(); scanner.powerOn(); cible.powerOn();
    new Cable('c1').connect(scanner.getPort('eth0')!, routeur.getPort('GigabitEthernet0/0')!);
    new Cable('c2').connect(cible.getPort('eth0')!, routeur.getPort('GigabitEthernet0/1')!);
    await taper(routeur, 'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.254 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.1.254 255.255.255.0', 'no shutdown', 'exit',
      'end');
    await taper(scanner, 'ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0',
      'ip route add default via 10.0.0.254');
    await taper(cible, 'ip link set eth0 up', 'ip addr add 10.0.1.1/24 dev eth0',
      'ip route add default via 10.0.1.254');

    const sortie = await taper(scanner, 'nmap -v -sn 10.0.1.1');

    expect(sortie).toMatch(/Initiating Ping Scan at \d{2}:\d{2}/);
    expect(sortie).not.toContain('ARP Ping Scan');
  });

  it('chaque balayage porte le nom que `scantype2str` lui donne', async () => {
    const { scanner } = await segment();

    const syn = await taper(scanner, 'nmap -v -sS -p 22 10.0.0.2');
    expect(syn).toContain('Initiating SYN Stealth Scan');

    const xmas = await taper(scanner, 'nmap -v -sX -p 22 10.0.0.2');
    expect(xmas).toContain('Initiating XMAS Scan');

    const maimon = await taper(scanner, 'nmap -v -sM -p 22 10.0.0.2');
    expect(maimon).toContain('Initiating Maimon Scan');

    const fenetre = await taper(scanner, 'nmap -v -sW -p 22 10.0.0.2');
    expect(fenetre).toContain('Initiating Window Scan');

    const udp = await taper(scanner, 'nmap -v -sU -p 53 10.0.0.2');
    expect(udp).toContain('Initiating UDP Scan');
  });

  it('`-Pn` supprime la phase de decouverte et la garde nommee', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -v -Pn --disable-arp-ping -p 22 10.0.0.2');

    expect(sortie).not.toContain('Ping Scan');
    expect(sortie).toContain('Initiating Connect Scan');
  });
});

describe('`-v` rapporte aussi ce qui est MORT', () => {
  it('un hote injoignable est rapporte sous `-sn -v`', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -v -sn 10.0.0.77');

    expect(sortie).toContain('Nmap scan report for 10.0.0.77 [host down]');
  });

  it('TEMOIN: sans `-v`, le meme hote n est pas liste', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn 10.0.0.77');

    expect(sortie).not.toContain('10.0.0.77');
    expect(sortie).toContain('(0 hosts up)');
  });
});

describe('les temoins', () => {
  it('TEMOIN: sans `-v`, aucune ligne de phase ne parait', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -p 22,8888 10.0.0.2');

    expect(sortie).not.toContain('Initiating');
    expect(sortie).not.toContain('Scanning');
    expect(sortie).not.toContain('Completed');
  });

  it('TEMOIN: `-v` ne change RIEN au verdict des ports', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -v -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh/);
    expect(sortie).toMatch(/8888\/tcp\s+closed/);
  });
});
