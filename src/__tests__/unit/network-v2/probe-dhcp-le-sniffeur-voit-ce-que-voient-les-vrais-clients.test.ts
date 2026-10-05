/*
 * Ce que le sniffeur d'un LAN voit quand un poste Linux et un poste Windows
 * prennent leur adresse par DHCP aupres d'un FortiGate, d'un routeur Cisco,
 * d'un Windows Server et d'un routeur Huawei.
 *
 * Mesure de depart : un concentrateur, trois postes (L1 Linux, W1 Windows,
 * SNIFF Linux qui lance `tcpdump -i eth0 -nn -e -vv`) et chacun des quatre
 * serveurs tour a tour. Sur le fil :
 *  - AUCUN poste ne portait l'option 61 (identifiant du client) ni l'option 55
 *    (liste des parametres demandes), que dhclient et Windows emettent
 *    toujours ; la RELEASE n'avait pas l'option 61 non plus ;
 *  - l'option 81 (FQDN du client, RFC 4702) sortait avec `length 0` — le
 *    codeur de paquet n'avait pas de forme pour elle, et tcpdump l'affichait
 *    comme une option vide, donc invalide (la RFC en veut 3 au moins) — et
 *    c'etait le poste LINUX qui l'emettait aussi, alors que dhclient ne le
 *    fait pas ;
 *  - TOUS les paquets DHCP, quel que soit l'emetteur, portaient `ttl 64` et
 *    le drapeau DF : un Windows ecrivait 64 alors que son ping repond a 128,
 *    un routeur Cisco ou Huawei 64 alors que le sien repond a 255 ; le DF
 *    n'est pas pose sur du DHCP ;
 *  - `ipconfig /renew` ecrivait des lignes qui n'existent pas (« DHCP Offer
 *    received from … », « DHCP ACK received ») et RE-DIFFUSAIT une requete
 *    d'un poste qui tenait deja son bail, la ou Windows renouvelle en
 *    unicast aupres de son serveur ; sur une carte sans cable il inventait
 *    une adresse 169.254 ; `ipconfig /release` ecrivait « All adapters have
 *    been successfully released. » ;
 *  - `ip route` ecrivait `metric 0` sur la route connectee, ce que le noyau
 *    n'ecrit jamais ;
 *  - `dhclient -v` ecrivait des lignes « INIT state » qui ne sont pas de
 *    dhclient, « DHCPREQUEST of » au lieu de « DHCPREQUEST for », n'avait ni
 *    l'en-tete de copyright, ni `Sending on   Socket/fallback`, ni le
 *    `(xid=0x…)` des lignes d'envoi ; `dhclient -r` ecrivait « released x »
 *    sans `-v`, alors que dhclient se tait ;
 *  - une etendue Windows Server sans duree explicite offrait 1 jour, la ou
 *    Windows en offre 8.
 *
 * L'AUTORITE : les transcriptions de dhclient 4.4.1 d'Ubuntu et de la pile
 * Windows 10, LUES DE MEMOIRE (aucune capture atteignable d'ici), plus les
 * RFC 2131, 2132 et 4702 ; la liste des options demandees de dhclient vient
 * du `dhclient.conf` livre par Ubuntu (13 codes), celle de Windows de ses 14
 * codes croissants. `tos 0x10`, `ttl 128` et l'absence de DF sur les paquets
 * de dhclient sont la memoire de traces reelles (common/packet.c de ISC).
 * Les TTL des serveurs sont ceux que chaque systeme met deja a ses reponses
 * ICMP.
 *
 * Ecrite a l'aveugle. 32 des 36 cas tombent avant (git stash push -- src/network).
 * Les 4 qui passent des deux cotes sont les TEMOINS « les deux postes
 * prennent une adresse et le sniffeur voit les quatre messages », un par
 * serveur : ils prouvent que chaque laboratoire est sain et que l'echange
 * nominal n'a pas bouge.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Hub } from '@/network/devices/Hub';
import { Cable } from '@/network/hardware/Cable';
import type { Port } from '@/network/hardware/Port';
import { DHCPPacket } from '@/network/dhcp/DHCPPacket';
import {
  resetCounters, MACAddress, IPAddress, SubnetMask, ETHERTYPE_IPV4,
  type IPv4Packet, type UDPPacket,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Terminal { executeCommand(command: string): Promise<string> }

async function type(device: Terminal, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

type ServerKind = 'FortiGate' | 'Cisco router' | 'Windows Server' | 'Huawei router';

const SERVER_TTL: Readonly<Record<ServerKind, number>> = {
  'FortiGate': 64, 'Cisco router': 255, 'Windows Server': 128, 'Huawei router': 255,
};

async function server(kind: ServerKind): Promise<Port> {
  if (kind === 'FortiGate') {
    const firewall = new FortiGate('firewall-fortinet', 'FGT');
    await type(firewall, [
      'config system interface', 'edit port2', 'set mode static', 'set ip 10.0.0.1 255.255.255.0', 'next', 'end',
      'config system dhcp server', 'edit 1', 'set interface "port2"', 'set default-gateway 10.0.0.1',
      'set netmask 255.255.255.0', 'set dns-server1 10.0.0.1', 'config ip-range', 'edit 1',
      'set start-ip 10.0.0.100', 'set end-ip 10.0.0.110', 'next', 'end', 'next', 'end',
    ]);
    return firewall.getPort('port2')!;
  }
  if (kind === 'Cisco router') {
    const router = new CiscoRouter('R1');
    await type(router, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0',
      'no shutdown', 'exit', 'ip dhcp pool P', 'network 10.0.0.0 255.255.255.0', 'default-router 10.0.0.1',
      'dns-server 10.0.0.1', 'exit', 'end',
    ]);
    return router.getPort('GigabitEthernet0/0')!;
  }
  if (kind === 'Windows Server') {
    const windows = new WindowsServer('SRV');
    windows.setCurrentUser('Administrator');
    windows.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    const shell = PowerShellSubShell.create(windows).subShell;
    for (const line of [
      'Install-WindowsFeature -Name DHCP -IncludeManagementTools',
      'Add-DhcpServerv4Scope -Name "LAN" -StartRange 10.0.0.100 -EndRange 10.0.0.110 -SubnetMask 255.255.255.0 -State Active',
      'Set-DhcpServerv4OptionValue -ScopeId 10.0.0.0 -Router 10.0.0.1 -DnsServer 10.0.0.1',
    ]) await shell.processLine(line);
    return windows.getPorts()[0];
  }
  const huawei = new HuaweiRouter('R1');
  await type(huawei, [
    'system-view', 'dhcp enable', 'interface GigabitEthernet0/0/0', 'ip address 10.0.0.1 255.255.255.0',
    'undo shutdown', 'dhcp select interface', 'dhcp server dns-list 10.0.0.1', 'quit', 'return',
  ]);
  return huawei.getPort('GE0/0/0')!;
}

interface Seen {
  readonly direction: 'in' | 'out';
  readonly packet: DHCPPacket;
  readonly ip: IPv4Packet;
  readonly dstMac: string;
}

function record(port: Port): Seen[] {
  const seen: Seen[] = [];
  port.attachTap(({ direction, frame }) => {
    if (frame.etherType !== ETHERTYPE_IPV4) return;
    const ip = frame.payload as IPv4Packet;
    const udp = ip.payload as UDPPacket | undefined;
    if (udp?.type !== 'udp' || !(udp.payload instanceof DHCPPacket)) return;
    seen.push({ direction, packet: udp.payload, ip, dstMac: frame.dstMAC.toString() });
  });
  return seen;
}

interface Lan {
  readonly linux: LinuxPC;
  readonly windows: WindowsPC;
  readonly sniffer: LinuxPC;
  readonly onWire: Seen[];
  readonly powershell: (line: string) => Promise<string>;
}

async function lan(kind: ServerKind): Promise<Lan> {
  const hub = new Hub('HUB', 8);
  const serverPort = await server(kind);
  const linux = new LinuxPC('linux-pc', 'L1');
  const sniffer = new LinuxPC('linux-pc', 'SNIFF');
  const windows = new WindowsPC('windows-pc', 'W1');
  new Cable('server').connect(serverPort, hub.getPorts()[0]);
  new Cable('linux').connect(linux.getPort('eth0')!, hub.getPorts()[1]);
  new Cable('sniffer').connect(sniffer.getPort('eth0')!, hub.getPorts()[2]);
  new Cable('windows').connect(windows.getPorts()[0], hub.getPorts()[3]);
  await type(linux, ['ip link set eth0 up']);
  await type(sniffer, ['ip link set eth0 up', 'ip addr add 10.0.0.50/24 dev eth0']);
  const onWire = record(sniffer.getPort('eth0')!);
  const shell = PowerShellSubShell.create(windows).subShell;
  return { linux, windows, sniffer, onWire, powershell: async line => (await shell.processLine(line)).output.join('\n') };
}

const messageOf = (entry: Seen): string => entry.packet.getMessageType() ?? '?';
const from = (seen: readonly Seen[], mac: string, ...kinds: string[]): Seen[] =>
  seen.filter(entry => entry.packet.chaddr.toLowerCase() === mac.toLowerCase() && kinds.includes(messageOf(entry)));
const macOf = (host: LinuxPC | WindowsPC): string =>
  host instanceof LinuxPC ? host.getPort('eth0')!.getMAC().toString() : host.getPorts()[0].getMAC().toString();
const requestsOf = (seen: readonly Seen[], mac: string): Seen[] =>
  from(seen, mac, 'DHCPDISCOVER', 'DHCPREQUEST').filter(entry => entry.packet.op === 1);

const SERVERS: readonly ServerKind[] = ['FortiGate', 'Cisco router', 'Windows Server', 'Huawei router'];

describe.each(SERVERS)('a Linux and a Windows client facing a %s', kind => {
  it('gives both clients an address, and the sniffer sees the whole exchange', async () => {
    const { linux, windows, onWire, powershell } = await lan(kind);

    await linux.executeCommand('dhclient eth0');
    await powershell('ipconfig /renew');

    expect((await linux.executeCommand('ip -4 addr show eth0'))).toMatch(/inet 10\.0\.0\.\d+\/24/);
    expect(await powershell('ipconfig')).toMatch(/IPv4 Address[ .]*: 10\.0\.0\.\d+/);
    for (const host of [linux, windows]) {
      expect(from(onWire, macOf(host), 'DHCPDISCOVER', 'DHCPOFFER', 'DHCPREQUEST', 'DHCPACK').map(messageOf).sort())
        .toEqual(['DHCPACK', 'DHCPDISCOVER', 'DHCPOFFER', 'DHCPREQUEST']);
    }
  });

  it('puts the client identifier on every Linux and every Windows request', async () => {
    const { linux, windows, onWire, powershell } = await lan(kind);

    await linux.executeCommand('dhclient eth0');
    await powershell('ipconfig /renew');

    for (const host of [linux, windows]) {
      const sent = requestsOf(onWire, macOf(host));
      expect(sent.length).toBe(2);
      for (const entry of sent) {
        expect(entry.packet.getOption(61)).toBe(`01${macOf(host).replace(/:/g, '').toLowerCase()}`);
      }
    }
  });

  it('asks like dhclient: 13 options, no FQDN, the hostname', async () => {
    const { linux, onWire } = await lan(kind);

    await linux.executeCommand('dhclient eth0');

    for (const entry of requestsOf(onWire, macOf(linux))) {
      expect(entry.packet.getOption(55)).toEqual([1, 28, 2, 3, 15, 6, 119, 12, 44, 47, 26, 121, 42]);
      expect(entry.packet.getOption(81)).toBeUndefined();
      expect(entry.packet.getOption(12)).toBe('L1');
      expect(entry.packet.getOption(60)).toBeUndefined();
    }
  });

  it('asks like Windows: 14 ascending options, a well-formed FQDN, the vendor class', async () => {
    const { windows, onWire, powershell } = await lan(kind);

    await powershell('ipconfig /renew');

    for (const entry of requestsOf(onWire, macOf(windows))) {
      expect(entry.packet.getOption(55)).toEqual([1, 3, 6, 15, 31, 33, 43, 44, 46, 47, 119, 121, 249, 252]);
      expect(entry.packet.getOption(60)).toBe('MSFT 5.0');
      const bytes = entry.packet.serialize();
      const at = bytes.indexOf(81, 240);
      expect(bytes[at + 1]).toBe(5);
      expect(String.fromCharCode(...bytes.slice(at + 5, at + 7))).toBe('W1');
    }
  });

  it('shows the same two requests under tcpdump with a decoded option 81', async () => {
    const { linux, sniffer, powershell } = await lan(kind);
    await sniffer.executeCommand('sudo tcpdump -i eth0 -nn -vv -w /tmp/dhcp.pcap udp port 67 or udp port 68 &');

    await linux.executeCommand('dhclient eth0');
    await powershell('ipconfig /renew');
    await sniffer.executeCommand('kill %1');
    const dump = await sniffer.executeCommand('sudo tcpdump -nn -vv -r /tmp/dhcp.pcap');

    expect(dump).toContain('FQDN (81), length 5: "W1"');
    expect(dump).not.toContain('length 0');
    expect(dump).toContain('Client-ID (61), length 7: ether');
    expect(dump).toContain('Parameter-Request (55), length 13');
    expect(dump).toContain('Parameter-Request (55), length 14');
  });

  it('stamps each sender with the TTL of its own system and clears DF', async () => {
    const { linux, windows, onWire, powershell } = await lan(kind);

    await linux.executeCommand('dhclient eth0');
    await powershell('ipconfig /renew');

    for (const entry of requestsOf(onWire, macOf(linux))) {
      expect([entry.ip.ttl, entry.ip.tos, entry.ip.flags]).toEqual([128, 0x10, 0]);
    }
    for (const entry of requestsOf(onWire, macOf(windows))) {
      expect([entry.ip.ttl, entry.ip.tos, entry.ip.flags]).toEqual([128, 0, 0]);
    }
    for (const entry of onWire.filter(seen => seen.packet.op === 2)) {
      expect([entry.ip.ttl, entry.ip.flags]).toEqual([SERVER_TTL[kind], 0]);
    }
  });

  it('releases with the client identifier, in unicast to the server', async () => {
    const { linux, windows, onWire, powershell } = await lan(kind);
    await linux.executeCommand('dhclient eth0');
    await powershell('ipconfig /renew');

    await linux.executeCommand('dhclient -r eth0');
    await powershell('ipconfig /release');

    for (const host of [linux, windows]) {
      const [release] = from(onWire, macOf(host), 'DHCPRELEASE');
      expect(release.packet.getOption(61)).toBe(`01${macOf(host).replace(/:/g, '').toLowerCase()}`);
      expect(release.packet.getOption(54)).toBe('10.0.0.1');
      expect(release.ip.destinationIP.toString()).toBe('10.0.0.1');
      expect(release.dstMac).not.toBe('ff:ff:ff:ff:ff:ff');
    }
  });
});

describe('Windows renews in unicast, and says only what ipconfig says', () => {
  it('sends the second /renew to its server with ciaddr and without a requested address', async () => {
    const { windows, onWire, powershell } = await lan('Cisco router');
    await powershell('ipconfig /renew');
    const before = requestsOf(onWire, macOf(windows)).length;

    await powershell('ipconfig /renew');

    const [renewal] = requestsOf(onWire, macOf(windows)).slice(before);
    expect(renewal.packet.ciaddr).toMatch(/^10\.0\.0\./);
    expect(renewal.packet.getOption(50)).toBeUndefined();
    expect(renewal.packet.getOption(54)).toBeUndefined();
    expect(renewal.ip.destinationIP.toString()).toBe('10.0.0.1');
    expect(renewal.dstMac).not.toBe('ff:ff:ff:ff:ff:ff');
  });

  it('prints the adapter and nothing invented', async () => {
    const { powershell } = await lan('Cisco router');

    const out = await powershell('ipconfig /renew');

    expect(out).toMatch(/Ethernet adapter Ethernet 0:/);
    expect(out).toMatch(/IPv4 Address[ .]*: 10\.0\.0\.\d+/);
    expect(out).not.toMatch(/DHCP Offer received|DHCP ACK received|DHCP Request - Broadcast/);
  });

  it('writes the adapter with an empty gateway after /release, and names the cards without a cable', async () => {
    const { powershell } = await lan('Cisco router');
    await powershell('ipconfig /renew');

    const out = await powershell('ipconfig /release');

    expect(out).toMatch(/Ethernet adapter Ethernet 0:\n\n {3}Connection-specific DNS Suffix {2}\. :\n {3}Default Gateway \. \. \. \. \. \. \. \. \. :/);
    expect(out).toContain('No operation can be performed on Ethernet 1 while it has its media disconnected.');
    expect(out).not.toMatch(/successfully released|IPv4 Address/);
  });

  it('does not invent an address on a card without a cable', async () => {
    const { powershell } = await lan('Cisco router');

    const out = await powershell('ipconfig /renew "Ethernet 1"');

    expect(out).toContain('No operation can be performed on Ethernet 1 while it has its media disconnected.');
    expect(out).not.toMatch(/169\.254|autoconfiguration/);
  });
});

describe('the Linux side says what dhclient and the kernel say', () => {
  it('writes no metric on the connected route', async () => {
    const { linux } = await lan('Cisco router');
    await linux.executeCommand('dhclient eth0');

    const routes = await linux.executeCommand('ip route');

    expect(routes).toMatch(/^10\.0\.0\.0\/24 dev eth0 proto kernel scope link src 10\.0\.0\.\d+$/m);
    expect(routes).not.toContain('metric 0');
  });

  it('prints the dhclient 4.4.1 transcript with -v', async () => {
    const { linux } = await lan('Cisco router');

    const out = await linux.executeCommand('dhclient -v eth0');

    expect(out.split('\n').slice(0, 5)).toEqual([
      'Internet Systems Consortium DHCP Client 4.4.1',
      'Copyright 2004-2018 Internet Systems Consortium.',
      'All rights reserved.',
      'For info, please visit https://www.isc.org/software/dhcp/',
      '',
    ]);
    expect(out).toContain('Sending on   Socket/fallback');
    expect(out).toMatch(/^DHCPDISCOVER on eth0 to 255\.255\.255\.255 port 67 interval 3 \(xid=0x[0-9a-f]+\)$/m);
    expect(out).toMatch(/^DHCPOFFER of 10\.0\.0\.\d+ from 10\.0\.0\.1$/m);
    expect(out).toMatch(/^DHCPREQUEST for 10\.0\.0\.\d+ on eth0 to 255\.255\.255\.255 port 67 \(xid=0x[0-9a-f]+\)$/m);
    expect(out).toMatch(/^DHCPACK of 10\.0\.0\.\d+ from 10\.0\.0\.1 \(xid=0x[0-9a-f]+\)$/m);
    expect(out).not.toMatch(/INIT state|DHCPREQUEST of/);
  });

  it('is silent without -v, on release as on acquisition, and prints DHCPRELEASE with it', async () => {
    const { linux } = await lan('Cisco router');
    expect(await linux.executeCommand('dhclient eth0')).toBe('');

    expect(await linux.executeCommand('dhclient -r eth0')).toBe('');
    await linux.executeCommand('dhclient eth0');
    expect(await linux.executeCommand('dhclient -v -r eth0'))
      .toMatch(/DHCPRELEASE of 10\.0\.0\.\d+ on eth0 to 10\.0\.0\.1 port 67 \(xid=0x[0-9a-f]+\)$/);
  });
});

describe('a Windows Server scope without a duration', () => {
  it('offers eight days', async () => {
    const { linux, onWire } = await lan('Windows Server');

    await linux.executeCommand('dhclient eth0');

    const [offer] = from(onWire, macOf(linux), 'DHCPOFFER');
    expect(offer.packet.getOption(51)).toBe(8 * 86400);
  });
});
