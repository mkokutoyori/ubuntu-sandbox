/**
 * `conntrack` lit sa ligne de commande et ecrit la table comme conntrack-tools 1.4.7 : la version et l'aide existent, une option inconnue,
 * manquante ou etrangere a la commande est un « Parameter problem » de statut 2, les tables se prennent par prefixe, `-L` et `-D` filtrent
 * par adresse (avec masque), famille, protocole, port, ICMP, etat et marque, `-D` supprime ce que `-L` montrerait et dit combien, `-F`
 * vide une famille, `-S` ecrit une ligne par processeur de la machine. Chaque ligne suit libnetfilter_conntrack. La commande d'avant
 * ignorait tout critere qu'elle ne connaissait pas et listait la table entiere.
 *
 * Mesure de depart (d22177a7 ; deux LinuxPC sur un lien, un ping, un datagramme UDP vers un port ferme) :
 *     `conntrack -V`, `-h` et `conntrack` seul  ->  « Parameter problem: missing command », statut 2 (la version et l'aide n'existaient pas)
 *     `conntrack -D -p udp`                     ->  « Parameter problem: missing command » : aucune suppression
 *     `-L -x`, `-L foo`, `-L -u ASSURED`, `-L -s 10.0.0.2`, `-L -p udp --dport 1`, `-L -o extended`  ->  la table entiere, chaque critere ignore
 *     `-F -p tcp`                               ->  accepte, la table videe : l'option n'appartient pas a la commande
 *     `-S`                                      ->  « cpu=0   found=0 ... search_restart=0 » : huit compteurs, ni tabulation, ni les deux derniers
 *     `-L`                                      ->  le tuple retour d'abord, « ESTABLISHED » pour un flux sans reponse, « [UNREPLIED] » avant le
 *                                                   premier tuple, ports a 0 pour de l'ICMP
 *
 * Autorites (regle 8) : conntrack-tools 1.4.7 conntrack.c (la chaine d'options de getopt_long, la table des options legales par
 * commande, les mots de table pris par prefixe, les filtres d'adresse avec masque, de port, d'ICMP, d'etat -- `(status & masque) ==
 * valeur`, `UNREPLIED` et `!` --, de marque -- `(marque & masque) == valeur` --, `-D` qui ecrit chaque entree supprimee puis « %d flow
 * entries have been deleted. » et sort en 1 quand le decompte est nul, `-F` par famille, `-S` une ligne `cpu=%-4u\t` par processeur,
 * `-o extended` qui ecrit « %-8s %u » de la famille, l'aide) ; libnetfilter_conntrack 1.0.9 snprintf_default.c (la forme des lignes) ;
 * noyau Linux 6.1.176 nf_conntrack_netlink.c (les dix compteurs par processeur).
 *
 * Discrimination : contre l'arbre sans le lot (sources remises a leur etat, sonde et support conserves, l'import du suiveur remplace par une
 * classe qui leve), 134 des 157 cas tombent et 23 passent des deux cotes : les vingt et un filtres dont le resultat attendu est ZERO
 * flux du laboratoire, l'ecoute vide et la page de man qui declarait deja `-p proto`. Au depart `conntrack -L` ecrit le tuple retour d'abord, si bien que la ligne n'est jamais reconnue comme
 * un flux vers B et que le zero est atteint par vacuite. Ce sont les cas positifs voisins (la meme famille de filtre avec un resultat non nul)
 * et le TEMOIN (le laboratoire tient bien trois flux vers B) qui prouvent que le laboratoire marche et que le zero est un vrai refus du filtre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ConnectionTracker } from '@/network/devices/linux/ConnectionTracker';
import { IPAddress, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../support/fastPing';
import { linuxPair } from '../../support/linuxPair';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('conntrack -L writes each flow the way libnetfilter_conntrack does', () => {
  const lines = (listing: string): string[] => listing.split('\n').filter((line) => /^\S+\s+\d+ /.test(line));

  it('an ICMP flow : protocol and number, timeout, original tuple with type code id, reply tuple, mark and use', async () => {
    const { a } = linuxPair();
    await pingOnSimulatedClock(a, 'ping -c 1 -W 1 10.0.0.2');
    const [line] = lines(await a.executeCommand('sudo conntrack -L -p icmp'));
    expect(line).toMatch(/^icmp {5}1 \d+ src=10\.0\.0\.1 dst=10\.0\.0\.2 type=8 code=0 id=\d+ src=10\.0\.0\.2 dst=10\.0\.0\.1 type=0 code=0 id=\d+ mark=0 use=1$/);
  });

  it('a UDP flow that nobody answered : [UNREPLIED] sits between the two tuples, and the original comes first', async () => {
    const { a } = linuxPair();
    a.sendUdpDatagram(new IPAddress('10.0.0.2'), 9999, 4000, 'hello', 5);
    const [line] = lines(await a.executeCommand('sudo conntrack -L -p udp'));
    expect(line).toMatch(/^udp {6}17 \d+ src=10\.0\.0\.1 dst=10\.0\.0\.2 sport=4000 dport=9999 \[UNREPLIED\] src=10\.0\.0\.2 dst=10\.0\.0\.1 sport=9999 dport=4000 mark=0 use=1$/);
  });

  it.each([
    ['a UDP-Lite flow', 136, /^udplite {2}136 \d+ src=10\.0\.0\.1 dst=10\.0\.0\.2 sport=7 dport=9 \[UNREPLIED\] src=10\.0\.0\.2 dst=10\.0\.0\.1 sport=9 dport=7 mark=0 use=1$/],
    ['a GRE flow : the keys stand where the ports stand', 47, /^gre {6}47 \d+ src=10\.0\.0\.1 dst=10\.0\.0\.2 srckey=0x0 dstkey=0x0 \[UNREPLIED\] src=10\.0\.0\.2 dst=10\.0\.0\.1 srckey=0x0 dstkey=0x0 mark=0 use=1$/],
    ['a flow of a protocol the library does not know', 89, /^unknown {2}89 \d+ src=10\.0\.0\.1 dst=10\.0\.0\.2 \[UNREPLIED\] src=10\.0\.0\.2 dst=10\.0\.0\.1 mark=0 use=1$/],
    ['an SCTP flow : name, number and ports', 132, /^sctp {5}132 \d+ .*src=10\.0\.0\.1 dst=10\.0\.0\.2 sport=7 dport=9 /],
    ['a DCCP flow : name, number and ports', 33, /^dccp {5}33 \d+ .*src=10\.0\.0\.1 dst=10\.0\.0\.2 sport=7 dport=9 /],
  ])('%s is written the way the library writes its protocol', async (_name, protocol, expected) => {
    const { a } = linuxPair();
    const tracker = (a as unknown as { executor: { iptables: { connections: ConnectionTracker } } }).executor.iptables.connections;
    const withPorts = [136, 132, 33].includes(protocol);
    tracker.confirm(tracker.enter({ protocol, srcIP: '10.0.0.1', srcPort: withPorts ? 7 : 0, dstIP: '10.0.0.2', dstPort: withPorts ? 9 : 0 }));
    const [line] = lines(await a.executeCommand('sudo conntrack -L'));
    expect(line).toMatch(expected);
  });

  it('an IPv6 link-local address is written without its zone, the way inet_ntop writes the raw address', async () => {
    const { a } = linuxPair();
    const tracker = (a as unknown as { executor: { ip6tables: { connections: ConnectionTracker } } }).executor.ip6tables.connections;
    tracker.confirm(tracker.enter({ protocol: 17, srcIP: 'fe80::ff:fe00:1%eth0', srcPort: 5355, dstIP: 'ff02::1:3', dstPort: 5355 }));
    const [line] = lines(await a.executeCommand('sudo conntrack -L -f ipv6'));
    expect(line).toMatch(/^udp {6}17 \d+ src=fe80::ff:fe00:1 dst=ff02::1:3 sport=5355 dport=5355 \[UNREPLIED\] src=ff02::1:3 dst=fe80::ff:fe00:1 sport=5355 dport=5355 mark=0 use=1$/);
  });

  it('the error that B sends for that datagram is not a flow of its own', async () => {
    const { a } = linuxPair();
    a.sendUdpDatagram(new IPAddress('10.0.0.2'), 9999, 4000, 'hello', 5);
    expect(lines(await a.executeCommand('sudo conntrack -L -p icmp'))).toEqual([]);
  });

  it('-C counts the table of the two families, whatever the filter', async () => {
    const { a } = linuxPair();
    await pingOnSimulatedClock(a, 'ping -c 1 -W 1 10.0.0.2');
    await pingOnSimulatedClock(a, 'ping -6 -c 1 -W 1 2001:db8::2');
    const everything = Number(await a.executeCommand('sudo conntrack -C'));
    expect(everything).toBeGreaterThanOrEqual(2);
    expect(lines(await a.executeCommand('sudo conntrack -L -f ipv6')).every((line) => line.includes('icmpv6') || line.includes('udp') || line.includes('tcp'))).toBe(true);
    expect(lines(await a.executeCommand('sudo conntrack -L -f ipv4')).length).toBeLessThan(everything);
  });

  it('-S writes cpu=0 and a tab, then the ten counters of the kernel in the kernel order, each followed by a space', async () => {
    const { a } = linuxPair();
    const [first] = (await a.executeCommand('sudo conntrack -S')).split('\n');
    expect(first).toMatch(
      /^cpu=0 {3}\tfound=\d+ invalid=\d+ insert=\d+ insert_failed=0 drop=0 early_drop=0 error=0 search_restart=0 clash_resolve=0 chaintoolong=0 $/,
    );
  });
});

const VERSION_LINE = 'conntrack v1.4.7 (conntrack-tools)';
const TRY_HELP = "Try `conntrack -h' or 'conntrack --help' for more information.";

async function flowsLab() {
  const { a, b } = linuxPair();
  await pingOnSimulatedClock(a, 'ping -c 1 -W 1 10.0.0.2');
  await pingOnSimulatedClock(a, 'ping -6 -c 1 -W 1 2001:db8::2');
  a.sendUdpDatagram(new IPAddress('10.0.0.2'), 9999, 4000, 'hello', 5);
  return { a, b };
}

const labFlows = (listing: string): string[] =>
  listing.split('\n').filter((line) => /^(?:ipv[46]\s+\d+ )?\S+\s+\d+ \d+ (?:[A-Z_]+ )?src=\S+ dst=(10\.0\.0\.2|2001:db8::2) /.test(line));

const withStatus = (command: string): string => `sudo ${command}; echo "rc=$?"`;

describe('conntrack reads its command line the way conntrack-tools 1.4.7 does', () => {
  it('TEMOIN : the lab holds one ICMP flow, one UDP flow and one ICMPv6 flow towards B', async () => {
    const { a } = await flowsLab();
    expect(labFlows(await a.executeCommand('sudo conntrack -L')).length).toBe(3);
  });

  it.each(['-V', '--version'])('%s names the release and nothing else', async (flag) => {
    const { a } = linuxPair();
    expect(await a.executeCommand(withStatus(`conntrack ${flag}`))).toBe(`${VERSION_LINE}\nrc=0`);
  });

  it.each(['', '-h', '--help'])('"%s" writes the usage, the tables and the common options', async (flag) => {
    const { a } = linuxPair();
    const out = await a.executeCommand(withStatus(`conntrack ${flag}`));
    expect(out).toContain('Command line interface for the connection tracking system. Version 1.4.7\nUsage: conntrack [commands] [options]');
    expect(out).toContain('Tables: conntrack, expect, dying, unconfirmed');
    expect(out).toContain("  -f, --family proto\t\tLayer 3 Protocol, eg. 'ipv6'");
    expect(out.endsWith('rc=0')).toBe(true);
  });

  it.each([
    ['-L -x', "unknown option `-x'"],
    ['-L --bogus', "unknown option `--bogus'"],
    ['-L -p', "option `-p' requires an argument"],
    ['-L --protonum', "option `--protonum' requires an argument"],
    ['-L -D', 'Invalid commands combination'],
    ['-L -s 999.1.1.1', "Invalid IP address `999.1.1.1'"],
    ['-L -s 10.0.0.1/33', 'Invalid netmask'],
    ['-L -s 10.0.0.1/-1', 'Invalid netmask'],
    ['-L -s 10.0.0.1/8x', 'Invalid netmask'],
    ['-L -s 2001:db8::1/129', 'Invalid netmask'],
    ['-L -s /24', "Invalid IP address `/24'"],
    ['-L -s 10.0.0.1 -f ipv6', 'mismatched address family'],
    ['-L -f ipx', "`ipx' unsupported protocol"],
    ['-L -p nosuchproto', "`nosuchproto' unsupported protocol"],
    ['-L -r 10.0.0.1/24', 'CIDR notation unavailable for `--reply-src\''],
    ['-L -u NOSUCH', "Bad parameter `NOSUCH'"],
    ['-L -o nosuch', "Bad parameter `nosuch'"],
    ['-L nosuchtable', "unknown type `nosuchtable'"],
  ])('conntrack %s is a parameter problem : "%s", the hint, status 2', async (args, wording) => {
    const { a } = linuxPair();
    expect(await a.executeCommand(withStatus(`conntrack ${args}`))).toBe(`${VERSION_LINE}: ${wording}\n${TRY_HELP}\nrc=2`);
  });

  it.each([
    ['-F -p tcp', '--protonum'],
    ['-L --timeout 5', '--timeout'],
    ['-C -s 10.0.0.1', '--src'],
    ['-S -f ipv4', '--family'],
    ['-D --zero', '--zero'],
    ['-L -p tcp --state ESTABLISHED --id 5', '--id'],
  ])('conntrack %s : the option does not belong to the command', async (args, option) => {
    const { a } = linuxPair();
    expect(await a.executeCommand(withStatus(`conntrack ${args}`))).toBe(
      `${VERSION_LINE}: Illegal option \`${option}' with this command\n${TRY_HELP}\nrc=2`,
    );
  });

  it.each([
    ['-L --sport 4000', '--sport'],
    ['-L -p icmp --sport 4000', '--sport'],
    ['-L -p tcp --icmp-type 8', '--icmp-type'],
    ['-L -p udp --state ESTABLISHED', '--state'],
    ['-L -p gre --dport 1', '--dport'],
  ])('conntrack %s : the protocol does not take that option', async (args, option) => {
    const { a } = linuxPair();
    expect(await a.executeCommand(withStatus(`conntrack ${args}`))).toBe(`${VERSION_LINE}: unknown option \`${option}'\n${TRY_HELP}\nrc=2`);
  });

  it('tables are matched by prefix, and dying and unconfirmed only list', async () => {
    const { a } = await flowsLab();
    expect(await a.executeCommand(withStatus('conntrack -L exp'))).toBe(`${VERSION_LINE}: 0 expectations have been shown.\nrc=0`);
    expect(await a.executeCommand(withStatus('conntrack -L dy'))).toBe(`${VERSION_LINE}: 0 flow entries have been shown.\nrc=0`);
    expect(await a.executeCommand(withStatus('conntrack -L unconfirmed'))).toBe(`${VERSION_LINE}: 0 flow entries have been shown.\nrc=0`);
    expect(await a.executeCommand(withStatus('conntrack -D dying'))).toBe(
      `${VERSION_LINE}: Can't do that command with tables \`dying' and \`unconfirmed'\n${TRY_HELP}\nrc=2`,
    );
  });
});

describe('conntrack filters the table with the criteria it was given, and with nothing else', () => {
  it.each([
    ['-s 10.0.0.1', 2],
    ['-s 10.0.0.2', 0],
    ['--orig-src 10.0.0.1', 2],
    ['-d 10.0.0.2', 2],
    ['-r 10.0.0.2', 2],
    ['-r 10.0.0.1', 0],
    ['-q 10.0.0.1', 2],
    ['-s 10.0.0.0/24', 2],
    ['-s 10.0.1.0/24', 0],
    ['-s 10.0.0.1/32', 2],
    ['-s 10.0.0.0/32', 0],
    ['-d 10.0.0.0/30', 2],
    ['-s 10.0.0.1 --mask-src 255.255.255.0', 2],
    ['-s 2001:db8::1', 1],
    ['-s 2001:db8::/64', 1],
    ['-s 2001:db9::/64', 0],
    ['-d 2001:db8::2 -r 2001:db8::2', 1],
    ['-f ipv4', 2],
    ['-f ipv6', 1],
    ['-p udp', 1],
    ['-p 17', 1],
    ['-p UDP', 1],
    ['-p icmp', 1],
    ['-p icmpv6', 1],
    ['-p tcp', 0],
    ['-p udp --sport 4000', 1],
    ['-p udp --sport 4001', 0],
    ['-p udp --dport 9999', 1],
    ['-p udp --dport 9998', 0],
    ['-p udp --reply-port-src 9999', 1],
    ['-p udp --reply-port-dst 4000', 1],
    ['-p udp --orig-port-src 4000', 1],
    ['-p icmp --icmp-type 8', 1],
    ['-p icmp --icmp-type 0', 0],
    ['-p icmp --icmp-code 0', 1],
    ['-p icmp --icmp-code 1', 0],
    ['-p icmpv6 --icmpv6-type 128', 1],
    ['-u SEEN_REPLY', 2],
    ['-u UNREPLIED', 1],
    ['-u ASSURED', 0],
    ['-u SEEN_REPLY,ASSURED', 0],
    ["-u '!ASSURED'", 3],
    ["-u '!SEEN_REPLY'", 1],
    ['-m 0', 3],
    ['-m 1', 0],
    ['-m 0/0', 3],
    ['-m 08', 3],
    ['-m 0x0', 3],
    ['-m 5/0', 0],
    ['-m 010', 0],
    ['-w 0', 3],
    ['-w 5', 0],
    ['-w 65536', 3],
    ['-w 0x10000', 3],
    ['-s 10.0.0.1/', 2],
    ["-s '10.0.0.1/ 24'", 2],
    ['-s 10.0.0.1/+24', 2],
    ['-s 0.0.0.0/0', 2],
    ['-s 0.0.0.0/1', 2],
    ['-s 128.0.0.0/1', 0],
    ['-s ::/0', 1],
    ['-s 2001:db8::/33', 1],
    ['-s 2001:db8:8000::/33', 0],
    ['-p icmp --icmp-type 264', 1],
    ['-p udp --dport 65535', 0],
    ['-p udp --dport 65536', 0],
    ['-p udp --sport 69536', 1],
    ['-s 10.0.0.1 -p udp -d 10.0.0.2 --dport 9999', 1],
    ['-s 10.0.0.1 -p udp -d 10.0.0.2 --dport 80', 0],
  ])('conntrack -L %s lists %i of the three flows', async (args, expected) => {
    const { a } = await flowsLab();
    expect(labFlows(await a.executeCommand(`sudo conntrack -L ${args}`)).length).toBe(expected);
  });

  it('the line that closes the listing counts what was listed, on the same invocation', async () => {
    const { a } = await flowsLab();
    const out = await a.executeCommand('sudo conntrack -L -p icmp');
    expect(out.split('\n').at(-1)).toBe(`${VERSION_LINE}: 1 flow entries have been shown.`);
  });

  it('a filter that matches nothing is still a successful listing', async () => {
    const { a } = await flowsLab();
    expect(await a.executeCommand(withStatus('conntrack -L -p tcp'))).toBe(`${VERSION_LINE}: 0 flow entries have been shown.\nrc=0`);
  });

  it('-o extended prefixes the layer 3 protocol the way the library writes it, and -o userspace does not', async () => {
    const { a } = await flowsLab();
    const extended = labFlows(await a.executeCommand('sudo conntrack -L -o extended'));
    expect(extended.filter((line) => line.startsWith('ipv4     2 ')).length).toBe(2);
    expect(extended.filter((line) => line.startsWith('ipv6     10 ')).length).toBe(1);
    expect(labFlows(await a.executeCommand('sudo conntrack -L -o userspace')).every((line) => !line.startsWith('ipv'))).toBe(true);
  });
});

describe('conntrack -D removes the entries -L would show, and says how many', () => {
  it('prints each entry it removed, then the count, and the table no longer has them', async () => {
    const { a } = await flowsLab();
    const out = await a.executeCommand(withStatus('conntrack -D -p udp -d 10.0.0.2'));
    expect(out).toMatch(/^udp {6}17 \d+ src=10\.0\.0\.1 dst=10\.0\.0\.2 sport=4000 dport=9999 \[UNREPLIED\] .* mark=0 use=1\n/);
    expect(out.endsWith(`${VERSION_LINE}: 1 flow entries have been deleted.\nrc=0`)).toBe(true);
    expect(labFlows(await a.executeCommand('sudo conntrack -L -p udp')).length).toBe(0);
    expect(labFlows(await a.executeCommand('sudo conntrack -L')).length).toBe(2);
  });

  it('a second deletion finds nothing : 0 entries and status 1, the only command whose success is a count', async () => {
    const { a } = await flowsLab();
    await a.executeCommand('sudo conntrack -D -p udp -d 10.0.0.2');
    expect(await a.executeCommand(withStatus('conntrack -D -p udp -d 10.0.0.2'))).toBe(`${VERSION_LINE}: 0 flow entries have been deleted.\nrc=1`);
  });

  it('without a family it takes both, with one only that family', async () => {
    const { a } = await flowsLab();
    await a.executeCommand('sudo conntrack -D -f ipv6 -p icmpv6');
    expect(labFlows(await a.executeCommand('sudo conntrack -L')).length).toBe(2);
    await a.executeCommand('sudo conntrack -D -d 10.0.0.2');
    expect(labFlows(await a.executeCommand('sudo conntrack -L')).length).toBe(0);
  });

  it('-F with a family empties that family and says so', async () => {
    const { a } = await flowsLab();
    expect(await a.executeCommand(withStatus('conntrack -F -f ipv6'))).toBe(`${VERSION_LINE}: connection tracking table has been emptied.\nrc=0`);
    expect(labFlows(await a.executeCommand('sudo conntrack -L')).length).toBe(2);
    await a.executeCommand('sudo conntrack -F');
    expect(labFlows(await a.executeCommand('sudo conntrack -L')).length).toBe(0);
  });
});

describe('conntrack -S and -C answer for the machine they run on', () => {
  it('-S writes one line per processor, the counters on the first and zeros on the others', async () => {
    const { a } = await flowsLab();
    const processors = Number(await a.executeCommand('nproc'));
    const rows = (await a.executeCommand('sudo conntrack -S')).split('\n');
    expect(processors).toBeGreaterThan(1);
    expect(rows.length).toBe(processors);
    expect(rows[0]).toMatch(/^cpu=0 {3}\tfound=\d+ invalid=\d+ insert=[1-9]\d* /);
    expect(rows[1]).toBe('cpu=1   \tfound=0 invalid=0 insert=0 insert_failed=0 drop=0 early_drop=0 error=0 search_restart=0 clash_resolve=0 chaintoolong=0 ');
  });

  it('the expectation table has its own three counters and no entry', async () => {
    const { a } = linuxPair();
    const rows = (await a.executeCommand('sudo conntrack -S expect')).split('\n');
    expect(rows[0]).toBe('cpu=0   \texpect_new=0 expect_create=0 expect_delete=0 ');
    expect(await a.executeCommand('sudo conntrack -C expect')).toBe('0');
  });
});

const SYN = 0x02;
const SYN_ACK = 0x12;
const ACK = 0x10;

function tcpLab() {
  const { a, b } = linuxPair();
  const tracker = (a as unknown as { executor: { iptables: { connections: ConnectionTracker } } }).executor.iptables.connections;
  const segment = (from: 'a' | 'b', port: number, tcpFlags: number): void => {
    const toward = from === 'a';
    tracker.confirm(tracker.enter({
      protocol: 6, srcIP: toward ? '10.0.0.1' : '10.0.0.2', srcPort: toward ? 40000 + port : port,
      dstIP: toward ? '10.0.0.2' : '10.0.0.1', dstPort: toward ? port : 40000 + port, tcpFlags,
    }));
  };
  segment('a', 22, SYN);
  segment('b', 22, SYN_ACK);
  segment('a', 22, ACK);
  segment('a', 80, SYN);
  a.sendUdpDatagram(new IPAddress('10.0.0.2'), 9999, 4000, 'hello', 5);
  return { a, b };
}

describe('conntrack filters the TCP state and the assurance of a flow', () => {
  it.each([
    ['-p tcp', 2],
    ['-u ASSURED', 1],
    ['-u SEEN_REPLY,ASSURED', 1],
    ["-u '!ASSURED'", 2],
    ['-u UNREPLIED', 2],
    ['-u SEEN_REPLY', 1],
    ['-p tcp --state ESTABLISHED', 1],
    ['-p tcp --state SYN_SENT', 1],
    ['-p tcp --state TIME_WAIT', 0],
    ['-p tcp -u ASSURED --state ESTABLISHED', 1],
    ['-p tcp -u ASSURED --state SYN_SENT', 0],
    ['-p udp', 1],
    ['-u FIXED_TIMEOUT', 0],
    ['-u EXPECTED', 0],
  ])('conntrack -L %s lists %i of the three flows', async (args, expected) => {
    const { a } = tcpLab();
    const rows = (await a.executeCommand(`sudo conntrack -L ${args}`)).split('\n').filter((line) => /^(tcp|udp)\s+\d+ \d+ /.test(line) && line.includes('dst=10.0.0.2 '));
    expect(rows.length).toBe(expected);
  });

  it('TEMOIN : the lab holds an established connection, a connection that was never answered and a datagram', async () => {
    const { a } = tcpLab();
    const listing = await a.executeCommand('sudo conntrack -L -f ipv4');
    expect(listing).toMatch(/^tcp {6}6 \d+ ESTABLISHED src=10\.0\.0\.1 dst=10\.0\.0\.2 sport=40022 dport=22 src=10\.0\.0\.2 dst=10\.0\.0\.1 sport=22 dport=40022 \[ASSURED\] /m);
    expect(listing).toMatch(/^tcp {6}6 \d+ SYN_SENT src=10\.0\.0\.1 dst=10\.0\.0\.2 sport=40080 dport=80 \[UNREPLIED\] /m);
  });
});

describe('an IPv6 prefix is compared word by word, down to the bit', () => {
  const lab = () => {
    const { a } = linuxPair();
    const tracker = (a as unknown as { executor: { ip6tables: { connections: ConnectionTracker } } }).executor.ip6tables.connections;
    tracker.confirm(tracker.enter({ protocol: 17, srcIP: '2001:db8:0:0:8000::1', srcPort: 4000, dstIP: '2001:db8::2', dstPort: 9999 }));
    return a;
  };
  const shown = async (a: ReturnType<typeof lab>, args: string): Promise<number> =>
    (await a.executeCommand(`sudo conntrack -L -f ipv6 ${args}`)).split('\n').filter((line) => line.includes('src=2001:db8:0:0:8000::1 ')).length;

  it.each([
    ['-s 2001:db8::/32', 1],
    ['-s 2001:db8::/63', 1],
    ['-s 2001:db8::/64', 1],
    ['-s 2001:db8::/65', 0],
    ['-s 2001:db8:0:0:8000::/65', 1],
    ['-s 2001:db8::1/128', 0],
    ['-s ::/0', 1],
  ])('conntrack -L %s lists %i of the flows whose source has the 65th bit set', async (args, expected) => {
    expect(await shown(lab(), args)).toBe(expected);
  });
});

describe('the declared options of conntrack are the ones man writes', () => {
  it.each(['-s ip', '-d ip', '-r ip', '-q ip', '-p proto', '-f proto', '-u status', '-m mark', '-o type'])('man conntrack lists %s with its argument', async (option) => {
    const { a } = linuxPair();
    expect(await a.executeCommand('man conntrack')).toContain(option);
  });

  it('flushing the expectation table is a success and says so', async () => {
    const { a } = linuxPair();
    expect(await a.executeCommand(withStatus('conntrack -F expect'))).toBe(`${VERSION_LINE}: expectation table has been emptied.\nrc=0`);
  });
});

