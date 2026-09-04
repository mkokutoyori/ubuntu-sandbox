/**
 * `-6` choisit la FAMILLE, et la decouverte d'hote sonde en ICMPv6.
 *
 * Ecrit A L'AVEUGLE, apres mesure. Deux defauts, le second cache par le
 * premier.
 *
 * (1) `-6` etait AVALE par l'analyseur — la ligne qui l'ignorait le
 * rangeait avec `-T` et `-R`. Consequence mesuree : `nmap -6 -p 22 B`
 * repondait `Nmap scan report for B (10.0.0.2)`, c'est-a-dire qu'il
 * balayait l'adresse IPv4 de la cible sous un drapeau qui demande
 * exactement l'inverse. Un vrai `nmap -6` resout le nom en AAAA et
 * echoue si l'hote n'en porte pas.
 *
 * (2) La decouverte d'hote n'emettait AUCUN echo ICMPv6 : `discoverHost`
 * construisait un `IPAddress` a partir de la cible, ce qui LEVE sur une
 * adresse v6, et le `catch` faisait retomber sur la connexion TCP vers
 * 80 et 443. La cible etait donc declaree vivante — par le bon repli de
 * `nmap.h`, mais sans qu'un echo soit parti —, la latence rendue etait la
 * valeur par defaut, et `-O` ne conjecturait rien puisque le TTL se lit
 * sur la reponse d'echo.
 *
 * Reference : `nmap.h`, `DEFAULT_IPV6_PING_TYPES` vaut
 * `PINGTYPE_ICMP_PING|PINGTYPE_TCP|PINGTYPE_TCP_USE_ACK|PINGTYPE_TCP_USE_SYN`
 * — l'echo ICMP y est, et l'horodatage n'y est PAS, ICMPv6 n'en ayant
 * pas.
 *
 * (3) Troisieme defaut, trouve en cherchant a OBSERVER le second :
 * `tcpdump` rendait `ICMP6, length N` pour TOUS les messages ICMPv6, sans
 * jamais nommer le type. Une capture ou l'echo, la sollicitation de
 * voisin et l'annonce sont indiscernables ne permet de diagnostiquer
 * rien. Le vrai `tcpdump` (`print-icmp6.c`) ecrit `echo request, id …,
 * seq …`, `neighbor solicitation, who has …` et `neighbor
 * advertisement, tgt is …` ; la matiere etait deja dans la trame
 * capturee, seul le rendu la taisait.
 *
 * Discrimination : 5 cas tombent avant correctif. Les 2 autres sont les
 * TEMOINS IPv4 — la resolution d'un nom sans `-6` et la decouverte IPv4 —
 * dont c'est l'objet de passer des deux cotes, ce chemin n'ayant pas
 * change.
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

async function segment(options: { v6OnTarget?: boolean } = {}) {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
  const scanner = new LinuxPC('linux-pc', 'SCANNER', 0, 0);
  const cible = new LinuxServer('linux-server', 'CIBLE', 200, 0);
  scanner.powerOn(); cible.powerOn();

  new Cable('c1').connect(scanner.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(cible.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);

  await taper(scanner, 'ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0',
    'ip -6 addr add 2001:db8::1/64 dev eth0');
  await taper(cible, 'ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0');
  if (options.v6OnTarget !== false) {
    await taper(cible, 'ip -6 addr add 2001:db8::2/64 dev eth0');
  }
  await taper(cible, 'sudo systemctl start ssh');

  return { sw, scanner, cible };
}

describe('`-6` choisit la famille de la resolution', () => {
  it('un NOM se resout en IPv6 et non en IPv4', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -6 -Pn -p 22 CIBLE');

    expect(sortie).toContain('2001:db8::2');
    expect(sortie).not.toContain('10.0.0.2');
  });

  it('un hote SANS adresse IPv6 n est pas une cible IPv6', async () => {
    const { scanner } = await segment({ v6OnTarget: false });

    const sortie = await taper(scanner, 'nmap -6 -Pn -p 22 CIBLE');

    expect(sortie).not.toContain('10.0.0.2');
    expect(sortie).toMatch(/0 hosts up|Failed to resolve|0 IP addresses/);
  });

  it('TEMOIN: sans `-6`, le meme nom se resout en IPv4', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -p 22 CIBLE');

    expect(sortie).toContain('10.0.0.2');
  });
});

// La cible de ce laboratoire est sur le MEME segment, et un vrai `nmap`
// la decouvre alors par sollicitation de voisin (`PING_SCAN_ND`), qui
// REMPLACE les sondes IP au lieu de s'y ajouter. `--disable-arp-ping` est
// precisement l'option qui les rend, et c'est donc elle qui permet
// d'eprouver l'echo ICMPv6 sur un voisin direct.
describe('la decouverte d hote EMET un echo ICMPv6', () => {
  it('la sonde arrive chez la cible', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo tcpdump -i eth0 -w /tmp/d6.pcap &');

    await taper(scanner, 'nmap -6 --disable-arp-ping -sn 2001:db8::2');

    const vu = await taper(cible, 'sudo tcpdump -r /tmp/d6.pcap -nn');
    // Un ECHO, et pas seulement la sollicitation de voisin qui le precede.
    expect(vu).toMatch(/2001:db8::1 > 2001:db8::2: ICMP6, echo request/);
  });

  it('`-O` conjecture le systeme depuis la reponse d echo', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -6 -O -p 22 2001:db8::2');

    expect(sortie).toMatch(/Linux/);
  });

  it('la latence rendue est celle qui a ete MESUREE', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -6 --disable-arp-ping -sn 2001:db8::2');

    expect(sortie).toMatch(/Host is up/);
    expect(sortie).not.toMatch(/\(0\.0010s latency\)/);
  });

  it('TEMOIN: la decouverte IPv4 continue de fonctionner', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn 10.0.0.2');

    expect(sortie).toMatch(/Host is up/);
  });
});
