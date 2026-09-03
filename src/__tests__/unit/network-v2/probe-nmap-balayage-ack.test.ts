/**
 * `nmap -sA` EMET un ACK nu et LIT le RST.
 *
 * Ecrit A L'AVEUGLE. Dernier des trois chemins de `nmap` qui inspectaient
 * l'objet de la cible : `ackReaches()` appelait `transitAckAclVerdict`,
 * qui evalue les listes de controle par PARCOURS DE TOPOLOGIE. Aucune
 * trame ne portait cette reponse, et le verdict d'un scanner tire de la
 * configuration de sa cible n'est pas une mesure.
 *
 * Reference : `nmap/nmap`, `scan_engine_raw.cc`. Ce que le balayage ACK
 * mesure n'est PAS l'ecoute — c'est le FILTRAGE. RFC 9293 §3.10.7.1 fait
 * repondre RST a un ACK ne correspondant a aucune connexion, que le port
 * soit ouvert ou ferme ; un RST prouve donc seulement que le segment a
 * ATTEINT l'hote. D'ou les deux seuls verdicts possibles : `unfiltered`
 * (RST recu) et `filtered` (silence). C'est le point a ne pas rater : un
 * port OUVERT et un port FERME rendent tous deux `unfiltered`, et un test
 * qui attendrait `open` sur le port 22 encoderait un contresens.
 *
 * La mesure porte sur le FIL : `tcpdump` sur la cible doit montrer le
 * segment ACK arriver, puis le RST repartir.
 *
 * Discrimination, en rendant a `ackReaches` son parcours de topologie :
 * 2 cas tombent — celui qui observe la capture (rien n'etait emis) et
 * celui de la cible qui jette tout (`transitAckAclVerdict` juge les listes
 * de controle de TRANSIT, pas le netfilter de la machine visee, donc il
 * repondait `unfiltered` sur un port qui ne repond jamais). Les 3 autres
 * passent des deux cotes et sont nommes ici plutot que laisses a
 * decouvrir : le cas `unfiltered`, que le parcours de topologie rendait
 * juste par accident ; le cas sans route, ou `findHostByAddress` ne
 * trouvait rien et rendait donc `filtered` pour une raison etrangere au
 * filtrage ; et le TEMOIN du balayage ordinaire, dont c'est l'objet de
 * passer des deux cotes.
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

  return { sw, scanner, cible };
}

describe('le balayage ACK mesure le FILTRAGE', () => {
  it('un port joignable est `unfiltered`, qu il soit ouvert ou ferme', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo systemctl start ssh');

    const sortie = await taper(scanner, 'nmap -Pn -sA -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+unfiltered/);
    expect(sortie).toMatch(/8888\/tcp\s+unfiltered/);
    expect(sortie).not.toMatch(/22\/tcp\s+open/);
  });

  it('l ACK ARRIVE chez la cible et le RST en repart', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo tcpdump -i eth0 -w /tmp/ack.pcap &');

    await taper(scanner, 'nmap -Pn -sA -p 4242 10.0.0.2');

    const vu = await taper(cible, 'sudo tcpdump -r /tmp/ack.pcap -nn');
    expect(vu).toMatch(/10\.0\.0\.1\.\d+ > 10\.0\.0\.2\.4242: Flags \[\.\]/);
    expect(vu).toMatch(/10\.0\.0\.2\.4242 > 10\.0\.0\.1\.\d+: Flags \[R/);
  });

  it('une cible qui jette tout est `filtered`', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo iptables -A INPUT -p tcp -j DROP');

    const sortie = await taper(scanner, 'nmap -Pn -sA -p 4242 10.0.0.2');

    expect(sortie).toMatch(/4242\/tcp\s+filtered/);
  });

  it('une adresse sans route est `filtered`, aucun segment n etant emis', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sA -p 22 203.0.113.7');

    expect(sortie).toMatch(/22\/tcp\s+filtered/);
  });

  it('TEMOIN: le balayage ordinaire distingue encore ouvert et ferme', async () => {
    const { scanner, cible } = await segment();
    await taper(cible, 'sudo systemctl start ssh');

    const sortie = await taper(scanner, 'nmap -Pn -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open/);
    expect(sortie).toMatch(/8888\/tcp\s+closed/);
  });
});
