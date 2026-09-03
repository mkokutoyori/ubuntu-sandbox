/**
 * Il n'y a qu'UN `tcpdump`, et il lit le FIL.
 *
 * Mesure de depart, faite en cherchant un instrument pour eprouver
 * `nmap` : `tcpdump -i eth0 -c 2 icmp` au premier plan capture
 * parfaitement les deux echos d'un `ping`, avec le decodage Ethernet
 * complet — cette moitie-la n'a jamais eu de defaut. Mais
 * `tcpdump -i eth0 -w f &` suivi d'un `ping` puis d'un
 * `tcpdump -r f` rendait `0 packets captured`, alors qu'une prise
 * posee sur le port de la meme machine au meme instant voyait bel et
 * bien passer huit trames. Le meme `-w` en arriere-plan pendant un
 * balayage TCP, lui, ecrivait sept paquets.
 *
 * La cause n'etait pas dans la capture : il y avait DEUX `tcpdump`.
 * Le moderne (`commands/net/Tcpdump.ts` -> `TcpdumpRunner`) lit la
 * prise du port, donc tout le trafic ; l'ancien, un `case 'tcpdump'`
 * de `LinuxCommandExecutor`, lisait `captureLog`, un journal qui ne
 * retient QUE du TCP. D'ou l'asymetrie exacte qu'on observait — le TCP
 * paraissait, le reste non — et d'ou un fichier de capture vide pour
 * un laboratoire ICMP, sans un mot pour le dire.
 *
 * Deux ecritures d'un meme fait finissent toujours par diverger ; ici
 * la copie divergente etait AUSSI la plus pauvre, et c'est elle qui
 * servait le chemin `-w`. Elle est supprimee, avec la machinerie de
 * reecriture (`tcpdumpWriteTargets`) qui n'existait que pour compenser
 * sa pauvrete.
 *
 * Reference : `tcpdump` sans `-c` appelle `pcap_loop(pd, -1, ...)`,
 * donc il capture jusqu'a interruption et son fichier GROSSIT au fil
 * des paquets. Une capture detachee ne s'arrete donc plus au bout d'une
 * fenetre de 200 ms et ecrit a chaque trame.
 *
 * Le TEMOIN est la capture au PREMIER PLAN, qui fonctionnait deja : un
 * correctif qui l'aurait cassee en reparant l'arriere-plan serait pire
 * que le defaut.
 *
 * Discrimination, en deux moities mesurees separement parce qu'un seul
 * `git stash` ne les separe pas. En retirant la seule modification du
 * COUREUR (capture detachee qui dure, ecriture a chaque trame), 2 cas
 * tombent — exactement les deux qui observent une capture d'arriere-plan
 * — et les temoins tiennent. La suppression du DOUBLON, elle, a ete
 * mesuree directement plutot que par `stash` : le meme laboratoire
 * rendait `0 packets captured` avant et huit paquets apres, et stasher
 * son fichier retirerait aussi `runsDetached`, ce qui casse la commande
 * entiere au lieu de discriminer.
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
  const a = new LinuxPC('linux-pc', 'A', 0, 0);
  const b = new LinuxServer('linux-server', 'B', 200, 0);
  a.powerOn(); b.powerOn();
  new Cable('c1').connect(a.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(b.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  await taper(a, 'ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0');
  await taper(b, 'ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0');
  return { a, b };
}

describe('une capture en arriere-plan retient ce qui passe', () => {
  it('`-w` en arriere-plan ecrit l ICMP d un ping', async () => {
    const { a, b } = await segment();
    await taper(b, 'sudo tcpdump -i eth0 -w /tmp/icmp.pcap &');

    await taper(a, 'ping -c 1 10.0.0.2');

    const relu = await taper(b, 'sudo tcpdump -r /tmp/icmp.pcap -nn');
    expect(relu).toMatch(/ICMP echo request/);
    expect(relu).toMatch(/ICMP echo reply/);
    expect(relu).not.toMatch(/^0 packets captured/m);
  });

  it('le fichier GROSSIT au fil des paquets, sans attendre un kill', async () => {
    const { a, b } = await segment();
    await taper(b, 'sudo tcpdump -i eth0 -w /tmp/grow.pcap &');

    await taper(a, 'ping -c 1 10.0.0.2');
    const apresUn = await taper(b, 'sudo tcpdump -r /tmp/grow.pcap -nn icmp');
    await taper(a, 'ping -c 1 10.0.0.2');
    const apresDeux = await taper(b, 'sudo tcpdump -r /tmp/grow.pcap -nn icmp');

    const compter = (s: string) => (s.match(/ICMP echo/g) ?? []).length;
    expect(compter(apresDeux)).toBeGreaterThan(compter(apresUn));
  });

  it('`-w` en arriere-plan retient AUSSI le TCP', async () => {
    const { a, b } = await segment();
    await taper(b, 'sudo systemctl start ssh');
    await taper(b, 'sudo tcpdump -i eth0 -w /tmp/tcp.pcap &');

    await taper(a, 'nmap -Pn -p 22 10.0.0.2');

    const relu = await taper(b, 'sudo tcpdump -r /tmp/tcp.pcap -nn');
    expect(relu).toMatch(/\.22\b/);
  });
});

describe('ce qui fonctionnait continue de fonctionner', () => {
  it('TEMOIN: la capture au premier plan decode toujours l ICMP', async () => {
    const { a, b } = await segment();
    const live = b.executeCommand('tcpdump -i eth0 -c 2 -nn icmp');

    await taper(a, 'ping -c 2 10.0.0.2');

    const vu = await live;
    expect(vu).toMatch(/ICMP echo request/);
    expect(vu).toMatch(/2 packets captured/);
  });

  it('TEMOIN: `-e` rend toujours les adresses de couche lien', async () => {
    const { a, b } = await segment();
    const live = b.executeCommand('tcpdump -i eth0 -c 1 -nn -e icmp');

    await taper(a, 'ping -c 1 10.0.0.2');

    expect(await live).toMatch(/ethertype IPv4 \(0x0800\)/);
  });
});
