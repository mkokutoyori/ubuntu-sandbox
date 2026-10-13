/**
 * `netstat -s` de Windows imprime HUIT blocs, pas quatre : `IPv4 Statistics`, `IPv6 Statistics`, `ICMPv4 Statistics`,
 * `ICMPv6 Statistics`, `TCP Statistics for IPv4`, `TCP Statistics for IPv6`, `UDP Statistics for IPv4`, `UDP Statistics for
 * IPv6`, dans cet ordre ; `-p ip|ipv6|icmp|icmpv6|tcp|tcpv6|udp|udpv6` en choisit exactement les blocs demandes.
 *
 * Mesure de depart (a7e9f551f, un LinuxPC et un WindowsPC relies par `fd00::/64`, trois `ping -6` puis deux `ping`) :
 * `netstat -s` ne rendait que les quatre blocs IPv4 -- la ligne `Packets Received` n'avait vu que les deux echos IPv4, les
 * trois echos IPv6 et les sollicitations de voisin n'existaient nulle part -- ; `netstat -s -p ipv6` rendait un texte
 * vide (le filtre `-p` ne connaissait que `ip`, `icmp`, `tcp`, `udp`) ; et `-p ip` aurait rendu aussi `ipv6` si le bloc
 * avait existe, car le choix se faisait par prefixe (`startsWith('ip')`). Le TCP IPv6 s'ajoutait aux compteurs du bloc
 * IPv4 (un seul jeu de compteurs TCP pour les deux familles).
 *
 * Autorites : l'aide de `netstat` de Windows 10 22H2 (reprise telle quelle dans `NETSTAT_USAGE`) -- « By default, statistics
 * are shown for IP, IPv6, ICMP, ICMPv6, TCP, TCPv6, UDP, and UDPv6; the -p option may be used to specify a subset of the
 * default » ; la sortie de `netstat -s` relevee par Geekflare (« netstat command usage on windows ») pour l'ordre des
 * blocs et les intitules des lignes : les blocs IPv6 portent les memes dix-sept lignes que l'IPv4, `TCP Statistics for
 * IPv6` les huit lignes du TCP IPv4, `UDP Statistics for IPv6` les quatre de l'UDP, et `ICMPv6 Statistics` les dix-sept
 * lignes Messages, Errors, Destination Unreachable, Packet Too Big, Time Exceeded, Parameter Problems, Echos, Echo
 * Replies, MLD Queries, MLD Reports, MLD Dones, Router Solicitations, Router Advertisements, Neighbor Solicitations,
 * Neighbor Advertisements, Redirects, Router Renumberings. Les numeros de type ICMPv6 sont ceux de l'IANA (RFC 4443,
 * RFC 2710, RFC 4861, RFC 4620). Reste NON sourcee et donc reprise de l'IPv4 : la mise en colonnes (la page est du HTML,
 * qui reduit les espaces).
 *
 * Ce qui est construit : `WinNetstatStatistics` qui lit les compteurs IPv6 et TCP/UDP de chaque famille, le choix des blocs
 * par cle exacte, l'ordre fixe des huit blocs.
 *
 * Discrimination : 60 cas contre 40ec699d0 (les compteurs IPv6 existent, `netstat -s` ne les imprime pas) : 54 tombent. 6
 * passent des deux cotes : les deux temoins du banc (le ping aboutit sur les deux familles, le bloc IPv4 compte les deux
 * echos) et les quatre non-regressions `-p ip`, `-p icmp`, `-p tcp` et `-p udp` (le choix par cle exacte rend le meme bloc
 * que le choix par prefixe pour ces quatre-la). Mutation : 29 mutants (ordre des blocs, choix par prefixe, numero de type de
 * chaque ligne ICMPv6, colonnes Recu/Envoye echangees, chaque ligne des blocs IPv6 lue dans le compteur IPv4 voisin,
 * colonne des valeurs, colonne des libelles ICMP, filtre `-p` perdu), 29 tues ; deux (la colonne des valeurs et celle des
 * libelles) survivaient jusqu'a l'ajout du cas « la mise en colonnes est celle qu'elle a toujours eue ».
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPv6Address } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

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

const TITLES = [
  'IPv4 Statistics', 'IPv6 Statistics', 'ICMPv4 Statistics', 'ICMPv6 Statistics',
  'TCP Statistics for IPv4', 'TCP Statistics for IPv6', 'UDP Statistics for IPv4', 'UDP Statistics for IPv6',
];

const titlesOf = (text: string): string[] => text.split('\n').filter((line) => /^\S.*Statistics/.test(line));

const blockOf = (text: string, title: string): string => {
  const start = text.indexOf(`${title}\n`);
  if (start < 0) return '';
  const rest = text.slice(start + title.length);
  const next = TITLES.map((other) => rest.indexOf(`\n${other}\n`)).filter((at) => at >= 0);
  return next.length === 0 ? rest : rest.slice(0, Math.min(...next));
};

const valueOf = (block: string, label: string): number => {
  const match = new RegExp(`^\\s+${label}\\s+= (\\d+)$`, 'm').exec(block);
  if (match === null) throw new Error(`no line "${label}" in the block`);
  return Number(match[1]);
};

const columnsOf = (block: string, label: string): { received: number; sent: number } => {
  const match = new RegExp(`^\\s+${label}\\s+(\\d+)\\s+(\\d+)$`, 'm').exec(block);
  if (match === null) throw new Error(`no row "${label}" in the block`);
  return { received: Number(match[1]), sent: Number(match[2]) };
};

describe('the bench is sound (witness)', () => {
  it('Linux pings Windows over both families', async () => {
    const { linux } = await lab();
    expect(await linux.executeCommand('ping -6 -c 3 fd00::7')).toContain('3 received');
    expect(await linux.executeCommand('ping -c 2 10.0.0.7')).toContain('2 received');
  });

  it('the IPv4 block still counts the two IPv4 echoes', async () => {
    const { linux, windows } = await lab();
    await linux.executeCommand('ping -c 2 10.0.0.7');
    const text = await windows.executeCommand('netstat -s');
    expect(columnsOf(blockOf(text, 'ICMPv4 Statistics'), 'Echos').received).toBe(2);
  });
});

describe('netstat -s prints the eight blocks of the real tool, in its order', () => {
  it('IPv4, IPv6, ICMPv4, ICMPv6, TCP IPv4, TCP IPv6, UDP IPv4, UDP IPv6', async () => {
    const { windows } = await lab();
    expect(titlesOf(await windows.executeCommand('netstat -s'))).toEqual(TITLES);
  });

  it('the IPv6 blocks carry the lines of their IPv4 twins, with the same layout', async () => {
    const { windows } = await lab();
    const text = await windows.executeCommand('netstat -s');
    const labels = (title: string) => blockOf(text, title).split('\n')
      .map((line) => /^\s+(.*?)\s*= \d+$/.exec(line)?.[1]).filter((label): label is string => label !== undefined);
    expect(labels('IPv6 Statistics')).toEqual(labels('IPv4 Statistics'));
    expect(labels('IPv6 Statistics')).toHaveLength(17);
    expect(labels('TCP Statistics for IPv6')).toEqual(labels('TCP Statistics for IPv4'));
    expect(labels('UDP Statistics for IPv6')).toEqual(labels('UDP Statistics for IPv4'));
    const equalSigns = (title: string) => blockOf(text, title).split('\n')
      .filter((line) => line.includes('=')).map((line) => line.indexOf('='));
    expect(equalSigns('IPv6 Statistics')).toEqual(equalSigns('IPv4 Statistics'));
  });

  it('the layout the IPv4 blocks always had is kept: the label padded to 36 columns, then "= value", two spaces in', async () => {
    const { windows } = await lab();
    const text = await windows.executeCommand('netstat -s');
    for (const title of ['IPv4 Statistics', 'IPv6 Statistics']) {
      const block = blockOf(text, title);
      expect(block).toMatch(/^ {2}Packets Received {20}= \d+$/m);
      expect(block).toMatch(/^ {2}Datagrams Successfully Fragmented {3}= \d+$/m);
    }
    expect(blockOf(text, 'ICMPv6 Statistics')).toMatch(/^ {2}Echos {19}\d+ +\d+$/m);
    expect(blockOf(text, 'ICMPv4 Statistics')).toMatch(/^ {2}Echos {19}\d+ +\d+$/m);
  });

  it('ICMPv6 Statistics has the seventeen rows of the tool and two columns, Received and Sent', async () => {
    const { windows } = await lab();
    const block = blockOf(await windows.executeCommand('netstat -s'), 'ICMPv6 Statistics');
    expect(block).toMatch(/Received\s+Sent/);
    const rows = block.split('\n').map((line) => /^\s+([A-Z][A-Za-z ]+?)\s+\d+\s+\d+$/.exec(line)?.[1])
      .filter((label): label is string => label !== undefined);
    expect(rows).toEqual([
      'Messages', 'Errors', 'Destination Unreachable', 'Packet Too Big', 'Time Exceeded', 'Parameter Problems',
      'Echos', 'Echo Replies', 'MLD Queries', 'MLD Reports', 'MLD Dones', 'Router Solicitations',
      'Router Advertisements', 'Neighbor Solicitations', 'Neighbor Advertisements', 'Redirects', 'Router Renumberings',
    ]);
  });
});

describe('the IPv6 blocks count what the machine saw in IPv6', () => {
  it('three echo requests over IPv6: the target counts 3 echoes received and 3 replies sent', async () => {
    const { linux, windows } = await lab();
    await linux.executeCommand('ping -6 -c 3 fd00::7');
    const block = blockOf(await windows.executeCommand('netstat -s'), 'ICMPv6 Statistics');
    expect(columnsOf(block, 'Echos').received).toBe(3);
    expect(columnsOf(block, 'Echo Replies').sent).toBe(3);
    expect(columnsOf(block, 'Neighbor Solicitations').received).toBeGreaterThan(0);
    expect(columnsOf(block, 'Neighbor Advertisements').sent).toBeGreaterThan(0);
  });

  it('Messages is the sum of the rows, in both columns', async () => {
    const { linux, windows } = await lab();
    await linux.executeCommand('ping -6 -c 2 fd00::7');
    const block = blockOf(await windows.executeCommand('netstat -s'), 'ICMPv6 Statistics');
    const rows = ['Destination Unreachable', 'Packet Too Big', 'Time Exceeded', 'Parameter Problems', 'Echos',
      'Echo Replies', 'MLD Queries', 'MLD Reports', 'MLD Dones', 'Router Solicitations', 'Router Advertisements',
      'Neighbor Solicitations', 'Neighbor Advertisements', 'Redirects', 'Router Renumberings'].map((label) => columnsOf(block, label));
    expect(columnsOf(block, 'Messages').received).toBe(rows.reduce((sum, row) => sum + row.received, 0));
    expect(columnsOf(block, 'Messages').sent).toBe(rows.reduce((sum, row) => sum + row.sent, 0));
    expect(columnsOf(block, 'Messages').received).toBeGreaterThan(0);
  });

  it.each([
    ['Destination Unreachable', 1], ['Packet Too Big', 2], ['Time Exceeded', 3], ['Parameter Problems', 4],
    ['Echos', 128], ['Echo Replies', 129], ['MLD Queries', 130], ['MLD Reports', 131], ['MLD Dones', 132],
    ['Router Solicitations', 133], ['Router Advertisements', 134], ['Neighbor Solicitations', 135],
    ['Neighbor Advertisements', 136], ['Redirects', 137], ['Router Renumberings', 138],
  ])('the row "%s" reads the counters of the ICMPv6 type %i, received and sent apart', async (label, type) => {
    const { windows } = await lab();
    const rowOf = async () => columnsOf(
      blockOf(await windows.executeCommand('netstat -s -p icmpv6'), 'ICMPv6 Statistics'), label);
    const before = await rowOf();
    const counters = windows.getProtocolCounters();
    counters.icmp6InTypes[type] += 7;
    counters.icmp6OutTypes[type] += 11;
    const after = await rowOf();
    expect(after.received - before.received).toBe(7);
    expect(after.sent - before.sent).toBe(11);
  });

  it.each([
    ['IPv6 Statistics', 'IPv4 Statistics', 'Packets Received', 'ip6InReceives'],
    ['IPv6 Statistics', 'IPv4 Statistics', 'Received Header Errors', 'ip6InHdrErrors'],
    ['IPv6 Statistics', 'IPv4 Statistics', 'Received Address Errors', 'ip6InAddrErrors'],
    ['IPv6 Statistics', 'IPv4 Statistics', 'Unknown Protocols Received', 'ip6InUnknownProtos'],
    ['IPv6 Statistics', 'IPv4 Statistics', 'Received Packets Discarded', 'ip6InDiscards'],
    ['IPv6 Statistics', 'IPv4 Statistics', 'Received Packets Delivered', 'ip6InDelivers'],
    ['IPv6 Statistics', 'IPv4 Statistics', 'Output Requests', 'ip6OutRequests'],
    ['IPv6 Statistics', 'IPv4 Statistics', 'Discarded Output Packets', 'ip6OutDiscards'],
    ['IPv6 Statistics', 'IPv4 Statistics', 'Output Packet No Route', 'ip6OutNoRoutes'],
    ['TCP Statistics for IPv6', 'TCP Statistics for IPv4', 'Active Opens', 'tcp6ActiveOpens'],
    ['TCP Statistics for IPv6', 'TCP Statistics for IPv4', 'Passive Opens', 'tcp6PassiveOpens'],
    ['TCP Statistics for IPv6', 'TCP Statistics for IPv4', 'Failed Connection Attempts', 'tcp6AttemptFails'],
    ['TCP Statistics for IPv6', 'TCP Statistics for IPv4', 'Reset Connections', 'tcp6EstabResets'],
    ['TCP Statistics for IPv6', 'TCP Statistics for IPv4', 'Current Connections', 'tcp6CurrEstab'],
    ['TCP Statistics for IPv6', 'TCP Statistics for IPv4', 'Segments Received', 'tcp6InSegs'],
    ['TCP Statistics for IPv6', 'TCP Statistics for IPv4', 'Segments Sent', 'tcp6OutSegs'],
    ['TCP Statistics for IPv6', 'TCP Statistics for IPv4', 'Segments Retransmitted', 'tcp6RetransSegs'],
    ['UDP Statistics for IPv6', 'UDP Statistics for IPv4', 'Datagrams Received', 'udp6InDatagrams'],
    ['UDP Statistics for IPv6', 'UDP Statistics for IPv4', 'No Ports', 'udp6NoPorts'],
    ['UDP Statistics for IPv6', 'UDP Statistics for IPv4', 'Receive Errors', 'udp6InErrors'],
    ['UDP Statistics for IPv6', 'UDP Statistics for IPv4', 'Datagrams Sent', 'udp6OutDatagrams'],
  ] as const)('%s vs %s: the line "%s" reads %s and no IPv4 counter', async (sixTitle, fourTitle, label, field) => {
    const { windows } = await lab();
    const read = async () => {
      const text = await windows.executeCommand('netstat -s');
      return { six: valueOf(blockOf(text, sixTitle), label), four: valueOf(blockOf(text, fourTitle), label) };
    };
    const before = await read();
    windows.getProtocolCounters()[field] += 13;
    const after = await read();
    expect(after.six - before.six).toBe(13);
    expect(after.four - before.four).toBe(0);
  });

  it('IPv6 Statistics reads the IPv6 layer: packets received, delivered and requested are the machine\'s counters', async () => {
    const { linux, windows } = await lab();
    await linux.executeCommand('ping -6 -c 3 fd00::7');
    const text = await windows.executeCommand('netstat -s');
    const counters = windows.getProtocolCounters();
    const block = blockOf(text, 'IPv6 Statistics');
    expect(valueOf(block, 'Packets Received')).toBe(counters.ip6InReceives);
    expect(valueOf(block, 'Received Packets Delivered')).toBe(counters.ip6InDelivers);
    expect(valueOf(block, 'Output Requests')).toBe(counters.ip6OutRequests);
    expect(valueOf(block, 'Packets Received')).toBeGreaterThanOrEqual(3);
  });

  it('the IPv4 block does not see the IPv6 echoes, nor the IPv6 block the IPv4 ones', async () => {
    const { linux, windows } = await lab();
    await linux.executeCommand('ping -6 -c 3 fd00::7');
    const text = await windows.executeCommand('netstat -s');
    expect(columnsOf(blockOf(text, 'ICMPv4 Statistics'), 'Echos').received).toBe(0);
    await linux.executeCommand('ping -c 2 10.0.0.7');
    const after = await windows.executeCommand('netstat -s');
    expect(columnsOf(blockOf(after, 'ICMPv4 Statistics'), 'Echos').received).toBe(2);
    expect(columnsOf(blockOf(after, 'ICMPv6 Statistics'), 'Echos').received).toBe(3);
  });

  it('a TCP connection over IPv6 is a passive open of the IPv6 block and none of the IPv4 one', async () => {
    const { linux, windows } = await lab();
    const socket = linux.getTcpStack().connect('fd00::7', 22, {})!;
    await settle();
    const text = await windows.executeCommand('netstat -s');
    expect(valueOf(blockOf(text, 'TCP Statistics for IPv6'), 'Passive Opens')).toBe(1);
    expect(valueOf(blockOf(text, 'TCP Statistics for IPv6'), 'Current Connections')).toBe(1);
    expect(valueOf(blockOf(text, 'TCP Statistics for IPv4'), 'Passive Opens')).toBe(0);
    expect(valueOf(blockOf(text, 'TCP Statistics for IPv4'), 'Current Connections')).toBe(0);
    socket.close();
  });

  it('a TCP connection over IPv4 is a passive open of the IPv4 block and none of the IPv6 one', async () => {
    const { linux, windows } = await lab();
    const socket = linux.getTcpStack().connect('10.0.0.7', 22, {})!;
    await settle();
    const text = await windows.executeCommand('netstat -s');
    expect(valueOf(blockOf(text, 'TCP Statistics for IPv4'), 'Passive Opens')).toBe(1);
    expect(valueOf(blockOf(text, 'TCP Statistics for IPv6'), 'Passive Opens')).toBe(0);
    socket.close();
  });

  it('a datagram to a bound UDP port over IPv6 is a datagram of the IPv6 block, and a closed port a "no port"', async () => {
    const { linux, windows } = await lab();
    windows.udpBind(40200, () => undefined);
    const seen = async () => {
      const text = await windows.executeCommand('netstat -s');
      const six = blockOf(text, 'UDP Statistics for IPv6');
      return {
        received: valueOf(six, 'Datagrams Received'), noPorts: valueOf(six, 'No Ports'),
        sent: valueOf(six, 'Datagrams Sent'), v4Received: valueOf(blockOf(text, 'UDP Statistics for IPv4'), 'Datagrams Received'),
      };
    };
    const before = await seen();
    linux.sendUdpDatagram6(new IPv6Address('fd00::7'), 40200, 40000, 'x', 1);
    linux.sendUdpDatagram6(new IPv6Address('fd00::7'), 40201, 40000, 'x', 1);
    await settle();
    const after = await seen();
    expect(after.received - before.received).toBe(1);
    expect(after.noPorts - before.noPorts).toBe(1);
    expect(after.v4Received).toBe(before.v4Received);
    expect(after.sent).toBe(windows.getProtocolCounters().udp6OutDatagrams);
  });
});

describe('-p chooses exactly the blocks asked for', () => {
  it.each([
    ['ip', ['IPv4 Statistics']],
    ['ipv6', ['IPv6 Statistics']],
    ['icmp', ['ICMPv4 Statistics']],
    ['icmpv6', ['ICMPv6 Statistics']],
    ['tcp', ['TCP Statistics for IPv4']],
    ['tcpv6', ['TCP Statistics for IPv6']],
    ['udp', ['UDP Statistics for IPv4']],
    ['udpv6', ['UDP Statistics for IPv6']],
  ])('netstat -s -p %s', async (protocol, expected) => {
    const { windows } = await lab();
    expect(titlesOf(await windows.executeCommand(`netstat -s -p ${protocol}`))).toEqual(expected);
  });

  it('several protocols come out in the order of the tool, not the order typed', async () => {
    const { windows } = await lab();
    expect(titlesOf(await windows.executeCommand('netstat -s -p udpv6 ipv6 tcp')))
      .toEqual(['IPv6 Statistics', 'TCP Statistics for IPv4', 'UDP Statistics for IPv6']);
  });

  it('the block asked for carries the same numbers as in the full listing', async () => {
    const { linux, windows } = await lab();
    await linux.executeCommand('ping -6 -c 2 fd00::7');
    const full = blockOf(await windows.executeCommand('netstat -s'), 'ICMPv6 Statistics');
    const alone = blockOf(await windows.executeCommand('netstat -s -p icmpv6'), 'ICMPv6 Statistics');
    expect(columnsOf(alone, 'Echos')).toEqual(columnsOf(full, 'Echos'));
  });

  it('-e -s prints the interface statistics, then the eight blocks', async () => {
    const { windows } = await lab();
    const text = await windows.executeCommand('netstat -e -s');
    expect(text).toContain('Interface Statistics');
    expect(titlesOf(text).filter((title) => title !== 'Interface Statistics')).toEqual(TITLES);
  });
});
