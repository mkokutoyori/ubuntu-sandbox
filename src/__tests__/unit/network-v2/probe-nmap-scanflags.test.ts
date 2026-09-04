/**
 * `--scanflags` : le moteur existait, il lui manquait la porte.
 *
 * Ecrit A L'AVEUGLE. `TcpStack.scanProbe(ip, port, flags)` prend DEJA des
 * drapeaux quelconques, et `readStatelessReply(kind, reponse)` sait deja
 * lire une reponse selon le balayage de base. Ce qui manquait n'etait
 * donc ni l'emission ni la lecture, mais l'option qui les relie —
 * l'option qui laisse composer soi-meme le segment.
 *
 * Reference : `nmap/nmap`. `parse_scanflags` (`nmap.cc:162`) accepte un
 * NOMBRE de 0 a 255, ou un amalgame de noms — FIN, SYN, RST, PSH, ACK,
 * URG, plus ECE, CWR, ALL et NONE que le code connait et que la page de
 * manuel ne cite pas — dans un ordre indifferent, et rend -1 sinon, d'ou
 * le `fatal()` de la ligne 732 dont le texte est repris ici mot pour mot.
 *
 * La regle qui compte, et qui ne se devine pas : **les drapeaux viennent
 * de l'option, la LECTURE vient du balayage de base**. Le manuel :
 * « That base type tells Nmap how to interpret responses. For example, a
 * SYN scan considers no-response to indicate a filtered port, while a FIN
 * scan treats the same as open|filtered. […] If you don't specify a base
 * type, SYN scan is used. » Donc `--scanflags FIN` SEUL n'est PAS `-sF` :
 * il emet le meme segment et rend `filtered` la ou `-sF` rend
 * `open|filtered`. C'est le cas central de cette sonde.
 *
 * `-sT` ignore l'option, et c'est le code qui le dit :
 * `scan_engine.cc:1287` force `TH_SYN` pour `CONNECT_SCAN` AVANT meme de
 * regarder `o.scanflags` — un balayage connecte passe par la pile du
 * systeme, qui ne laisse composer aucun segment.
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

describe('les drapeaux viennent de l option, la LECTURE du balayage de base', () => {
  it('`--scanflags FIN` seul lit comme un `-sS`, pas comme un `-sF`', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn --scanflags FIN -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+filtered/);
    expect(sortie).toMatch(/8888\/tcp\s+closed/);
  });

  it('TEMOIN: le meme segment sous `-sF` rend `open|filtered`', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sF -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\|filtered/);
  });

  it('`-sF --scanflags FIN` retrouve la lecture du balayage FIN', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sF --scanflags FIN -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\|filtered/);
    expect(sortie).toMatch(/8888\/tcp\s+closed/);
  });

  it('`--scanflags SYN` ouvre le port ouvert', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn --scanflags SYN -p 22 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh/);
  });
});

describe('la valeur s ecrit en nombre comme en noms', () => {
  it('la forme NUMERIQUE est acceptee', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn --scanflags 2 -p 22 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh/);
  });

  it('l ordre des noms est indifferent', async () => {
    const { scanner } = await segment();

    const a = await taper(scanner, 'nmap -Pn -sX --scanflags FINPSHURG -p 8888 10.0.0.2');
    const b = await taper(scanner, 'nmap -Pn -sX --scanflags URGFINPSH -p 8888 10.0.0.2');

    expect(a).toMatch(/8888\/tcp\s+closed/);
    expect(b).toMatch(/8888\/tcp\s+closed/);
  });

  it('une valeur invalide est refusee dans les mots de nmap', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn --scanflags 300 -p 22 10.0.0.2');

    expect(sortie).toContain(
      '--scanflags option must be a number between 0 and 255 (inclusive) or a string like "URGPSHFIN".');
    expect(sortie).not.toContain('Nmap scan report');
  });
});

describe('ce qui part sur le fil porte VRAIMENT ces drapeaux', () => {
  it('`--scanflags FINPSHURG` emet un segment FIN+PSH+URG', async () => {
    const { scanner, cible } = await segment();
    await taper(scanner, 'ping -c 1 10.0.0.2');
    await taper(cible, 'sudo tcpdump -i eth0 -w /tmp/sf.pcap &');

    await taper(scanner, 'nmap -Pn --scanflags FINPSHURG -p 8888 10.0.0.2');

    const vu = await taper(cible, 'sudo tcpdump -r /tmp/sf.pcap -nn');
    expect(vu).toMatch(/10\.0\.0\.1\.\d+ > 10\.0\.0\.2\.8888: Flags \[FPU\]/);
  });

  it('`--scanflags SYNFIN` emet les DEUX bits ensemble', async () => {
    const { scanner, cible } = await segment();
    await taper(scanner, 'ping -c 1 10.0.0.2');
    await taper(cible, 'sudo tcpdump -i eth0 -w /tmp/sf2.pcap &');

    await taper(scanner, 'nmap -Pn --scanflags SYNFIN -p 8888 10.0.0.2');

    const vu = await taper(cible, 'sudo tcpdump -r /tmp/sf2.pcap -nn');
    expect(vu).toMatch(/> 10\.0\.0\.2\.8888: Flags \[FS\]/);
  });
});

describe('les temoins', () => {
  it('TEMOIN: `-sT` ignore l option, comme sur une vraie machine', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sT --scanflags FIN -p 22 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+open\s+ssh/);
  });

  it('TEMOIN: sans l option, chaque balayage garde ses drapeaux', async () => {
    const { scanner } = await segment();

    const sortie = await taper(scanner, 'nmap -Pn -sA -p 22,8888 10.0.0.2');

    expect(sortie).toMatch(/22\/tcp\s+unfiltered/);
    expect(sortie).toMatch(/8888\/tcp\s+unfiltered/);
  });
});
