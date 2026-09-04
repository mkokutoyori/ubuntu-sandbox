/**
 * Les balayages DISCRETS reposent sur un silence, et ce silence n'existait
 * pas.
 *
 * Ecrit A L'AVEUGLE. `-sF`, `-sN`, `-sX`, `-sM` et `-sW` etaient tous
 * absents de l'analyseur — ils retombaient dans la ligne qui ignore ce
 * qu'on ne traite pas, donc `nmap -sF` faisait un balayage CONNECTE, avec
 * ses trois temps de poignee de main : le contraire exact de ce que ces
 * options existent pour faire.
 *
 * Mais le defaut de fond n'est pas dans `nmap`, il est dans la pile.
 * RFC 9293 §3.10.7.2, etat LISTEN, quatrieme controle — « other text or
 * control » : un segment qui n'est ni RST, ni ACK, ni SYN est JETE en
 * silence. Un port FERME, lui, repond RST (§3.10.7.1). Cette asymetrie
 * EST le balayage FIN. Mesure avant correctif : un FIN, un NULL et un
 * Xmas vers le port 22 OUVERT d'un serveur recoivent tous les trois un
 * RST, comme le port 8888 ferme — donc aucun de ces balayages ne pouvait
 * distinguer quoi que ce soit.
 *
 * Reference : `nmap/nmap`. `scan_engine.cc` donne les drapeaux de chaque
 * sonde — Xmas `FIN|URG|PSH`, NULL aucun, FIN `FIN`, Maimon `FIN|ACK`,
 * Window `ACK` — et l'etat par defaut en l'absence de reponse :
 * `PORT_OPENFILTERED` pour les quatre premiers, `PORT_FILTERED` pour
 * Window. `scan_engine_raw.cc` donne le verdict sur RST : `PORT_CLOSED`,
 * sauf Window ou la FENETRE tranche (`(tcp.th_win) ? PORT_OPEN :
 * PORT_CLOSED`) et ACK ou c'est `PORT_UNFILTERED`.
 *
 * DEUX de ces balayages ne distinguent RIEN sur cette pile, et c'est la
 * bonne reponse plutot qu'un manque : le Maimon parce que sa sonde porte
 * un ACK, que RFC 9293 §3.10.7.2 fait refuser par RST meme a l'ecoute —
 * il n'exploite qu'une idiosyncrasie BSD, le manuel de nmap le dit — et
 * le balayage par fenetre parce que cette pile emet toujours un RST a
 * fenetre NULLE, comme Linux. Chacun le dit dans son propre cas.
 *
 * Discrimination : 8 cas tombent, mesures en retirant ENSEMBLE les cinq
 * fichiers touches — un premier essai n'en avait retire que trois et
 * cassait le balayage ACK par une importation manquante, ce qui faisait
 * tomber un TEMOIN pour une raison etrangere au correctif. Les 4 cas qui
 * passent des deux cotes sont les trois TEMOINS — balayage connecte,
 * balayage ACK, vraie connexion — et le balayage par fenetre, qui rendait
 * deja `closed` par le repli sur le balayage connecte.
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

describe('un port a l ECOUTE se tait devant un segment sans SYN ni ACK', () => {
  it('le balayage FIN distingue le port ouvert du port ferme', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sF -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\|filtered/);
    expect(sortie).toMatch(/8888\/tcp\s+closed/);
  });

  it('le balayage NULL fait de meme', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sN -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\|filtered/);
    expect(sortie).toMatch(/8888\/tcp\s+closed/);
  });

  it('le balayage Xmas fait de meme', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sX -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\|filtered/);
    expect(sortie).toMatch(/8888\/tcp\s+closed/);
  });

  // Le Maimon ne distingue RIEN ici, et c'est la bonne reponse : sa sonde
  // est un FIN/ACK, donc elle porte un ACK, et RFC 9293 §3.10.7.2 (second
  // controle) fait repondre RST a tout segment portant un ACK dans l'etat
  // LISTEN. Le manuel de nmap le dit dans ces termes : « According to RFC
  // 793 (TCP), a RST packet should be generated in response to such a
  // probe whether the port is open or closed. However, Uriel noticed that
  // many BSD-derived systems simply drop the packet if the port is open. »
  // Cette pile est conforme, pas BSD-derivee : les deux ports ressortent
  // donc fermes, comme sur un vrai Linux. Mon attente ecrite a l'aveugle
  // etait fausse, pas le produit.
  it('le balayage Maimon ne distingue rien sur une pile CONFORME', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sM -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+closed/);
    expect(sortie).toMatch(/8888\/tcp\s+closed/);
  });

  it('la RAISON rendue est le silence d un cote, le RST de l autre', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sF --reason -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\|filtered\s+\S+\s+no-response/);
    expect(sortie).toMatch(/8888\/tcp\s+closed\s+\S+\s+reset/);
  });
});

describe('les drapeaux emis sont ceux de nmap', () => {
  it('le balayage Xmas envoie FIN, PSH et URG ensemble', async () => {
    const { scanner, cible } = await segment();
    await taper(scanner, 'ping -c 1 10.0.0.2');
    await taper(cible, 'sudo tcpdump -i eth0 -w /tmp/xmas.pcap &');

    await taper(scanner, 'nmap -Pn -sX -p 8888 10.0.0.2');

    const vu = await taper(cible, 'sudo tcpdump -r /tmp/xmas.pcap -nn');
    expect(vu).toMatch(/10\.0\.0\.1\.\d+ > 10\.0\.0\.2\.8888: Flags \[FP\.?U\]|Flags \[FPU\]/);
  });

  it('le balayage FIN n envoie QUE le drapeau FIN', async () => {
    const { scanner, cible } = await segment();
    await taper(scanner, 'ping -c 1 10.0.0.2');
    await taper(cible, 'sudo tcpdump -i eth0 -w /tmp/fin.pcap &');

    await taper(scanner, 'nmap -Pn -sF -p 8888 10.0.0.2');

    const vu = await taper(cible, 'sudo tcpdump -r /tmp/fin.pcap -nn');
    expect(vu).toMatch(/10\.0\.0\.1\.\d+ > 10\.0\.0\.2\.8888: Flags \[F\]/);
  });

  it('aucun de ces balayages n acheve de poignee de main', async () => {
    const { scanner, cible } = await segment();
    await taper(scanner, 'ping -c 1 10.0.0.2');
    await taper(cible, 'sudo tcpdump -i eth0 -w /tmp/disc.pcap &');

    await taper(scanner, 'nmap -Pn -sF -p 22 10.0.0.2');

    const vu = await taper(cible, 'sudo tcpdump -r /tmp/disc.pcap -nn');
    expect(vu).not.toMatch(/Flags \[S\]/);
    expect(vu).not.toMatch(/Flags \[S\.\]/);
  });
});

describe('le balayage par FENETRE lit la fenetre du RST', () => {
  // Comme le Maimon, il ne distingue rien ICI, et pour une raison de la
  // meme famille. Le manuel de nmap : « On some systems, open ports use a
  // positive window size (even for RST packets) while closed ones have a
  // zero window. […] This scan relies on an implementation detail of a
  // minority of systems out on the Internet, so you can't always trust
  // it. Systems that don't support it will usually return all ports
  // closed. » Cette pile emet toujours un RST a fenetre NULLE, comme
  // Linux : les deux ports ressortent donc fermes. Ce que ce cas garde
  // est que le verdict n'est plus celui du balayage ACK — un `-sW` qui
  // rendrait `unfiltered` serait un `-sA` deguise.
  it('il ne rend jamais `unfiltered`, contrairement au balayage ACK', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sW -p 22,8888 10.0.0.2');

    expect(sortie).not.toMatch(/unfiltered/);
    expect(sortie).toMatch(/22\/tcp\s+closed/);
    expect(sortie).toMatch(/8888\/tcp\s+closed/);
  });
});

describe('les temoins', () => {
  it('TEMOIN: le balayage connecte distingue toujours ouvert et ferme', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh/);
    expect(sortie).toMatch(/8888\/tcp\s+closed/);
  });

  it('TEMOIN: le balayage ACK rend `unfiltered` des deux cotes', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sA -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+unfiltered/);
    expect(sortie).toMatch(/8888\/tcp\s+unfiltered/);
  });

  it('TEMOIN: une vraie connexion vers le port ouvert fonctionne encore', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nc -v 10.0.0.2 22');

    expect(sortie).toMatch(/SSH-2\.0-/);
  });
});
