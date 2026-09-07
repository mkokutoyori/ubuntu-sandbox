/**
 * Le port 123 est TENU par un demon, ou il est ferme — il n'y a pas de
 * troisieme etat.
 *
 * Ecrit A L'AVEUGLE, apres une mesure faite en balayant une machine avec
 * `nmap -sU`. Trois vues de la MEME machine se contredisaient au meme
 * instant :
 *
 *   `systemctl list-units`  chrony.service ... running
 *   `ss -lun`               aucune ligne pour le port 123
 *   sur le fil              le datagramme est AVALE en silence
 *
 * `EndHost.deliverUDP` portait un aiguillage code en dur —
 * `if (udp.destinationPort === 123)` — qui remettait le datagramme a
 * l'agent NTP SANS que rien n'ait jamais lie le port. Consequences, et
 * aucune n'est cosmetique : `ss` et `netstat` niaient un service qui
 * tourne ; le port ne repondait pas ICMP port unreachable non plus,
 * donc `nmap -sU -p 123` le rendait `open|filtered` alors que la machine
 * affirmait que rien n'ecoutait ; et un `udpBind(123)` par n'importe
 * quoi d'autre etait ACCEPTE puis ombre par l'aiguillage, c'est-a-dire
 * accepte et inerte — exactement le defaut que le plan de controle d'un
 * routeur a deja referme avec `controlPlaneUdpClaims`.
 *
 * L'en-tete de `ServiceSocketServer` nomme deja la regle, dans l'autre
 * sens : « un port affiche doit etre joignable, un port injoignable ne
 * doit pas etre affiche ». Ici c'est un port JOIGNABLE et NON AFFICHE.
 *
 * ── Ce qui est attendu ──────────────────────────────────────────────
 *
 * `chrony` entre dans `SERVICE_LISTENERS` avec `123/udp`, et le demon
 * lie vraiment son ecoute. Donc : `ss -lun` le montre pendant qu'il
 * tourne, `systemctl stop chrony` le fait disparaitre ET rend le port
 * FERME (ICMP port unreachable, `nmap` dit `closed`), et le redemarrage
 * le rouvre.
 *
 * ── Divergence assumee et ecrite ────────────────────────────────────
 *
 * Un vrai `chronyd` en mode CLIENT n'occupe pas 0.0.0.0:123 — il emet
 * depuis un port ephemere et ne lie 123 que configure en serveur. Le
 * moteur NTP de ce depot est PARTAGE avec les routeurs Cisco et Huawei,
 * ou l'echange est 123 vers 123 (`ntp server` d'IOS), et il emet donc
 * depuis 123 comme `ntpd`. C'est ce que la machine FAIT, et c'est cela
 * que `ss` doit decrire : la coherence des vues prime ici sur le choix
 * du demon modelise.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * Attendue : les cas qui observent la liaison et l'etat ferme tombent
 * contre l'etat d'avant. Le TEMOIN — un port UDP quelconque sans
 * personne dessus, qui repond deja `closed` — doit passer des deux
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

  await taper(scanner, 'sudo ip addr add 10.0.0.1/24 dev eth0', 'sudo ip link set eth0 up');
  await taper(cible, 'sudo ip addr add 10.0.0.2/24 dev eth0', 'sudo ip link set eth0 up');

  return { scanner, cible };
}

function etatUdp(rapport: string, port: number): string {
  const m = new RegExp(`^${port}/udp[ \\t]+(\\S+)`, 'm').exec(rapport);
  return m === null ? '<absent>' : m[1];
}

describe('un demon qui tourne tient son port', () => {
  it('ss montre 123 pendant que chrony tourne', async () => {
    const { cible } = await segment();

    const sortie = await taper(cible, 'ss -lun');

    expect(sortie).toMatch(/0\.0\.0\.0:123/);
  });

  it('le processus qui le tient est nomme', async () => {
    const { cible } = await segment();

    const sortie = await taper(cible, 'ss -lunp');

    expect(sortie).toMatch(/0\.0\.0\.0:123.*chronyd/);
  });

  it('nmap le voit ouvert, et la machine est d accord', async () => {
    const { scanner, cible } = await segment();

    const ss = await taper(cible, 'ss -lun');
    const rapport = await taper(scanner, 'nmap -Pn -sU -p 123 10.0.0.2');

    expect(ss).toMatch(/0\.0\.0\.0:123/);
    expect(etatUdp(rapport, 123)).toBe('open|filtered');
  });
});

describe('un demon arrete rend son port', () => {
  it('ss ne le montre plus', async () => {
    const { cible } = await segment();

    await taper(cible, 'sudo systemctl stop chrony');
    const sortie = await taper(cible, 'ss -lun');

    expect(sortie).not.toMatch(/0\.0\.0\.0:123/);
  });

  it('et le port devient FERME, avec un ICMP port unreachable', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo systemctl stop chrony');
    await taper(cible, 'tcpdump -nn -i eth0 icmp -w ntp.pcap &');

    const rapport = await taper(scanner, 'nmap -Pn -sU --reason -p 123 10.0.0.2');
    const capture = await taper(cible, 'tcpdump -r ntp.pcap -nn');

    expect(etatUdp(rapport, 123)).toBe('closed');
    expect(rapport).toMatch(/123\/udp\s+closed\s+ntp\s+port-unreach/);
    expect(capture).toContain('udp port 123 unreachable');
  });

  it('le redemarrage le rouvre', async () => {
    const { cible } = await segment();

    await taper(cible, 'sudo systemctl stop chrony');
    await taper(cible, 'sudo systemctl start chrony');
    const sortie = await taper(cible, 'ss -lun');

    expect(sortie).toMatch(/0\.0\.0\.0:123/);
  });
});

describe('TEMOIN', () => {
  it('un port UDP que personne ne tient repond deja ferme', async () => {
    const { scanner } = await segment();

    const rapport = await taper(scanner, 'nmap -Pn -sU --reason -p 161 10.0.0.2');

    expect(etatUdp(rapport, 161)).toBe('closed');
    expect(rapport).toContain('port-unreach');
  });
});
