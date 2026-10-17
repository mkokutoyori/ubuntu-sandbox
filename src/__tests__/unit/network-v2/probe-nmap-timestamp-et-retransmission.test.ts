/**
 * Deux ecarts de `nmap` mesures sur le lab d'Akwa (ACL 100 : `permit icmp any any` comptait une
 * correspondance par decouverte, `permit udp ... log` comptait exactement une par port), fermes
 * ici contre le CODE de nmap et celui de tcpdump, joignables :
 *
 * 1. `nmap.h` : la decouverte par defaut d'un nmap prive est `-PE -PS443 -PA80 -PP`. La requete
 *    ICMP timestamp (type 13) n'etait ni envoyee ni acceptee (`-PP` etait refuse). Un hote Linux y
 *    repond (type 14, RFC 792), un Windows moderne se tait ; tcpdump l'ecrit comme
 *    `print-icmp.c` : « time stamp query id N seq M » et « time stamp reply ... org, recv, xmit ».
 *    Les mots-cles ACL `timestamp-request` / `timestamp-reply` etaient acceptes par l'analyseur et
 *    jamais evalues ; ils le sont, puisque le type existe.
 * 2. `scan_engine.cc` : `allowedTryno = MAX(1, max_successful_tryno + 1)`, les numeros d'essai
 *    partant de zero. Tant que les ports qui repondent le font du premier coup, un port muet recoit
 *    DEUX sondes, et un balayage a leurres emet ses sondes une seconde fois. Etait sonde une fois.
 *
 * Discrimination (git stash du code, tests gardes) : six des neuf cas tombent avant les correctifs
 * (pas de type 13, `-PP` refuse, une seule sonde par port muet) ; les trois temoins — le port ferme,
 * le port ouvert et le balayage connecte ne recoivent pas de retransmission de nmap — passent des
 * deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
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
  const linux = new LinuxServer('linux-server', 'LINUX', 200, 0);
  const windows = new WindowsPC('windows-pc', 'WIN', 400, 0);
  scanner.powerOn(); linux.powerOn(); windows.powerOn();
  new Cable('c1').connect(scanner.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(linux.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('c3').connect(windows.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);
  await taper(scanner, 'ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0');
  await taper(linux, 'ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0', 'sudo systemctl start ssh');
  await windows.executeCmdCommand('netsh interface ip set address "Ethernet 0" static 10.0.0.3 255.255.255.0');
  return { scanner, linux, windows };
}

const lines = (capture: string, pattern: RegExp): string[] => capture.split('\n').filter((l) => pattern.test(l));

describe('la decouverte par defaut envoie la requete ICMP timestamp', () => {
  it('temoin : l echo part toujours, et une cible Linux repond au type 13 comme au type 8', async () => {
    const { scanner, linux } = await segment();
    await taper(linux, 'tcpdump -nn -i eth0 icmp -w d.pcap &');

    const rapport = await taper(scanner, 'sudo nmap -sn --disable-arp-ping --reason 10.0.0.2');
    const capture = await taper(linux, 'tcpdump -r d.pcap -nn');

    expect(rapport).toContain('received echo-reply');
    expect(lines(capture, /ICMP echo request/)).toHaveLength(1);
    expect(lines(capture, /ICMP time stamp query id \d+ seq \d+, length 20/)).toHaveLength(1);
    expect(lines(capture, /ICMP time stamp reply id \d+ seq \d+: org \d\d:\d\d:\d\d\.\d{3}, recv \d\d:\d\d:\d\d\.\d{3}, xmit \d\d:\d\d:\d\d\.\d{3}, length 20/)).toHaveLength(1);
  });

  it('-PP seul est accepte, et c est le timestamp-reply qui prouve que l hote est la', async () => {
    const { scanner } = await segment();

    const rapport = await taper(scanner, 'sudo nmap -sn --disable-arp-ping -PP --reason 10.0.0.2');

    expect(rapport).toContain('Host is up, received timestamp-reply');
    expect(rapport).not.toContain('this simulator cannot');
  });

  it('un Windows ne repond pas au type 13 : la requete part, aucune reponse ne revient, l hote reste vu par l echo', async () => {
    const { scanner } = await segment();
    await taper(scanner, 'sudo tcpdump -nn -i eth0 icmp -w w.pcap &');

    const rapport = await taper(scanner, 'sudo nmap -sn --disable-arp-ping --reason 10.0.0.3');
    const capture = await taper(scanner, 'sudo tcpdump -r w.pcap -nn');

    expect(rapport).toContain('received echo-reply');
    expect(lines(capture, /> 10\.0\.0\.3: ICMP time stamp query/)).toHaveLength(1);
    expect(lines(capture, /10\.0\.0\.3 > .*time stamp reply/)).toHaveLength(0);
  });

  it('un utilisateur non prive recoit l avertissement de nmap et aucune requete ICMP ne part', async () => {
    const { scanner } = await segment();
    await taper(scanner, 'sudo tcpdump -nn -i eth0 icmp -w u.pcap &');

    const rapport = await taper(scanner, 'nmap -sn --disable-arp-ping -PP 10.0.0.2');
    const capture = await taper(scanner, 'sudo tcpdump -r u.pcap -nn');

    expect(capture).toContain('reading from file');
    expect(rapport).toContain('You are not root -- using TCP pingscan rather than ICMP');
    expect(lines(capture, /time stamp query/)).toHaveLength(0);
  });
});

describe('un port muet recoit deux sondes, un port qui repond une seule', () => {
  async function sondes(commande: string, filtre: string, regle: string) {
    const { scanner, linux } = await segment();
    await taper(linux, regle);
    await taper(linux, `tcpdump -nn -i eth0 ${filtre} -w r.pcap &`);
    const rapport = await taper(scanner, `sudo ${commande}`);
    const capture = await taper(linux, 'tcpdump -r r.pcap -nn');
    return { rapport, capture };
  }

  it('UDP : le port filtre est sonde deux fois et se lit open|filtered', async () => {
    const { rapport, capture } = await sondes(
      'nmap -Pn -sU -p 40000 10.0.0.2', 'udp port 40000', 'iptables -A INPUT -p udp --dport 40000 -j DROP');

    expect(lines(capture, /10\.0\.0\.1\.\d+ > 10\.0\.0\.2\.40000: UDP/)).toHaveLength(2);
    expect(rapport).toMatch(/40000\/udp\s+open\|filtered/);
  });

  it('temoin UDP : le port ferme, qui repond par un port unreachable, n est sonde qu une fois', async () => {
    const { rapport, capture } = await sondes(
      'nmap -Pn -sU -p 40001 10.0.0.2', 'udp port 40001', 'true');

    expect(lines(capture, /10\.0\.0\.1\.\d+ > 10\.0\.0\.2\.40001: UDP/)).toHaveLength(1);
    expect(rapport).toMatch(/40001\/udp\s+closed/);
  });

  it('SYN : le port filtre est sonde deux fois', async () => {
    const { rapport, capture } = await sondes(
      'nmap -Pn -sS -p 81 10.0.0.2', 'tcp port 81', 'iptables -A INPUT -p tcp --dport 81 -j DROP');

    expect(lines(capture, /> 10\.0\.0\.2\.81: Flags \[S\]/)).toHaveLength(2);
    expect(rapport).toMatch(/81\/tcp\s+filtered/);
  });

  it('temoin SYN : le port ouvert n est sonde qu une fois', async () => {
    const { rapport, capture } = await sondes('nmap -Pn -sS -p 22 10.0.0.2', 'tcp port 22', 'true');

    expect(lines(capture, /> 10\.0\.0\.2\.22: Flags \[S\]/)).toHaveLength(1);
    expect(rapport).toMatch(/22\/tcp\s+open/);
  });

  it('temoin connect : un balayage connecte ne retransmet pas, le systeme s en charge', async () => {
    const { capture } = await sondes(
      'nmap -Pn -sT -p 81 10.0.0.2', 'tcp port 81', 'iptables -A INPUT -p tcp --dport 81 -j DROP');

    expect(lines(capture, /> 10\.0\.0\.2\.81: Flags \[S\]/).length).toBeLessThanOrEqual(2);
  });
});
