/**
 * `netstat -s` de Linux ne fabrique pas son texte : il LIT `/proc/net/snmp` (et `/proc/net/snmp6` avec `-6`) et les met en
 * forme comme `statistics.c` de net-tools (Ubuntu 22.04, commit 0eebece). Les fichiers disent la meme chose que le noyau 5.15.
 *
 * Mesure de depart (40ec699d0, un LinuxPC et un WindowsPC relies par `fd00::/64`, `ping -6 -c 3` puis `ping -c 2`) :
 * `netstat -s` ignorait `-6`, `-t`, `-u` et `-w` et imprimait toujours le meme texte IPv4, `-s -x` aussi ; il imprimait des
 * lignes que le vrai outil tait (`0 receive buffer errors`, `Forwarding: 1`), n'imprimait jamais `IcmpMsg:` ni `UdpLite:`
 * et ajoutait deux en-tetes vides `TcpExt:` et `IpExt:` ; `/proc/net/snmp6` n'existait pas ; `/proc/net/snmp` imprimait
 * `IcmpMsg: InType8 OutType0` en dur -- `IcmpMsg: 0 0` sur une machine muette --, n'avait pas la colonne `MemErrors` de
 * `Udp:` ni de `UdpLite:` et mettait `IgnoredMulti` a zero en dur.
 *
 * Autorites : `net/ipv4/proc.c` et `net/ipv6/proc.c` du noyau 5.15 (listes de compteurs, ordre, format `%-32s\t%lu` de
 * snmp6, lignes `IcmpMsg` limitees aux types comptes) ; `statistics.c` et `netstat.c` de net-tools au commit 0eebece,
 * `lib/af.c` pour `afname` (les familles nommees s'accumulent, separees par des virgules). Le port garde les tables du C dans
 * leur ordre, y compris les entrees non triees : la recherche dichotomique (`bsearch` de la glibc) ne retrouve pas
 * `Forwarding`, que l'outil imprime alors par le chemin « de son mieux », `Forwarding: 2`. L'indentation d'un titre
 * d'histogramme est celle de l'etat PRECEDENT : `ICMP output histogram:` d'un `-s -6` sort a huit colonnes.
 *
 * Ce qui n'est pas porte : la table SCTP (aucune pile SCTP), et `/proc/net/netstat` n'existe pas encore (TcpExt et IpExt :
 * tache a part), si bien que ces deux sections ne sortent pas.
 *
 * Discrimination : 52 cas contre 53085fcbf (l'ancien rendu ecrit a la main) : 40 tombent. 12 passent des deux cotes : les deux
 * temoins du banc ; neuf non-regressions que l'ancien rendu satisfaisait deja (les constantes de la ligne Tcp, `Forwarding: 2`,
 * les memes chiffres que `/proc/net/snmp`, les titres d'histogramme vides, une ligne d'histogramme, le Tcp des deux familles,
 * l'absence de MaxConn, RtoMin et RtoMax, `-s -r` et `-s -i` refuses, le Tcp qui ferme `-s -6`) ; et `--inet6` = `-6`, vrai par
 * vacuite avant (l'ancien code ignorait les deux). Mutation : 50 mutants (recherche dichotomique, impression des compteurs
 * nuls ou non, titres et indentation, drapeaux de protocole, tables inconnues, remise a zero de l'etat par une table que les
 * drapeaux laissent de cote, choix de la table de snmp6, famille et alias, messages d'erreur, ordre et largeur de snmp6,
 * colonnes de snmp), 50 tues ; quatre (la remise a zero de l'etat, les tables inconnues sous un drapeau, les fichiers
 * absents, l'impression d'une table que le drapeau exclut) survivaient jusqu'aux cas qui lisent des fichiers ecrits a la
 * main et fixent l'etat de l'imprimeur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

interface Lab {
  readonly linux: LinuxPC;
  readonly windows: WindowsPC;
}

async function lab(): Promise<Lab> {
  const linux = new LinuxPC('linux-pc', 'LIN', 0, 0);
  const windows = new WindowsPC('windows-pc', 'WIN', 100, 0);
  linux.powerOn();
  windows.powerOn();
  windows.setCurrentUser('Administrator');
  new Cable('c1').connect(linux.getPort('eth0')!, windows.getPort('eth0')!);
  await linux.executeCommand('ifconfig eth0 10.0.0.3');
  await linux.executeCommand('ip -6 addr add fd00::1/64 dev eth0');
  await windows.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.7 255.255.255.0');
  await windows.executeCommand('netsh interface ipv6 add address "Ethernet0" fd00::7/64');
  return { linux, windows };
}

function idleMachine(): LinuxPC {
  const machine = new LinuxPC('idle-pc', 'IDL', 0, 0);
  machine.powerOn();
  return machine;
}

const titlesOf = (text: string): string[] => text.split('\n').filter((line) => /^\S.*:$/.test(line));

const sectionOf = (text: string, title: string): string[] => {
  const lines = text.split('\n');
  const start = lines.indexOf(`${title}:`);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\S/.test(line));
  return end < 0 ? rest : rest.slice(0, end);
};

const snmp6Rows = (text: string): Array<[string, number]> => text.split('\n')
  .filter((line) => line !== '').map((line) => {
    const [name, value] = line.split('\t');
    return [name.trimEnd(), Number(value)];
  });

const snmpTable = (text: string, title: string): Map<string, number> => {
  const lines = text.split('\n').filter((line) => line.startsWith(`${title}:`));
  const names = lines[0].slice(title.length + 1).trim().split(' ');
  const values = lines[1].slice(title.length + 1).trim().split(' ').map(Number);
  return new Map(names.map((name, index) => [name, values[index]]));
};

const IP6_NAMES = [
  'Ip6InReceives', 'Ip6InHdrErrors', 'Ip6InTooBigErrors', 'Ip6InNoRoutes', 'Ip6InAddrErrors', 'Ip6InUnknownProtos',
  'Ip6InTruncatedPkts', 'Ip6InDiscards', 'Ip6InDelivers', 'Ip6OutForwDatagrams', 'Ip6OutRequests', 'Ip6OutDiscards',
  'Ip6OutNoRoutes', 'Ip6ReasmTimeout', 'Ip6ReasmReqds', 'Ip6ReasmOKs', 'Ip6ReasmFails', 'Ip6FragOKs', 'Ip6FragFails',
  'Ip6FragCreates', 'Ip6InMcastPkts', 'Ip6OutMcastPkts', 'Ip6InOctets', 'Ip6OutOctets', 'Ip6InMcastOctets',
  'Ip6OutMcastOctets', 'Ip6InBcastOctets', 'Ip6OutBcastOctets', 'Ip6InNoECTPkts', 'Ip6InECT1Pkts', 'Ip6InECT0Pkts',
  'Ip6InCEPkts',
];

const ICMP6_NAMES = ['Icmp6InMsgs', 'Icmp6InErrors', 'Icmp6OutMsgs', 'Icmp6OutErrors', 'Icmp6InCsumErrors'];

const ICMP6_TYPE_NAMES = [
  'DestUnreachs', 'PktTooBigs', 'TimeExcds', 'ParmProblems', 'Echos', 'EchoReplies', 'GroupMembQueries',
  'GroupMembResponses', 'GroupMembReductions', 'RouterSolicits', 'RouterAdvertisements', 'NeighborSolicits',
  'NeighborAdvertisements', 'Redirects', 'MLDv2Reports',
];

const UDP6_NAMES = [
  'Udp6InDatagrams', 'Udp6NoPorts', 'Udp6InErrors', 'Udp6OutDatagrams', 'Udp6RcvbufErrors', 'Udp6SndbufErrors',
  'Udp6InCsumErrors', 'Udp6IgnoredMulti', 'Udp6MemErrors',
];

const UDPLITE6_NAMES = [
  'UdpLite6InDatagrams', 'UdpLite6NoPorts', 'UdpLite6InErrors', 'UdpLite6OutDatagrams', 'UdpLite6RcvbufErrors',
  'UdpLite6SndbufErrors', 'UdpLite6InCsumErrors', 'UdpLite6MemErrors',
];

const UDP_NAMES = [
  'InDatagrams', 'NoPorts', 'InErrors', 'OutDatagrams', 'RcvbufErrors', 'SndbufErrors', 'InCsumErrors', 'IgnoredMulti',
  'MemErrors',
];

describe('the bench is sound (witness)', () => {
  it('Linux pings Windows over both families', async () => {
    const { linux } = await lab();
    expect(await linux.executeCommand('ping -6 -c 3 fd00::7')).toContain('3 received');
    expect(await linux.executeCommand('ping -c 2 10.0.0.7')).toContain('2 received');
  });

  it('netstat -s answers and exits cleanly', async () => {
    const { linux } = await lab();
    expect(await linux.executeCommand('netstat -s')).toMatch(/total packets received/);
  });
});

describe('/proc/net/snmp6 (net/ipv6/proc.c, kernel 5.15)', () => {
  it('is a file, one row per counter: the name padded to 32 columns, a tab, the number', async () => {
    const { linux } = await lab();
    await linux.executeCommand('ping -6 -c 1 fd00::7');
    const text = await linux.executeCommand('cat /proc/net/snmp6');
    const rows = text.split('\n').filter((line) => line !== '');
    expect(rows.length).toBeGreaterThan(70);
    for (const row of rows) expect(row).toMatch(/^\S+ *\t\d+$/);
    for (const row of rows) expect(row.indexOf('\t')).toBe(Math.max(32, row.split('\t')[0].length));
  });

  it('lists the Ip6, Icmp6, named ICMPv6 types (inbound then outbound), Udp6 and UdpLite6 counters in the order of the kernel', async () => {
    const { linux } = await lab();
    const names = snmp6Rows(await linux.executeCommand('cat /proc/net/snmp6')).map(([name]) => name);
    const named = [
      ...ICMP6_TYPE_NAMES.map((type) => `Icmp6In${type}`),
      ...ICMP6_TYPE_NAMES.map((type) => `Icmp6Out${type}`),
    ];
    const fixed = [...IP6_NAMES, ...ICMP6_NAMES, ...named];
    expect(names.slice(0, fixed.length)).toEqual(fixed);
    expect(names.slice(-(UDP6_NAMES.length + UDPLITE6_NAMES.length))).toEqual([...UDP6_NAMES, ...UDPLITE6_NAMES]);
  });

  it('prints the machine\'s counters: three echoes, three replies, the packets and octets of the IPv6 layer', async () => {
    const { linux } = await lab();
    await linux.executeCommand('ping -6 -c 3 fd00::7');
    const rows = new Map(snmp6Rows(await linux.executeCommand('cat /proc/net/snmp6')));
    const counters = linux.getProtocolCounters();
    expect(rows.get('Icmp6OutEchos')).toBe(3);
    expect(rows.get('Icmp6InEchoReplies')).toBe(3);
    expect(rows.get('Icmp6OutType128')).toBe(3);
    expect(rows.get('Icmp6InType129')).toBe(3);
    expect(rows.get('Ip6InReceives')).toBe(counters.ip6InReceives);
    expect(rows.get('Ip6OutRequests')).toBe(counters.ip6OutRequests);
    expect(rows.get('Ip6OutOctets')).toBe(counters.ip6OutOctets);
    expect(rows.get('Ip6InMcastPkts')).toBe(counters.ip6InMcastPkts);
    expect(rows.get('Icmp6InMsgs')).toBe(counters.icmp6InMsgs);
  });

  it('adds one row per ICMPv6 type that was counted, by number, inbound before outbound and ascending', async () => {
    const { linux } = await lab();
    await linux.executeCommand('ping -6 -c 1 fd00::7');
    const byNumber = snmp6Rows(await linux.executeCommand('cat /proc/net/snmp6'))
      .map(([name]) => name).filter((name) => /^Icmp6(In|Out)Type\d+$/.test(name));
    expect(byNumber).toContain('Icmp6OutType128');
    expect(byNumber).toContain('Icmp6InType129');
    const inbound = byNumber.filter((name) => name.startsWith('Icmp6In'));
    const outbound = byNumber.filter((name) => name.startsWith('Icmp6Out'));
    expect(byNumber).toEqual([...inbound, ...outbound]);
    for (const group of [inbound, outbound]) {
      const numbers = group.map((name) => Number(/\d+$/.exec(name)![0]));
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    }
  });

  it('has no by-number row on a machine that has not sent or received any ICMPv6', async () => {
    const machine = idleMachine();
    const text = await machine.executeCommand('cat /proc/net/snmp6');
    expect(text).not.toMatch(/Icmp6(In|Out)Type\d+/);
    expect(text).toMatch(/^Icmp6InMsgs {21}\t0$/m);
  });
});

describe('/proc/net/snmp (net/ipv4/proc.c, kernel 5.15)', () => {
  it('has no IcmpMsg line until an ICMP type has been counted', async () => {
    const machine = idleMachine();
    expect(await machine.executeCommand('cat /proc/net/snmp')).not.toMatch(/^IcmpMsg:/m);
  });

  it('names the types that were counted, inbound then outbound, and their numbers on the next line', async () => {
    const { linux } = await lab();
    await linux.executeCommand('ping -c 2 10.0.0.7');
    const text = await linux.executeCommand('cat /proc/net/snmp');
    expect(text).toMatch(/^IcmpMsg: InType0 OutType8$/m);
    expect(text).toMatch(/^IcmpMsg: 2 2$/m);
    const icmp = snmpTable(text, 'Icmp');
    expect(icmp.get('InEchoReps')).toBe(2);
    expect(icmp.get('OutEchos')).toBe(2);
  });

  it('the Tcp row keeps the constants of the kernel: algorithm 1, RTO 200 ms to 120000 ms, MaxConn -1', async () => {
    const machine = idleMachine();
    const tcp = snmpTable(await machine.executeCommand('cat /proc/net/snmp'), 'Tcp');
    expect(tcp.get('RtoAlgorithm')).toBe(1);
    expect(tcp.get('RtoMin')).toBe(200);
    expect(tcp.get('RtoMax')).toBe(120000);
    expect(tcp.get('MaxConn')).toBe(-1);
  });

  it('Udp and UdpLite carry the nine columns of the kernel, MemErrors last', async () => {
    const machine = idleMachine();
    const text = await machine.executeCommand('cat /proc/net/snmp');
    expect([...snmpTable(text, 'Udp').keys()]).toEqual(UDP_NAMES);
    expect([...snmpTable(text, 'UdpLite').keys()]).toEqual(UDP_NAMES);
  });

  it('IgnoredMulti is the count of the machine, not a constant: a peer\'s multicast datagram nobody listens for', async () => {
    const { linux, windows } = await lab();
    const before = linux.getProtocolCounters().udpIgnoredMulti;
    windows.sendUdpDatagram(new IPAddress('224.0.0.1'), 40123, 40000, 'x', 1);
    await settle();
    const counters = linux.getProtocolCounters();
    expect(counters.udpIgnoredMulti - before).toBeGreaterThanOrEqual(1);
    const text = await linux.executeCommand('cat /proc/net/snmp');
    expect(snmpTable(text, 'Udp').get('IgnoredMulti')).toBe(counters.udpIgnoredMulti);
  });
});

describe('netstat -s prints what statistics.c prints over those files', () => {
  it('on a quiet machine: Ip, Icmp, Tcp, Udp and UdpLite, in the order of the file, and nothing from /proc/net/netstat', async () => {
    const machine = idleMachine();
    expect(titlesOf(await machine.executeCommand('netstat -s'))).toEqual(['Ip:', 'Icmp:', 'Tcp:', 'Udp:', 'UdpLite:']);
  });

  it('once ICMP has been counted IcmpMsg comes between Icmp and Tcp', async () => {
    const { linux } = await lab();
    await linux.executeCommand('ping -c 1 10.0.0.7');
    expect(titlesOf(await linux.executeCommand('netstat -s')))
      .toEqual(['Ip:', 'Icmp:', 'IcmpMsg:', 'Tcp:', 'Udp:', 'UdpLite:']);
  });

  it('the Ip section starts with the line the tool prints through its fallback, "Forwarding: 2", and never "Default TTL"', async () => {
    const machine = idleMachine();
    const ip = sectionOf(await machine.executeCommand('netstat -s'), 'Ip');
    expect(ip[0]).toBe('    Forwarding: 2');
    expect(ip.join('\n')).not.toMatch(/Default TTL|DefaultTTL/);
  });

  it('a "number" counter is printed even at zero, an "opt_number" only when it is not zero', async () => {
    const machine = idleMachine();
    const idle = await machine.executeCommand('netstat -s');
    expect(idle).toMatch(/^ {4}0 forwarded$/m);
    expect(idle).toMatch(/^ {4}0 incoming packets discarded$/m);
    expect(idle).not.toMatch(/with invalid headers/);
    expect(idle).not.toMatch(/with invalid addresses/);
    const counters = machine.getProtocolCounters();
    counters.ipInHdrErrors = 3;
    counters.ipInAddrErrors = 5;
    const busy = await machine.executeCommand('netstat -s');
    expect(busy).toMatch(/^ {4}3 with invalid headers$/m);
    expect(busy).toMatch(/^ {4}5 with invalid addresses$/m);
  });

  it('reads the numbers of /proc/net/snmp: packets, ICMP messages, UDP datagrams', async () => {
    const { linux } = await lab();
    await linux.executeCommand('ping -c 2 10.0.0.7');
    const snmp = await linux.executeCommand('cat /proc/net/snmp');
    const text = await linux.executeCommand('netstat -s');
    expect(text).toContain(`    ${snmpTable(snmp, 'Ip').get('InReceives')} total packets received`);
    expect(text).toContain(`    ${snmpTable(snmp, 'Ip').get('OutRequests')} requests sent out`);
    expect(text).toContain(`    ${snmpTable(snmp, 'Icmp').get('InMsgs')} ICMP messages received`);
    expect(text).toContain(`    ${snmpTable(snmp, 'Udp').get('OutDatagrams')} packets sent`);
  });

  it('the ICMP histograms keep their titles when they are empty, at the indentation of the state before', async () => {
    const machine = idleMachine();
    const icmp = sectionOf(await machine.executeCommand('netstat -s'), 'Icmp');
    expect(icmp).toEqual([
      '    0 ICMP messages received',
      '    0 input ICMP message failed',
      '    ICMP input histogram:',
      '    0 ICMP messages sent',
      '    0 ICMP messages failed',
      '    ICMP output histogram:',
    ]);
  });

  it('a counted type is a line of the histogram, eight columns in', async () => {
    const { linux } = await lab();
    await linux.executeCommand('ping -c 2 10.0.0.7');
    const icmp = sectionOf(await linux.executeCommand('netstat -s'), 'Icmp');
    expect(icmp).toContain('        echo replies: 2');
    expect(icmp).toContain('        echo requests: 2');
    expect(icmp.indexOf('        echo replies: 2')).toBeGreaterThan(icmp.indexOf('    ICMP input histogram:'));
    expect(icmp.indexOf('        echo requests: 2')).toBeGreaterThan(icmp.indexOf('    ICMP output histogram:'));
  });

  it('IcmpMsg, which the tool does not know, prints its counted types at the indentation of the state it inherits', async () => {
    const { linux } = await lab();
    await linux.executeCommand('ping -c 2 10.0.0.7');
    expect(sectionOf(await linux.executeCommand('netstat -s'), 'IcmpMsg')).toEqual([
      '        InType0: 2',
      '        OutType8: 2',
    ]);
  });

  it('a column the tool does not know is printed as it is when it is not zero: IgnoredMulti under Udp', async () => {
    const { linux, windows } = await lab();
    windows.sendUdpDatagram(new IPAddress('224.0.0.1'), 40123, 40000, 'x', 1);
    await settle();
    const udp = sectionOf(await linux.executeCommand('netstat -s'), 'Udp');
    expect(linux.getProtocolCounters().udpIgnoredMulti).toBeGreaterThan(0);
    expect(udp).toContain(`    IgnoredMulti: ${linux.getProtocolCounters().udpIgnoredMulti}`);
  });

  it('a Tcp column the table does not know is printed as it is, four columns in: InCsumErrors', async () => {
    const machine = idleMachine();
    machine.getProtocolCounters().tcpInCsumErrors = 2;
    const tcp = sectionOf(await machine.executeCommand('netstat -s'), 'Tcp');
    expect(tcp).toContain('    InCsumErrors: 2');
  });

  it('the Tcp section counts both families, as the kernel\'s single TCP MIB does', async () => {
    const { linux } = await lab();
    const socket = linux.getTcpStack().connect('fd00::7', 22, {})!;
    await settle();
    const tcp = sectionOf(await linux.executeCommand('netstat -s'), 'Tcp');
    expect(tcp).toContain('    1 active connection openings');
    expect(tcp).toContain('    1 connections established');
    socket.close();
  });

  it('shows no line for a column whose format is empty: MaxConn, RtoMin and RtoMax', async () => {
    const machine = idleMachine();
    const tcp = sectionOf(await machine.executeCommand('netstat -s'), 'Tcp').join('\n');
    expect(tcp).not.toMatch(/MaxConn|RtoMin|RtoMax|RTO algorithm/);
  });
});

const vfsOf = (machine: LinuxPC): VirtualFileSystem =>
  (machine as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;

describe('netstat -s is a reader of the files: what the files say is what it prints', () => {
  it('a /proc/net/snmp written by hand is printed by the rules of the tool, known tables and unknown ones', async () => {
    const machine = idleMachine();
    vfsOf(machine).registerGeneratedFile('/proc/net/snmp', () => [
      'Ip: Forwarding DefaultTTL InReceives InDiscards', 'Ip: 1 64 42 7', 'Foo: A B', 'Foo: 3 0', '',
    ].join('\n'));
    expect(await machine.executeCommand('netstat -s 2>/dev/null')).toBe([
      'Ip:',
      '    Forwarding: 1',
      '    42 total packets received',
      '    7 incoming packets discarded',
      'Foo:',
      '    A: 3',
    ].join('\n'));
  });

  it('a missing /proc/net/snmp is reported the way perror does, and prints nothing', async () => {
    const machine = idleMachine();
    vfsOf(machine).deleteFile('/proc/net/snmp');
    expect(await machine.executeCommand('netstat -s 2>/dev/null')).toBe('');
    expect(await machine.executeCommand('netstat -s 2>&1 >/dev/null; echo rc=$?'))
      .toBe('cannot open /proc/net/snmp: No such file or directory\nrc=0');
  });

  it('a file whose lines carry no colon is a parse problem, said on the error output', async () => {
    const machine = idleMachine();
    vfsOf(machine).registerGeneratedFile('/proc/net/snmp', () => 'garbage\nmore\n');
    expect(await machine.executeCommand('netstat -s 2>/dev/null')).toBe('');
    expect(await machine.executeCommand('netstat -s 2>&1 >/dev/null'))
      .toBe('Problem while parsing /proc/net/snmp');
  });

  it('a /proc/net/snmp6 written by hand: the table follows the name up to its "6", a table nobody knows prints its header', async () => {
    const machine = idleMachine();
    vfsOf(machine).registerGeneratedFile('/proc/net/snmp6', () => [
      'Ip6InReceives                   \t9', 'Ip6InOctets                     \t100', 'Foo6Bar                         \t5', '',
    ].join('\n'));
    const text = await machine.executeCommand('netstat -s -6 2>/dev/null');
    expect(text.split('\n').slice(0, 6)).toEqual([
      'Ip6:', '    9 total packets received', '    Ip6InOctets: 100', 'Foo6:', '    Foo6Bar: 5', 'Tcp:',
    ]);
  });

  it('a missing /proc/net/snmp6 stops netstat -s -6 before anything is printed', async () => {
    const machine = idleMachine();
    vfsOf(machine).deleteFile('/proc/net/snmp6');
    expect(await machine.executeCommand('netstat -s -6 2>/dev/null')).toBe('');
    expect(await machine.executeCommand('netstat -s -6 2>&1 >/dev/null'))
      .toBe('cannot open /proc/net/snmp6: No such file or directory');
  });

  it('netstat -s -6 without /proc/net/snmp prints the IPv6 tables and then says it cannot read the TCP one', async () => {
    const machine = idleMachine();
    vfsOf(machine).deleteFile('/proc/net/snmp');
    expect(titlesOf(await machine.executeCommand('netstat -s -6 2>/dev/null')))
      .toEqual(['Ip6:', 'Icmp6:', 'Udp6:', 'UdpLite6:']);
    expect(await machine.executeCommand('netstat -s -6 2>&1 >/dev/null'))
      .toBe('cannot open /proc/net/snmp: No such file or directory');
  });
});

describe('netstat -s -6 reads /proc/net/snmp6, then the Tcp table of /proc/net/snmp', () => {
  it('prints Ip6, Icmp6, Udp6, UdpLite6 and Tcp, in that order', async () => {
    const { linux } = await lab();
    await linux.executeCommand('ping -6 -c 1 fd00::7');
    expect(titlesOf(await linux.executeCommand('netstat -s -6'))).toEqual(['Ip6:', 'Icmp6:', 'Udp6:', 'UdpLite6:', 'Tcp:']);
  });

  it('--inet6 is the same request as -6', async () => {
    const { linux } = await lab();
    expect(await linux.executeCommand('netstat -s --inet6')).toBe(await linux.executeCommand('netstat -s -6'));
  });

  it('the numbers are those of the file: packets received, delivered, requested, multicast', async () => {
    const { linux } = await lab();
    await linux.executeCommand('ping -6 -c 3 fd00::7');
    const rows = new Map(snmp6Rows(await linux.executeCommand('cat /proc/net/snmp6')));
    const ip6 = sectionOf(await linux.executeCommand('netstat -s -6'), 'Ip6');
    expect(ip6).toContain(`    ${rows.get('Ip6InReceives')} total packets received`);
    expect(ip6).toContain(`    ${rows.get('Ip6InDelivers')} incoming packets delivered`);
    expect(ip6).toContain(`    ${rows.get('Ip6OutRequests')} requests sent out`);
    expect(ip6).toContain(`    ${rows.get('Ip6InMcastPkts')} incoming multicast packets`);
    expect(ip6).toContain('    0 forwarded');
  });

  it('a counter the tool does not know is printed as it is: the octets', async () => {
    const { linux } = await lab();
    await linux.executeCommand('ping -6 -c 1 fd00::7');
    const counters = linux.getProtocolCounters();
    const ip6 = sectionOf(await linux.executeCommand('netstat -s -6'), 'Ip6');
    expect(ip6).toContain(`    Ip6InOctets: ${counters.ip6InOctets}`);
    expect(ip6).toContain(`    Ip6OutOctets: ${counters.ip6OutOctets}`);
  });

  it('the histograms use the names of the file: echo requests and replies, then the numbered types as they are', async () => {
    const { linux } = await lab();
    await linux.executeCommand('ping -6 -c 3 fd00::7');
    const icmp6 = sectionOf(await linux.executeCommand('netstat -s -6'), 'Icmp6');
    expect(icmp6).toContain('        echo replies: 3');
    expect(icmp6).toContain('        echo requests: 3');
    expect(icmp6).toContain('        Icmp6InType129: 3');
    expect(icmp6).toContain('        Icmp6OutType128: 3');
  });

  it('the output title sits at eight columns: the tool indents a title by the state it leaves, not the one it enters', async () => {
    const { linux } = await lab();
    await linux.executeCommand('ping -6 -c 1 fd00::7');
    const icmp6 = sectionOf(await linux.executeCommand('netstat -s -6'), 'Icmp6');
    expect(icmp6).toContain('    ICMP input histogram:');
    expect(icmp6).toContain('        ICMP output histogram:');
  });

  it('an outbound router advertisement is printed as it is: the C table spells the name with a trailing space and never matches it', async () => {
    const { linux } = await lab();
    await linux.executeCommand('ping -6 -c 1 fd00::7');
    linux.getProtocolCounters().icmp6OutTypes[134] = 4;
    linux.getProtocolCounters().icmp6InTypes[134] = 6;
    const icmp6 = sectionOf(await linux.executeCommand('netstat -s -6'), 'Icmp6');
    expect(icmp6).toContain('        Icmp6OutRouterAdvertisements: 4');
    expect(icmp6).toContain('        router advertisement: 6');
    expect(icmp6).not.toContain('        router advertisement: 4');
  });

  it('the Tcp table at the end is the one of /proc/net/snmp, both families summed', async () => {
    const { linux } = await lab();
    const socket = linux.getTcpStack().connect('fd00::7', 22, {})!;
    await settle();
    const tcp = sectionOf(await linux.executeCommand('netstat -s -6'), 'Tcp');
    expect(tcp).toContain('    1 active connection openings');
    socket.close();
  });
});

const IP_LINE = 'total packets received';
const ICMP_LINE = 'ICMP messages received';
const TCP_LINE = 'active connection openings';
const UDP_LINE = 'packets to unknown port received';

describe('the protocol flags choose the tables, and the tables the tool does not know come out whatever the flag', () => {
  it.each([
    ['-s -t', ['IcmpMsg:', 'Tcp:', 'UdpLite:'], [TCP_LINE], [IP_LINE, ICMP_LINE, UDP_LINE]],
    ['-s -u', ['IcmpMsg:', 'Udp:', 'UdpLite:'], [UDP_LINE], [IP_LINE, ICMP_LINE, TCP_LINE]],
    ['-s -w', ['Ip:', 'Icmp:', 'IcmpMsg:', 'UdpLite:'], [IP_LINE, ICMP_LINE], [TCP_LINE, UDP_LINE]],
    ['-s -t -u', ['IcmpMsg:', 'Tcp:', 'Udp:', 'UdpLite:'], [TCP_LINE, UDP_LINE], [IP_LINE, ICMP_LINE]],
    ['-s -6 -t', ['UdpLite6:', 'Tcp:'], [TCP_LINE], [IP_LINE, ICMP_LINE, UDP_LINE]],
    ['-s -6 -u', ['Udp6:', 'UdpLite6:'], [UDP_LINE], [IP_LINE, ICMP_LINE, TCP_LINE]],
    ['-s -6 -w', ['Ip6:', 'Icmp6:', 'UdpLite6:'], [IP_LINE, ICMP_LINE], [TCP_LINE, UDP_LINE]],
  ])('netstat %s', async (command, titles, present, absent) => {
    const { linux } = await lab();
    await linux.executeCommand('ping -c 1 10.0.0.7');
    await linux.executeCommand('ping -6 -c 1 fd00::7');
    const text = await linux.executeCommand(`netstat ${command}`);
    expect(titlesOf(text)).toEqual(titles);
    for (const line of present) expect(text).toContain(line);
    for (const line of absent) expect(text).not.toContain(line);
  });
});

describe('what the flags leave out still moves the state of the printer', () => {
  it('an unknown table prints its counted columns whatever the flag, at the indentation of the state it inherits', async () => {
    const { linux } = await lab();
    await linux.executeCommand('ping -c 1 10.0.0.7');
    expect(sectionOf(await linux.executeCommand('netstat -s -t'), 'IcmpMsg')).toEqual(['    InType0: 1', '    OutType8: 1']);
    expect(sectionOf(await linux.executeCommand('netstat -s -w'), 'IcmpMsg')).toEqual(['        InType0: 1', '        OutType8: 1']);
  });

  it('a known table the flags leave out still resets the state: UdpLite after -w is four columns in, not eight', async () => {
    const machine = idleMachine();
    machine.getProtocolCounters().udpLiteInDatagrams = 3;
    expect(sectionOf(await machine.executeCommand('netstat -s -w'), 'UdpLite')).toEqual(['    InDatagrams: 3']);
  });
});

describe('the address family decides, as afname does in lib/af.c', () => {
  const withStatus = (machine: LinuxPC, command: string) => machine.executeCommand(`${command} 2>&1; echo rc=$?`);

  it('-s -x: no statistics for unix, said on the standard output, status 1', async () => {
    const { linux } = await lab();
    expect(await withStatus(linux, 'netstat -s -x'))
      .toBe('netstat: No statistics support for specified address family: unix\nrc=1');
  });

  it('-s -4 -6: the two names accumulate, comma separated, and neither is the one family the tool serves', async () => {
    const { linux } = await lab();
    expect(await withStatus(linux, 'netstat -s -4 -6'))
      .toBe('netstat: No statistics support for specified address family: inet,inet6\nrc=1');
  });

  it('an alias is canonical: --ip is inet, -A ip6 is inet6, appletalk is ddp', async () => {
    const { linux } = await lab();
    expect(await linux.executeCommand('netstat -s --ip')).toBe(await linux.executeCommand('netstat -s'));
    expect(await linux.executeCommand('netstat -s -A ip6')).toBe(await linux.executeCommand('netstat -s -6'));
    expect(await withStatus(linux, 'netstat -s -A appletalk'))
      .toBe('netstat: No statistics support for specified address family: ddp\nrc=1');
  });

  it('an unknown family is refused in the words of aftrans_opt, with status 1', async () => {
    const { linux } = await lab();
    expect(await withStatus(linux, 'netstat -s -A foo')).toBe("Unknown address family `foo'.\nrc=1");
  });

  it('-s with -r or -i is the usage error it always was', async () => {
    const { linux } = await lab();
    expect(await linux.executeCommand('netstat -s -r >/dev/null 2>&1; echo rc=$?')).toBe('rc=3');
    expect(await linux.executeCommand('netstat -s -i >/dev/null 2>&1; echo rc=$?')).toBe('rc=3');
  });
});
