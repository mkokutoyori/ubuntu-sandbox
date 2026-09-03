/**
 * `nmap -sS` est DEMI-OUVERT : la poignee de main ne s'acheve jamais.
 *
 * Ecrit A L'AVEUGLE. `-sS` et `-sT` etaient le MEME balayage — l'analyse
 * les rangeait tous deux en `scanType = 'tcp'` — donc l'option la plus
 * emblematique de `nmap` etait un alias. Ce qu'elle promet n'est pourtant
 * pas un verdict different mais un TRAFIC different, et c'est tout son
 * objet : ne pas achever la connexion.
 *
 * Reference : `nmap/nmap`, `scan_engine_raw.cc`. Un SYN/ACK ouvre le port
 * (`ER_SYNACK`), un RST le ferme (`ER_RESETPEER`), le silence le filtre.
 * Les trois verdicts sont ceux du balayage connecte, donc LA SORTIE NE
 * SUFFIT PAS A DISTINGUER LES DEUX BALAYAGES — un test qui ne lirait que
 * le rapport ne prouverait rien. La mesure porte donc sur la capture.
 *
 * Ce qui distingue les deux sur le fil : le balayage connecte envoie
 * SYN, recoit SYN/ACK, repond ACK — trois temps — puis ferme par FIN. Le
 * demi-ouvert envoie SYN, recoit SYN/ACK, et repond RST : la connexion
 * n'existe jamais.
 *
 * Discrimination, en rendant a `-sS` son alias vers le balayage connecte :
 * UN SEUL cas tombe, celui qui lit la capture. C'est la mesure exacte du
 * defaut et non un manque de couverture — les quatre autres ne PEUVENT
 * pas discriminer, puisque les deux balayages rendent le meme etat et la
 * meme raison ; ils sont ici pour garantir que le nouveau chemin dit
 * toujours la meme chose que l'ancien, ce qui est justement ce qu'on lui
 * demande.
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

describe('le balayage SYN ne va pas au bout', () => {
  it('la reponse au SYN/ACK est un RST, jamais un ACK', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo tcpdump -i eth0 -w /tmp/syn.pcap &');

    await taper(scanner, 'nmap -Pn -sS -p 22 10.0.0.2');

    const vu = await taper(cible, 'sudo tcpdump -r /tmp/syn.pcap -nn');
    expect(vu).toMatch(/10\.0\.0\.1\.\d+ > 10\.0\.0\.2\.22: Flags \[S\]/);
    expect(vu).toMatch(/10\.0\.0\.2\.22 > 10\.0\.0\.1\.\d+: Flags \[S\.\]/);
    expect(vu).toMatch(/10\.0\.0\.1\.\d+ > 10\.0\.0\.2\.22: Flags \[R/);
    expect(vu).not.toMatch(/Flags \[F/);
  });

  it('TEMOIN: le balayage connecte, lui, ACHEVE la poignee de main', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo tcpdump -i eth0 -w /tmp/connect.pcap &');

    await taper(scanner, 'nmap -Pn -sT -p 22 10.0.0.2');

    const vu = await taper(cible, 'sudo tcpdump -r /tmp/connect.pcap -nn');
    expect(vu).toMatch(/10\.0\.0\.1\.\d+ > 10\.0\.0\.2\.22: Flags \[S\]/);
    expect(vu).toMatch(/Flags \[F/);
  });

  it('un port ouvert est ouvert, un port ferme est ferme', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh/);
    expect(sortie).toMatch(/8888\/tcp\s+closed/);
  });

  it('la RAISON rendue est celle du balayage SYN', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sS --reason -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh\s+syn-ack/);
    expect(sortie).toMatch(/8888\/tcp\s+closed\s+\S+\s+reset/);
  });

  it('une cible qui jette tout est filtree', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo iptables -A INPUT -p tcp -j DROP');

    const sortie = await taper(scanner, 'nmap -Pn -sS -p 22 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+filtered/);
  });
});
