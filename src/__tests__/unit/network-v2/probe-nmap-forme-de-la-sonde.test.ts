/**
 * `--badsum`, `-g/--source-port` et `--ttl` : ce que nmap COMPOSE dans sa
 * sonde, et que la pile de la cible juge vraiment.
 *
 * Ecrit A L'AVEUGLE. Les trois options appartiennent a la meme section
 * du manuel — FIREWALL/IDS EVASION — et au meme mecanisme : le paquet du
 * balayage n'est plus celui que la pile aurait compose toute seule. Elles
 * ne valent ici que parce que ce simulateur juge REELLEMENT ce qu'elles
 * changent : `TcpStack.handleIp` verifie la somme de controle TCP et
 * jette (`bad-checksum`), `EndHost.deliverUDP` fait de meme pour UDP, et
 * un routeur decremente la duree de vie.
 *
 * ── `--badsum` ──────────────────────────────────────────────────────
 *
 * `ipv4_cksum` (`tcpip.cc:434`) : la somme JUSTE est calculee puis
 * DECREMENTEE d'un — et si le protocole est UDP et que le resultat tombe
 * a zero, elle vaut `0xffff`, parce qu'une somme UDP nulle veut dire
 * « pas de somme » en IPv4 et laisserait donc passer le paquet.
 *
 * L'effet attendu est celui que documente nmap : « virtually all host IP
 * stacks properly drop these packets », donc tout port se tait. Ce qui le
 * rend observable ICI plutot que decoratif, c'est que la trame ARRIVE —
 * un `tcpdump` sur la cible la voit — et que c'est la PILE qui la jette.
 *
 * ── `-g` / `--source-port` ──────────────────────────────────────────
 *
 * `nmap.cc:1086` : `o.magic_port`. La lecon est la regle de pare-feu qui
 * fait confiance a un port source (53, 20, 80) ; ce depot a un moteur de
 * listes de controle qui sait juger un port source, donc l'option n'est
 * pas un decor.
 *
 * ── `--ttl` ─────────────────────────────────────────────────────────
 *
 * `nmap.cc:750` : `o.ttl`, refuse hors de [0, 255] par un `fatal`. Une
 * duree de vie trop courte fait mourir la sonde EN ROUTE, donc le port
 * se lit `filtered` alors que la cible est bien vivante.
 *
 * ── Les trois exigent l'acces brut ──────────────────────────────────
 *
 * Chacune pose `delayed_options.raw_scan_options` et `nmap.cc:1833`
 * avertit alors, sans les honorer, quand le balayage est CONNECTE :
 * `connect()` laisse le noyau composer le paquet. `-g` porte en plus son
 * avertissement propre (`NmapOps.cc:527`), emis AVANT le generique
 * puisque `ValidateOptions()` est appele en `nmap.cc:1535`.
 *
 * ── Ce que ces options ne touchent PAS, et pourquoi ─────────────────
 *
 * La DECOUVERTE. `--badsum` corrompt ce que nmap compose ; la decouverte
 * de ce simulateur emprunte le `ping` et le `connect` de la machine, que
 * nmap ne compose pas — la meme raison qui fait qu'un balayage connecte
 * ne peut pas honorer l'option du tout. Les cas ci-dessous balayent donc
 * sous `-Pn`, et un cas l'epingle plutot que de le laisser deviner.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * Attendue : les cas qui tapent une des trois options tombent contre
 * l'etat d'avant, ou elles sont refusees avant tout balayage. Les deux
 * TEMOINS — le balayage sans option et la capture qui voit la trame —
 * doivent passer des deux cotes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

/** Un routeur entre le scanneur et la cible : un saut a franchir. */
async function deuxSegments() {
  const r = new CiscoRouter('R1', 100, 0);
  const scanner = new LinuxPC('linux-pc', 'SCANNER', 0, 0);
  const cible = new LinuxServer('linux-server', 'CIBLE', 200, 0);
  scanner.powerOn(); cible.powerOn(); r.powerOn();

  new Cable('c1').connect(scanner.getPort('eth0')!, r.getPort('GigabitEthernet0/0')!);
  new Cable('c2').connect(cible.getPort('eth0')!, r.getPort('GigabitEthernet0/1')!);

  await taper(r,
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.1.0.254 255.255.255.0',
    'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.2.0.254 255.255.255.0',
    'no shutdown', 'exit', 'end');

  await taper(scanner, 'ip link set eth0 up', 'ip addr add 10.1.0.1/24 dev eth0',
    'ip route add default via 10.1.0.254');
  await taper(cible, 'ip link set eth0 up', 'ip addr add 10.2.0.2/24 dev eth0',
    'ip route add default via 10.2.0.254');
  await taper(cible, 'sudo systemctl start ssh');

  return { scanner, cible, r };
}

function etatDuPort(sortie: string, port: number): string | null {
  const m = new RegExp(`^${port}/(?:tcp|udp)\\s+(\\S+)`, 'm').exec(sortie);
  return m ? m[1] : null;
}

