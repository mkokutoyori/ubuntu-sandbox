/**
 * Le PREMIER paquet IPv6 vers un voisin inconnu ne se perd pas.
 *
 * Ecrit A L'AVEUGLE, apres une mesure. `sendIpv4FrameArpAware` MET EN
 * FILE le paquet qui declenche la resolution et le REEMET quand la
 * reponse ARP arrive ; son pendant IPv6 confiait le sien a une PROMESSE
 * (`resolveNDP().then(sendFrame)`) et personne ne le rattrapait. La
 * capture le dit sans ambiguite : la sollicitation de voisin part,
 * l'annonce revient, et le paquet qui les a provoquees n'existe nulle
 * part.
 *
 * TCP le cachait, parce qu'il retransmet son SYN. Ce qui l'a fait
 * paraitre est une sonde d'un SEUL coup — `nmap -sS` sur une pile v6
 * froide rendait `filtered` un port ouvert, c'est-a-dire un faux negatif,
 * la reponse qu'un scanner ne doit jamais donner. Tout emetteur d'un
 * datagramme unique etait dans le meme cas.
 *
 * `PacketQueue` existait, avec ses tests, et n'avait AUCUN appelant de
 * production — l'en-tete du fichier disait pourtant qu'il servait a
 * « eliminer les patrons dupliques fwdQueue / ipv6FwdQueue ». Les deux
 * familles le lisent desormais, donc il n'y a plus qu'une file.
 *
 * Discrimination : 4 cas tombent avant correctif — les deux sondes sur un
 * cache FROID, l'observation du segment sur le bus, et le balayage `-sS`
 * en IPv6. Les 3 autres sont les TEMOINS : le premier SYN IPv4, le ping
 * IPv4 et le ping IPv6, qui passent des deux cotes parce que le chemin
 * ARP mettait deja en file et parce que `ping6` attend sa resolution au
 * lieu de la confier a personne.
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

  await taper(scanner, 'ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0',
    'ip -6 addr add 2001:db8::1/64 dev eth0');
  await taper(cible, 'ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0',
    'ip -6 addr add 2001:db8::2/64 dev eth0');
  await taper(cible, 'sudo systemctl start ssh');

  return { sw, scanner, cible };
}

describe('un cache de voisins FROID ne mange pas le paquet', () => {
  it('le tout premier SYN IPv6 atteint la cible', async () => {
    const { scanner } = await segment();

    expect(scanner.getTcpStack().synProbe('2001:db8::2', 22)).toBe('open');
  });

  it('le tout premier ACK IPv6 atteint la cible', async () => {
    const { scanner } = await segment();

    expect(scanner.getTcpStack().ackProbe('2001:db8::2', 22)).toBe('unfiltered');
  });

  // L'observation passe par le BUS et non par un fichier de capture : ce
  // qu'on veut voir est le segment QUITTANT la machine dans le meme
  // souffle que la resolution, et l'ecriture du fichier, elle, arrive un
  // tour de micro-taches plus tard.
  it('le segment part APRES la resolution, dans le meme souffle', async () => {
    const { scanner } = await segment();
    const emises: string[] = [];
    scanner.getBus().subscribe('port.frame.tx-requested', (event) => {
      emises.push(JSON.stringify(event.payload));
    });

    scanner.getTcpStack().synProbe('2001:db8::2', 22);

    // Sollicitation de voisin, puis le SYN qui l'avait provoquee, puis le
    // RST du demi-ouvert. Avant correctif, seule la premiere partait.
    expect(emises.length).toBeGreaterThanOrEqual(3);
  });

  it('`nmap -sS` sur une cible v6 jamais contactee voit le port ouvert', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -6 -Pn -sS -p 22 2001:db8::2');

    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh/);
  });

  it('TEMOIN: le premier SYN IPv4 atteignait deja la cible', async () => {
    const { scanner } = await segment();

    expect(scanner.getTcpStack().synProbe('10.0.0.2', 22)).toBe('open');
  });

  it('TEMOIN: le chemin IPv4 en file continue de fonctionner', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'ping -c 1 10.0.0.2');

    expect(sortie).toMatch(/, 0% packet loss/);
  });

  it('TEMOIN: le ping IPv6 continue de fonctionner', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'ping6 -c 1 2001:db8::2');

    expect(sortie).toMatch(/, 0% packet loss/);
  });
});
