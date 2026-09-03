/**
 * `nmap` doit SONDER, pas INSPECTER.
 *
 * Ecrit A L'AVEUGLE. La regle du depot est explicite : ce qui passe
 * entre deux machines traverse le reseau simule en vraies trames, et
 * atteindre l'objet du pair pour lui demander son etat est le raccourci
 * que ce projet n'accepte pas. `nmap` est justement l'outil dont c'est
 * TOUT le propos — il n'apprend rien qu'il n'ait mesure sur le fil, et
 * un scanner qui lit la reponse dans l'objet de sa cible enseigne un
 * reseau qui n'existe pas.
 *
 * Reference : depot `nmap/nmap`. Les faits sont releves dans la source
 * plutot que de memoire.
 *
 *   `nmap.h` : « -PE -PA80 -PS443 -PP » est la decouverte d'hote par
 *   defaut en IPv4 privilegie (`DEFAULT_IPV4_PING_TYPES`), et
 *   `DEFAULT_PING_CONNECT_PORT_SPEC "80,443"` celle du mode non
 *   privilegie. Une machine ne se declare donc PAS vivante sans qu'au
 *   moins une sonde ait ete emise et une reponse recue.
 *
 *   `scan_engine_raw.cc` : un ICMP type 3 code 3 rend le port CLOS s'il
 *   vient de la CIBLE et qu'on fait un balayage UDP ; les codes 0, 1, 2,
 *   9, 10 et 13 rendent FILTRE. La nuance `from_target` compte — un
 *   inatteignable emis par un routeur intermediaire est FILTRE, pas
 *   clos.
 *
 * La mesure porte donc sur le FIL et non sur la sortie : compter les
 * trames emises pendant le balayage est la seule facon de distinguer un
 * scanner qui sonde d'un scanner qui devine juste. Une sortie correcte
 * ne prouve rien ici, puisque l'inspection d'objet donne la meme.
 *
 * Le TEMOIN est le balayage ORDINAIRE d'un port ouvert : il passe deja
 * par la vraie pile (`ctx.net.tcpConnectOutcome`), donc il doit
 * continuer de fonctionner — un correctif qui casserait le seul chemin
 * deja honnete serait pire que le defaut.
 *
 * UN DEFAUT DU LABORATOIRE, trouve en le mesurant et ecrit ici plutot que
 * tu : un `LinuxServer` demarre DEJA son sshd, donc le cas « un port ferme
 * est vu ferme » visait un port ouvert ; il vise 8888.
 *
 * La salutation, elle, etait un defaut du PRODUIT et non du laboratoire.
 * `SocketEntry.banner` — « les premiers octets qu'un service ecrit sur une
 * connexion fraiche » — etait DECLARE a la liaison et n'etait ecrit sur
 * aucun fil : la capture montrait chaque segment `length 0` pendant que
 * `nc` et `nmap -sV` rendaient la banniere, lue dans l'objet de la cible.
 * `TcpStack` l'emet desormais a l'acceptation, et RFC 4253 §4.2 dit que
 * c'est bien le serveur qui parle le premier.
 *
 * Discrimination, en retirant l'emission de la salutation
 * (`TcpStack`, `LinuxMachine`, `CaptureFrame`, `SshServerHandler`) : 4 cas
 * tombent — les trois qui lisent une version et celui qui exige les
 * octets dans la capture. Les 10 autres passent des deux cotes et c'est
 * leur role : ce sont les TEMOINS de la decouverte d'hote et du chemin
 * TCP, dont l'objet est de garantir que le correctif ne les a pas casses.
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

async function capturer(machine: Cmd, fichier: string): Promise<void> {
  await machine.executeCommand(`sudo tcpdump -i eth0 -w ${fichier} &`);
}

async function relire(machine: Cmd, fichier: string): Promise<string> {
  return machine.executeCommand(`sudo tcpdump -r ${fichier} -nn`);
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

  return { sw, scanner, cible };
}

describe('la decouverte d hote EMET quelque chose', () => {
  it('`nmap -sn` fait ARRIVER une sonde chez la cible', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo systemctl start ssh');
    await capturer(cible, '/tmp/sn.pcap');

    await taper(scanner, 'nmap -sn 10.0.0.2');

    const vu = await relire(cible, '/tmp/sn.pcap');
    expect(vu).toMatch(/10\.0\.0\.1/);
  });

  it('une machine SANS route depuis le scanner n est pas declaree vivante', async () => {
    const { scanner } = await segment();
    const isole = new LinuxPC('linux-pc', 'ISOLE', 400, 200);
    isole.powerOn();
    await taper(isole, 'ip link set eth0 up', 'ip addr add 192.0.2.50/24 dev eth0');

    const sortie = await taper(scanner, 'nmap -sn 192.0.2.50');

    expect(sortie).not.toMatch(/Host is up/);
  });

  it('TEMOIN: une machine du meme segment EST declaree vivante', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -sn 10.0.0.2');

    expect(sortie).toMatch(/Host is up/);
  });
});

describe('un balayage de port passe par la pile', () => {
  it('TEMOIN: un port ouvert est vu ouvert', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo systemctl start ssh');

    const sortie = await taper(scanner, 'nmap -p 22 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh/);
  });

  it('TEMOIN: un port ferme est vu ferme', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -p 8888 10.0.0.2');

    expect(sortie).toMatch(/8888\/tcp\s+closed/);
  });

  it('le balayage de port fait ARRIVER un segment sur le port 22', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo systemctl start ssh');
    await capturer(cible, '/tmp/p22.pcap');

    await taper(scanner, 'nmap -Pn -p 22 10.0.0.2');

    const vu = await relire(cible, '/tmp/p22.pcap');
    expect(vu).toMatch(/\.22\b/);
  });
});

describe('la detection de version LIT la banniere sur une vraie connexion', () => {
  it('`-sV` ouvre une VRAIE connexion, poignee de main comprise', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo systemctl start ssh');
    await capturer(cible, '/tmp/sv.pcap');

    await taper(scanner, 'nmap -Pn -sV -p 22 10.0.0.2');

    const vu = await relire(cible, '/tmp/sv.pcap');
    expect(vu).toMatch(/Flags \[S\]|\[S\]|SYN/);
  });

  it('la version rendue est celle des OCTETS captures sur le fil', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo systemctl start ssh');
    await capturer(cible, '/tmp/sv.pcap');

    const sortie = await taper(scanner, 'nmap -Pn -sV -p 22 10.0.0.2');
    const capture = await taper(cible, 'sudo tcpdump -r /tmp/sv.pcap -A');

    // Ce que le serveur a REELLEMENT annonce, lu dans la capture, doit se
    // retrouver dans ce que `nmap` rapporte : sans ce lien, une table de
    // services indexee par numero de port donnerait la meme sortie.
    const annonce = /SSH-[\d.]+-(\S+)/.exec(capture);
    expect(annonce).not.toBeNull();
    expect(sortie).toContain(annonce![1]);
  });

  it('un port ouvert par AUCUN service ne recoit pas de version inventee', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sV -p 8888 10.0.0.2');

    expect(sortie).toMatch(/8888\/tcp\s+closed/);
    expect(sortie).not.toMatch(/8888\/tcp\s+open/);
  });

  it('TEMOIN: la version rendue est celle du service', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo systemctl start ssh');

    const sortie = await taper(scanner, 'nmap -Pn -sV -p 22 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh\s+\S/);
  });

  it('le serveur PARLE le premier, et ses octets sont sur le fil', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo systemctl start ssh');
    await capturer(cible, '/tmp/nc.pcap');

    const sortie = await taper(scanner, 'nc -v 10.0.0.2 22');

    const vu = await taper(cible, 'sudo tcpdump -r /tmp/nc.pcap -A');
    // La salutation ne peut pas venir de l'objet : elle est dans la
    // capture, portee par un segment dont la longueur n'est pas nulle.
    expect(vu).toMatch(/SSH-2\.0-/);
    expect(vu).toMatch(/length (?!0\b)\d+/);
    expect(sortie).toMatch(/SSH-2\.0-/);
  });
});

describe('un balayage UDP lit l ICMP, il ne lit pas l objet distant', () => {
  it('un port UDP ferme est conclu CLOS par un port-unreachable RECU', async () => {
    const { scanner, cible } = await segment();
    await capturer(scanner, '/tmp/udp.pcap');

    const sortie = await taper(scanner, 'nmap -Pn -sU -p 9999 10.0.0.2');

    const vu = await relire(scanner, '/tmp/udp.pcap');
    expect(vu).toMatch(/unreachable|ICMP|icmp/);
    expect(sortie).toMatch(/9999\/udp\s+closed/);
  });

  it('une cible qui n emet aucun ICMP laisse le port en open|filtered', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo iptables -A OUTPUT -p icmp -j DROP');

    const sortie = await taper(scanner, 'nmap -Pn -sU -p 9999 10.0.0.2');

    expect(sortie).toMatch(/9999\/udp\s+open\|filtered/);
  });
});

describe('la conjecture de systeme ne LIT pas le type de l objet', () => {
  it('elle se deduit d un fait observable sur le fil', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo systemctl start ssh');

    const sortie = await taper(scanner, 'nmap -Pn -O -p 22 10.0.0.2');

    expect(sortie).toMatch(/Linux/);
  });
});