describe('--badsum : la pile de la cible jette ce qui ne se verifie pas', () => {
  it('un balayage SYN correct ouvre le port, le meme avec --badsum le filtre', async () => {
    const { scanner } = await segment();

    const temoin = await taper(scanner, 'nmap -Pn -sS -p 22 10.0.0.2');
    expect(etatDuPort(temoin, 22)).toBe('open');

    const corrompu = await taper(scanner, 'nmap -Pn -sS --badsum -p 22 10.0.0.2');
    expect(corrompu).not.toContain('not implemented');
    expect(etatDuPort(corrompu, 22)).toBe('filtered');
  });

  it('la trame ARRIVE bien : c est la pile qui la jette, pas le fil', async () => {
    const { scanner, cible } = await segment();

    await taper(cible, 'tcpdump -nn -i eth0 tcp port 22 -w corrompu.pcap &');
    await taper(scanner, 'nmap -Pn -sS --badsum -p 22 10.0.0.2');
    const capture = await taper(cible, 'tcpdump -r corrompu.pcap -nn');

    expect(capture).toMatch(/10\.0\.0\.1\.\d+ > 10\.0\.0\.2\.22: Flags \[S\]/);
    expect(capture).not.toMatch(/10\.0\.0\.2\.22 > 10\.0\.0\.1\.\d+: Flags \[S\.\]/);
  });

  it('un balayage UDP corrompu ne recoit plus de port-unreachable', async () => {
    const { scanner } = await segment();

    const temoin = await taper(scanner, 'nmap -Pn -sU -p 9 10.0.0.2');
    expect(etatDuPort(temoin, 9)).toBe('closed');

    const corrompu = await taper(scanner, 'nmap -Pn -sU --badsum -p 9 10.0.0.2');
    expect(etatDuPort(corrompu, 9)).toBe('open|filtered');
  });

  it('un balayage CONNECTE avertit et n honore pas l option', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sT --badsum -p 22 10.0.0.2');

    expect(sortie).toContain(
      'You have specified some options that require raw socket access.');
    expect(sortie).toContain(
      'These options will not be honored for TCP Connect scan.');
    expect(etatDuPort(sortie, 22)).toBe('open');
  });
});

describe('-g impose le port source de la sonde', () => {
  it('la sonde part du port demande', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner,
      'nmap -Pn -sS -g 53 --packet-trace -p 22 10.0.0.2');

    expect(sortie).toMatch(/SENT \(\d+\.\d{4}s\) TCP \[10\.0\.0\.1:53 > 10\.0\.0\.2:22 S seq=/);
    expect(etatDuPort(sortie, 22)).toBe('open');
  });

  it('--source-port est le meme mot', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner,
      'nmap -Pn -sS --source-port 20 --packet-trace -p 22 10.0.0.2');

    expect(sortie).toMatch(/TCP \[10\.0\.0\.1:20 > 10\.0\.0\.2:22 S seq=/);
  });

  it('une liste de controle qui fait confiance au port 53 laisse passer', async () => {
    const { scanner, cible } = await segment();
    await taper(cible,
      'sudo iptables -A INPUT -p tcp --dport 22 --sport 53 -j ACCEPT',
      'sudo iptables -A INPUT -p tcp --dport 22 -j DROP');

    const bloque = await taper(scanner, 'nmap -Pn -sS -p 22 10.0.0.2');
    expect(etatDuPort(bloque, 22)).toBe('filtered');

    const passe = await taper(scanner, 'nmap -Pn -sS -g 53 -p 22 10.0.0.2');
    expect(etatDuPort(passe, 22)).toBe('open');
  });

  it('avec un balayage connecte, -g porte son propre avertissement', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sT -g 53 -p 22 10.0.0.2');

    expect(sortie).toContain('WARNING: -g is incompatible with the default'
      + ' connect() scan (-sT).  Use a raw scan such as -sS if you want to set'
      + ' the source port.');
    expect(sortie).toContain(
      'You have specified some options that require raw socket access.');
  });

  it('un port source nul est signale sans etre refuse', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS -g 0 -p 22 10.0.0.2');

    expect(sortie).toContain(
      'WARNING: a source port of zero may not work on all systems.');
    expect(sortie).toContain('Nmap scan report for 10.0.0.2');
  });
});

describe('--ttl decide jusqu ou la sonde va', () => {
  it('la valeur est posee sur le paquet', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner,
      'nmap -Pn -sS --ttl 7 --packet-trace -p 22 10.0.0.2');

    expect(sortie).toMatch(/SENT \([^)]+\) TCP \[[^\]]+\] IP \[ttl=7 /);
  });

  it('une duree de vie de 1 meurt sur le routeur, le port se lit filtered', async () => {
    const { scanner } = await deuxSegments();

    const temoin = await taper(scanner, 'nmap -Pn -sS -p 22 10.2.0.2');
    expect(etatDuPort(temoin, 22)).toBe('open');

    const court = await taper(scanner, 'nmap -Pn -sS --ttl 1 -p 22 10.2.0.2');
    expect(etatDuPort(court, 22)).toBe('filtered');
  });

  it('une valeur hors de [0, 255] est refusee avant tout balayage', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn --ttl 300 -p 22 10.0.0.2');

    expect(sortie).toContain('ttl option must be a number between 0 and 255 (inclusive)');
    expect(sortie).not.toContain('Nmap scan report');
  });
});
