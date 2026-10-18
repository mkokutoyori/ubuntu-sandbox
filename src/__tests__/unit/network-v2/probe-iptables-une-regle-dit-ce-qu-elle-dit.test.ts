/**
 * Une regle iptables/ip6tables DECIDE sur ce qu'elle dit, et ce qu'elle ne sait pas dire est refuse a la saisie. L'analyse de regle
 * (`parseRule`) sautait en silence tout mot qu'elle ne connaissait pas (`default: break`) et rangeait les options des modules `tcp`, `udp`
 * et `icmp` dans une liste que l'evaluation ne lisait jamais : la regle gardait l'air d'exister et perdait son effet -- c'est-a-dire
 * qu'elle correspondait a PLUS de trafic que ce que l'operateur avait ecrit.
 *
 * Mesure de depart (2da9bf8d, un LinuxPC, `iptables -S` puis `filterPacket` sur des paquets types) :
 *     -A INPUT -p tcp -m tcp --dport 22 -j DROP        ->  le TCP du port 80 est jete aussi : c'est la forme que `iptables-save` ecrit
 *     -A INPUT -p tcp ! --dport 22 -j DROP             ->  la negation est perdue : le port 22 est jete, pas les autres
 *     -A INPUT -p tcp --syn -j DROP                    ->  rangee `-p tcp -j DROP` : tout le TCP tombe, ACK compris
 *     -A INPUT -p tcp --tcp-flags SYN,ACK SYN -j DROP  ->  idem (jugee depuis le lot « criteres inconnus », jamais evaluee)
 *     -A INPUT -p icmp --icmp-type 8 -j DROP           ->  rangee `-p icmp -j DROP` : l'echo-reply tombe aussi
 *     -A INPUT -p icmpv6 --icmpv6-type 128 -j DROP     ->  idem, et le voisinage (NS/NA) tombe avec
 *     -A INPUT -f -j DROP                              ->  rangee `-j DROP` : TOUT tombe
 *     -A INPUT --foo -j DROP, ... --dport 22 bar -j .. ->  `--foo` et `bar` disparaissent ; la regle est acceptee
 *     -A INPUT -j DROP --foo                           ->  l'option inconnue d'une cible disparait de meme
 *     -j REDIRECT --to-port 8080                       ->  liste `--to-port` ; iptables -S ecrit `--to-ports 8080` (getopt accepte l'abreviation)
 *     -m multiport ! --dports 22,80, ! --ports 22      ->  le `!` disparait : la regle jette ce qu'elle devait laisser passer
 *     -m multiport --source-ports / --destination-ports, --ports  ->  l'alias long et `--ports` sont ignores : la regle jette tout le TCP
 *     -m mac|iprange|state|conntrack|recent ! ...      ->  idem : le `!` disparait, la regle correspond au CONTRAIRE de son texte
 *     -m conntrack --ctstate NEW --ctproto tcp         ->  l'option inconnue du module disparait : la regle prend plus que son texte
 *     -g SUB                                           ->  traite comme -j SUB : un RETURN dans SUB revient a l'appelante
 * et les compteurs d'octets d'une regle ajoutaient 64 par paquet quelle que soit sa taille.
 *
 * Autorites : iptables 1.8.7 -- extensions/libxt_tcp.c (--sport/--dport/--syn/--tcp-flags/--tcp-option, leurs messages « Only one ...
 * allowed », « --tcp-flags requires two args. », « Unknown TCP flag `%s' », « Bad TCP option "%s" », l'ordre FIN,SYN,RST,PSH,ACK,URG de
 * l'ecriture et `--syn` = `--tcp-flags FIN,SYN,RST,ACK SYN`), extensions/libipt_icmp.c et libip6t_icmp6.c (les deux tables de noms, la
 * recherche par PREFIXE insensible a la casse, « Ambiguous ICMP type `%s': `%s' or `%s'? », « Invalid ICMP type `%s' », le format
 * `type[/code]`, `any`, l'ecriture `--icmp-type %u[/%u]`), iptables/xshared.c command_default (« unknown option "%s" », « option "%s"
 * requires an argument ») et iptables/xtables.c (« Bad argument `%s' », puis la ligne « Try `iptables -h' or 'iptables --help' for more
 * information. » que xtables_error ajoute a toute erreur de parametre). Le noyau : xt_tcpudp et xt_icmp valident le protocole
 * (EINVAL), et icmp_type_code_match donne `(type == t && min <= code <= max) ^ invert`, avec 0xFF pour « any ».
 *
 * Choix de l'ecriture : le module est range dans la regle comme CHAMPS (ports, drapeaux, type ICMP), une seule representation pour
 * `-p tcp --dport 22` et `-p tcp -m tcp --dport 22`, donc `-C`/`-D` les confondent. Un module que le moteur ne sait pas evaluer
 * (`addrtype`, `mark`, `connmark`, `owner`, `pkttype`, `length`, `ttl`, `hashlimit`, `string`) reste ACCEPTE et liste -- le vrai
 * iptables le connait -- mais NE CORRESPOND A RIEN : une regle qu'on ne sait pas decider ne devient pas plus large que son texte. Meme
 * sort pour une OPTION qu'un module evalue ne decide pas (`--ctproto`, `! --limit`) : la regle echoue FERMEE, elle n'ignore pas l'option.
 *
 * Discrimination : 258 des 285 cas tombent contre 2da9bf8d (les sources remises a leur etat, la sonde conservee). Vingt-sept passent
 * des deux cotes, et pourquoi. TEMOINS (vingt : le moteur d'avant decidait deja ces formes, ou la sonde prouve que le banc est sain) :
 * « -p tcp --dport 22 », multiport positif en --dports et en --sports, mac et iprange positifs, les cinq protocoles que multiport
 * accepte (tcp, udp, udplite, 132, 33), un module qui s'arrete la ou commencent les options de la regle (comment, mac puis --source,
 * multiport puis --syn), « -j avant -p », « -j SUB revient a l'appelante », « les modules que le moteur evalue continuent de decider »,
 * « -C distingue deux regles par chaque option de leurs modules et par leur negation », « une regle batie par un autre sous-systeme,
 * sans ensemble de negation, est la regle que -C retrouve » et la somme de controle d'un segment contre une somme independante.
 * COINCIDENCES (quatre) : « -p tcp --sport 1:1000 » (le paquet type porte le port 40000 : la regle ne le prend ni avant ni apres),
 * « --icmp-type any » (rangee `-p icmp -j DROP`, elle jetait deja tout l'ICMP, ce qu'`any` demande), « --ports 1000:50000 » (tous les
 * flux ont un port dans la plage, et la regle sans critere les jetait aussi) et « -c 0 0 » (les compteurs lus etaient deja a zero).
 * STRUCTURELS (trois) : « -S montre ce qui a ete tape » pour un module non evalue (il etait deja liste), et les deux octets que la
 * capture ecrit d'un en-tete TCP -- decalage de donnees et octet des drapeaux -- dont le lot a ferme la copie sans changer la valeur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, IPv6Address, MACAddress, SubnetMask, createIPv4Packet, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxIptablesManager, type PacketInfo } from '@/network/devices/linux/LinuxIptablesManager';
import { computeTcpChecksum, noFlags, tcpFlagBits, type TcpFlags, type TcpOption, type TcpSegment } from '@/network/tcp/types';
import { tcpOptionKindNumber } from '@/network/tcp/TcpOptionsCodec';
import { decodeEthernetFrame, makeTcpFrame } from '@/network/devices/linux/network/tcpdump/CaptureFrame';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface FirewalledHost {
  executor: { iptables: LinuxIptablesManager; ip6tables: LinuxIptablesManager };
}

const managerOf = (host: LinuxPC, family: 4 | 6): LinuxIptablesManager => (host as unknown as FirewalledHost).executor[family === 6 ? 'ip6tables' : 'iptables'];

const TCP = 6;
const UDP = 17;
const ICMP = 1;
const ICMPV6 = 58;
const FIN = 0x01;
const SYN = 0x02;
const RST = 0x04;
const PSH = 0x08;
const ACK = 0x10;
const URG = 0x20;

function facts(protocol: number, extra: Partial<PacketInfo> = {}): PacketInfo {
  return { direction: 'in', protocol, srcIP: '10.0.0.2', dstIP: '10.0.0.1', srcPort: 40000, dstPort: 0, iface: 'eth0', ipPacketBytes: 60, ...extra };
}

const tcp = (dstPort: number, tcpFlags: number, extra: Partial<PacketInfo> = {}): PacketInfo => facts(TCP, { dstPort, tcpFlags, ...extra });
const icmp = (icmpType: number, icmpCode = 0): PacketInfo => facts(ICMP, { srcPort: 0, icmpType, icmpCode });
const icmpv6 = (icmpType: number, icmpCode = 0): PacketInfo => facts(ICMPV6, { srcPort: 0, icmpType, icmpCode, isV6: true });

async function verdicts(
  family: 4 | 6, rule: string, packets: Record<string, PacketInfo>,
): Promise<{ answer: string; verdicts: Record<string, string> }> {
  const host = new LinuxPC('H', 0, 0);
  const tool = family === 6 ? 'ip6tables' : 'iptables';
  const answer = await host.executeCommand(`sudo ${tool} -A INPUT ${rule}`);
  const manager = managerOf(host, family);
  const seen: Record<string, string> = {};
  for (const [name, packet] of Object.entries(packets)) seen[name] = manager.filterPacket(packet);
  return { answer, verdicts: seen };
}

function lab() {
  const a = new LinuxPC('A', 0, 0);
  const b = new LinuxPC('B', 0, 0);
  new Cable('c').connect(a.getPort('eth0')!, b.getPort('eth0')!);
  a.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
  b.configureIPv6Interface('eth0', new IPv6Address('2001:db8::2'), 64);
  a.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  b.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { a, b };
}

const tryLine = (tool: string) => `\nTry \`${tool} -h' or '${tool} --help' for more information.`;

describe('the module options decide the packet', () => {
  it.each([
    ['-p tcp -m tcp --dport 22 -j DROP', { p22: 'drop', p80: 'accept' }],
    ['-p tcp --dport 22 -j DROP', { p22: 'drop', p80: 'accept' }],
    ['-p tcp -m tcp --sport 40000 --dport 22 -j DROP', { p22: 'drop', p80: 'accept' }],
    ['-p tcp ! --dport 22 -j DROP', { p22: 'accept', p80: 'drop' }],
    ['-p tcp -m tcp ! --dport 22 -j DROP', { p22: 'accept', p80: 'drop' }],
    ['-p tcp ! --sport 40000 -j DROP', { p22: 'accept', p80: 'accept' }],
    ['-p tcp --sport 1:1000 -j DROP', { p22: 'accept', p80: 'accept' }],
    ['-p tcp ! --sport 1:1000 -j DROP', { p22: 'drop', p80: 'drop' }],
  ])('%s', async (rule, expected) => {
    const { answer, verdicts: seen } = await verdicts(4, rule, { p22: tcp(22, SYN), p80: tcp(80, SYN) });
    expect(answer).toBe('');
    expect(seen).toEqual(expected);
  });

  it('-m udp is the same thing for UDP, and a TCP packet never reaches it', async () => {
    const { answer, verdicts: seen } = await verdicts(4, '-p udp -m udp --dport 53 -j DROP', {
      dns: facts(UDP, { dstPort: 53 }), other: facts(UDP, { dstPort: 5300 }), tcp53: tcp(53, SYN),
    });
    expect(answer).toBe('');
    expect(seen).toEqual({ dns: 'drop', other: 'accept', tcp53: 'accept' });
  });
});

describe('the flags byte of a TCP segment has one writing, and the checksum reads it', () => {
  it.each([['fin', 0x01], ['syn', 0x02], ['rst', 0x04], ['psh', 0x08], ['ack', 0x10], ['urg', 0x20], ['ece', 0x40], ['cwr', 0x80]] as const)(
    '%s is the bit %i of the byte',
    (name, bit) => {
      expect(tcpFlagBits({ ...noFlags(), [name]: true })).toBe(bit);
      expect(tcpFlagBits({ ...noFlags(), fin: true, syn: true, rst: true, psh: true, ack: true, urg: true, ece: true, cwr: true, [name]: false })).toBe(0xFF - bit);
    },
  );

  it.each([
    [{ kind: 'end' }, 0], [{ kind: 'nop' }, 1], [{ kind: 'mss', value: 1460 }, 2], [{ kind: 'window-scale', shift: 7 }, 3],
    [{ kind: 'sack-permitted' }, 4], [{ kind: 'sack', blocks: [] }, 5], [{ kind: 'timestamp', tsVal: 1, tsEcr: 0 }, 8],
  ] as ReadonlyArray<readonly [TcpOption, number]>)('the option %j travels with the kind number %i that --tcp-option reads', (option, kind) => {
    expect(tcpOptionKindNumber(option)).toBe(kind);
  });

  it('the capture writes the offset and the flags byte of a synthesised header', () => {
    const frame = makeTcpFrame({
      at: new Date(0), srcIp: '10.0.0.1', srcPort: 40000, dstIp: '10.0.0.2', dstPort: 22, flags: 'S.', seq: 1, ack: 2, length: 0,
    }, 'eth0');
    expect(frame.raw.slice(32, 34)).toEqual([0x50, 0x12]);
  });

  it('the capture writes the data offset and the flags byte of a segment that crossed the wire', () => {
    const segment: TcpSegment = {
      type: 'tcp', sourcePort: 40000, destinationPort: 22, sequence: 1, acknowledgement: 0, dataOffset: 7,
      flags: { ...noFlags(), syn: true, ece: true }, window: 1000, checksum: 0, urgentPointer: 0, options: [], payload: undefined,
    };
    const packet = createIPv4Packet(new IPAddress('10.0.0.1'), new IPAddress('10.0.0.2'), 6, 64, segment, 20);
    const frame = decodeEthernetFrame({
      srcMAC: new MACAddress('00:00:00:00:00:01'), dstMAC: new MACAddress('00:00:00:00:00:02'), etherType: 0x0800, payload: packet,
    }, 'eth0', 'in', new Date(0));
    expect(frame.raw.slice(frame.rawLinkOffset + 20 + 12, frame.rawLinkOffset + 20 + 14)).toEqual([0x70, 0x42]);
  });

  it('the checksum of a segment is the one that an independent sum of the pseudo-header and the header gives', () => {
    const segment = (flags: Partial<TcpFlags>): TcpSegment => ({
      type: 'tcp', sourcePort: 40000, destinationPort: 22, sequence: 1000, acknowledgement: 0, dataOffset: 5,
      flags: { ...noFlags(), ...flags }, window: 64240, checksum: 0, urgentPointer: 0, options: [], payload: undefined,
    });
    expect(computeTcpChecksum(segment({ syn: true }), '10.0.0.1', '10.0.0.2')).toBe(0x00B1);
    expect(computeTcpChecksum(segment({ psh: true, ack: true }), '10.0.0.1', '10.0.0.2')).toBe(0x009B);
  });
});

describe('TCP flags', () => {
  const stream = { syn: tcp(22, SYN), ack: tcp(22, ACK), synack: tcp(22, SYN | ACK), finack: tcp(22, FIN | ACK), rst: tcp(22, RST), none: tcp(22, 0), xmas: tcp(22, FIN | PSH | URG), all: tcp(22, 0x3F) };

  it.each([
    ['-p tcp --syn -j DROP', { syn: 'drop', ack: 'accept', synack: 'accept', finack: 'accept', rst: 'accept', none: 'accept', xmas: 'accept', all: 'accept' }],
    ['-p tcp ! --syn -j DROP', { syn: 'accept', ack: 'drop', synack: 'drop', finack: 'drop', rst: 'drop', none: 'drop', xmas: 'drop', all: 'drop' }],
    ['-p tcp --tcp-flags SYN,ACK SYN -j DROP', { syn: 'drop', ack: 'accept', synack: 'accept', finack: 'accept', rst: 'accept', none: 'accept', xmas: 'accept', all: 'accept' }],
    ['-p tcp --tcp-flags SYN,ACK SYN,ACK -j DROP', { syn: 'accept', ack: 'accept', synack: 'drop', finack: 'accept', rst: 'accept', none: 'accept', xmas: 'accept', all: 'drop' }],
    ['-p tcp --tcp-flags ALL NONE -j DROP', { syn: 'accept', ack: 'accept', synack: 'accept', finack: 'accept', rst: 'accept', none: 'drop', xmas: 'accept', all: 'accept' }],
    ['-p tcp --tcp-flags ALL ALL -j DROP', { syn: 'accept', ack: 'accept', synack: 'accept', finack: 'accept', rst: 'accept', none: 'accept', xmas: 'accept', all: 'drop' }],
    ['-p tcp --tcp-flags ALL FIN,PSH,URG -j DROP', { syn: 'accept', ack: 'accept', synack: 'accept', finack: 'accept', rst: 'accept', none: 'accept', xmas: 'drop', all: 'accept' }],
    ['-p tcp --tcp-flags FIN,SYN FIN,SYN -j DROP', { syn: 'accept', ack: 'accept', synack: 'accept', finack: 'accept', rst: 'accept', none: 'accept', xmas: 'accept', all: 'drop' }],
    ['-p tcp ! --tcp-flags SYN,ACK SYN -j DROP', { syn: 'accept', ack: 'drop', synack: 'drop', finack: 'drop', rst: 'drop', none: 'drop', xmas: 'drop', all: 'drop' }],
    ['-p tcp -m tcp --syn --dport 22 -j DROP', { syn: 'drop', ack: 'accept', synack: 'accept', finack: 'accept', rst: 'accept', none: 'accept', xmas: 'accept', all: 'accept' }],
    ['-p tcp --tcp-flags syn,ack syn -j DROP', { syn: 'drop', ack: 'accept', synack: 'accept', finack: 'accept', rst: 'accept', none: 'accept', xmas: 'accept', all: 'accept' }],
  ])('%s', async (rule, expected) => {
    const { answer, verdicts: seen } = await verdicts(4, rule, stream);
    expect(answer).toBe('');
    expect(seen).toEqual(expected);
  });

  it('a SYN to another port is not caught by `--syn --dport 22`, and a SYN without flags facts decides nothing', async () => {
    const { verdicts: seen } = await verdicts(4, '-p tcp --syn --dport 22 -j DROP', {
      other: tcp(80, SYN), unknown: facts(TCP, { dstPort: 22 }),
    });
    expect(seen).toEqual({ other: 'accept', unknown: 'accept' });
  });

  it('--tcp-option matches the kind that the segment carries', async () => {
    const { answer, verdicts: seen } = await verdicts(4, '-p tcp --tcp-option 8 -j DROP', {
      timestamps: tcp(22, SYN, { tcpOptions: [2, 4, 8, 1, 3] }), plain: tcp(22, SYN, { tcpOptions: [2] }), bare: tcp(22, SYN, { tcpOptions: [] }),
    });
    expect(answer).toBe('');
    expect(seen).toEqual({ timestamps: 'drop', plain: 'accept', bare: 'accept' });
  });

  it.each([1, 255])('the kind %i is a bound of --tcp-option and it decides', async (kind) => {
    const { answer, verdicts: seen } = await verdicts(4, `-p tcp --tcp-option ${kind} -j DROP`, {
      carried: tcp(22, SYN, { tcpOptions: [kind] }), other: tcp(22, SYN, { tcpOptions: [2] }),
    });
    expect(answer).toBe('');
    expect(seen).toEqual({ carried: 'drop', other: 'accept' });
  });

  it('! --tcp-option is the opposite', async () => {
    const { seen } = await verdicts(4, '-p tcp ! --tcp-option 8 -j DROP', {
      timestamps: tcp(22, SYN, { tcpOptions: [8] }), plain: tcp(22, SYN, { tcpOptions: [2] }),
    }).then(({ verdicts: v }) => ({ seen: v }));
    expect(seen).toEqual({ timestamps: 'accept', plain: 'drop' });
  });
});

describe('ICMP types and codes, in the two families', () => {
  const echo = { request: icmp(8), reply: icmp(0), port: icmp(3, 3), host: icmp(3, 1), exceeded: icmp(11) };

  it.each([
    ['-p icmp --icmp-type 8 -j DROP', { request: 'drop', reply: 'accept', port: 'accept', host: 'accept', exceeded: 'accept' }],
    ['-p icmp -m icmp --icmp-type echo-request -j DROP', { request: 'drop', reply: 'accept', port: 'accept', host: 'accept', exceeded: 'accept' }],
    ['-p icmp --icmp-type ping -j DROP', { request: 'drop', reply: 'accept', port: 'accept', host: 'accept', exceeded: 'accept' }],
    ['-p icmp --icmp-type echo-req -j DROP', { request: 'drop', reply: 'accept', port: 'accept', host: 'accept', exceeded: 'accept' }],
    ['-p icmp --icmp-type pong -j DROP', { request: 'accept', reply: 'drop', port: 'accept', host: 'accept', exceeded: 'accept' }],
    ['-p icmp ! --icmp-type 8 -j DROP', { request: 'accept', reply: 'drop', port: 'drop', host: 'drop', exceeded: 'drop' }],
    ['-p icmp --icmp-type destination-unreachable -j DROP', { request: 'accept', reply: 'accept', port: 'drop', host: 'drop', exceeded: 'accept' }],
    ['-p icmp --icmp-type port-unreachable -j DROP', { request: 'accept', reply: 'accept', port: 'drop', host: 'accept', exceeded: 'accept' }],
    ['-p icmp --icmp-type 3/3 -j DROP', { request: 'accept', reply: 'accept', port: 'drop', host: 'accept', exceeded: 'accept' }],
    ['-p icmp --icmp-type 3 -j DROP', { request: 'accept', reply: 'accept', port: 'drop', host: 'drop', exceeded: 'accept' }],
    ['-p icmp --icmp-type any -j DROP', { request: 'drop', reply: 'drop', port: 'drop', host: 'drop', exceeded: 'drop' }],
    ['-p icmp ! --icmp-type any -j DROP', { request: 'accept', reply: 'accept', port: 'accept', host: 'accept', exceeded: 'accept' }],
    ['-p icmp --icmp-type time-exceeded -j DROP', { request: 'accept', reply: 'accept', port: 'accept', host: 'accept', exceeded: 'drop' }],
    ['-p icmp --icmp-type 0x08 -j DROP', { request: 'drop', reply: 'accept', port: 'accept', host: 'accept', exceeded: 'accept' }],
  ])('IPv4 : %s', async (rule, expected) => {
    const { answer, verdicts: seen } = await verdicts(4, rule, echo);
    expect(answer).toBe('');
    expect(seen).toEqual(expected);
  });

  const v6 = { request: icmpv6(128), reply: icmpv6(129), ns: icmpv6(135), na: icmpv6(136), port: icmpv6(1, 4), noRoute: icmpv6(1, 0), tooBig: icmpv6(2) };

  it.each([
    ['-p icmpv6 --icmpv6-type 128 -j DROP', { request: 'drop', reply: 'accept', ns: 'accept', na: 'accept', port: 'accept', noRoute: 'accept', tooBig: 'accept' }],
    ['-p ipv6-icmp --icmpv6-type echo-request -j DROP', { request: 'drop', reply: 'accept', ns: 'accept', na: 'accept', port: 'accept', noRoute: 'accept', tooBig: 'accept' }],
    ['-p 58 -m icmp6 --icmpv6-type ping -j DROP', { request: 'drop', reply: 'accept', ns: 'accept', na: 'accept', port: 'accept', noRoute: 'accept', tooBig: 'accept' }],
    ['-p icmpv6 --icmpv6-type neighbour-solicitation -j DROP', { request: 'accept', reply: 'accept', ns: 'drop', na: 'accept', port: 'accept', noRoute: 'accept', tooBig: 'accept' }],
    ['-p icmpv6 --icmpv6-type neighbor-advertisement -j DROP', { request: 'accept', reply: 'accept', ns: 'accept', na: 'drop', port: 'accept', noRoute: 'accept', tooBig: 'accept' }],
    ['-p icmpv6 --icmpv6-type port-unreachable -j DROP', { request: 'accept', reply: 'accept', ns: 'accept', na: 'accept', port: 'drop', noRoute: 'accept', tooBig: 'accept' }],
    ['-p icmpv6 --icmpv6-type destination-unreachable -j DROP', { request: 'accept', reply: 'accept', ns: 'accept', na: 'accept', port: 'drop', noRoute: 'drop', tooBig: 'accept' }],
    ['-p icmpv6 --icmpv6-type packet-too-big -j DROP', { request: 'accept', reply: 'accept', ns: 'accept', na: 'accept', port: 'accept', noRoute: 'accept', tooBig: 'drop' }],
    ['-p icmpv6 ! --icmpv6-type 128 -j DROP', { request: 'accept', reply: 'drop', ns: 'drop', na: 'drop', port: 'drop', noRoute: 'drop', tooBig: 'drop' }],
    ['-p icmpv6 --icmpv6-type 1/0 -j DROP', { request: 'accept', reply: 'accept', ns: 'accept', na: 'accept', port: 'accept', noRoute: 'drop', tooBig: 'accept' }],
  ])('IPv6 : %s', async (rule, expected) => {
    const { answer, verdicts: seen } = await verdicts(6, rule, v6);
    expect(answer).toBe('');
    expect(seen).toEqual(expected);
  });
});

describe('fragments (-f) and the length of the packet', () => {
  it.each([
    ['-f -j DROP', { first: 'accept', later: 'drop' }],
    ['! -f -j DROP', { first: 'drop', later: 'accept' }],
    ['-p udp -f -j DROP', { first: 'accept', later: 'drop' }],
  ])('%s', async (rule, expected) => {
    const { answer, verdicts: seen } = await verdicts(4, rule, { first: facts(UDP, { fragmentOffset: 0 }), later: facts(UDP, { fragmentOffset: 185 }) });
    expect(answer).toBe('');
    expect(seen).toEqual(expected);
  });

  it('the counters of a rule add the length of the packet, not a constant', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -A INPUT -p icmp -j ACCEPT');
    const manager = managerOf(host, 4);
    manager.filterPacket(icmp(8));
    manager.filterPacket({ ...icmp(8), ipPacketBytes: 1500 });
    const listing = await host.executeCommand('sudo iptables -L INPUT -v -x -n');
    expect(listing).toMatch(/^\s*2\s+1560\s+ACCEPT\s+icmp/m);
  });
});

describe('what the parser cannot say is refused, with the words of xtables, and nothing is stored', () => {
  it.each([
    ['iptables', '-A INPUT -p tcp --foo -j DROP', 'unknown option "--foo"'],
    ['iptables', '-A INPUT --foo -j DROP', 'unknown option "--foo"'],
    ['iptables', '-A INPUT -p tcp --dport 22 -j DROP --foo', 'unknown option "--foo"'],
    ['iptables', '-A INPUT -j ACCEPT --reject-with icmp-port-unreachable', 'unknown option "--reject-with"'],
    ['iptables', '-A INPUT --dport 22 -j DROP', 'unknown option "--dport"'],
    ['iptables', '-A INPUT -p icmp --dport 22 -j DROP', 'unknown option "--dport"'],
    ['iptables', '-A INPUT -p udp --syn -j DROP', 'unknown option "--syn"'],
    ['iptables', '-A INPUT -p udp --tcp-flags SYN SYN -j DROP', 'unknown option "--tcp-flags"'],
    ['iptables', '-A INPUT -p tcp --icmp-type 8 -j DROP', 'unknown option "--icmp-type"'],
    ['iptables', '-A INPUT --icmp-type 8 -j DROP', 'unknown option "--icmp-type"'],
    ['iptables', '-A INPUT -p icmp --icmpv6-type 128 -j DROP', 'unknown option "--icmpv6-type"'],
    ['ip6tables', '-A INPUT -p icmpv6 --icmp-type 128 -j DROP', 'unknown option "--icmp-type"'],
    ['ip6tables', '-A INPUT -f -j DROP', 'unknown option "-f"'],
    ['iptables', '-A INPUT -p tcp --dport', 'option "--dport" requires an argument'],
    ['iptables', '-A INPUT -p tcp --dport 22 --dport 23 -j DROP', 'Only one `--destination-port\' allowed'],
    ['iptables', '-A INPUT -p tcp --sport 22 --sport 23 -j DROP', 'Only one `--source-port\' allowed'],
    ['iptables', '-A INPUT -p tcp --syn --tcp-flags SYN SYN -j DROP', 'Only one of `--syn\' or `--tcp-flags\'  allowed'],
    ['iptables', '-A INPUT -p tcp --tcp-flags SYN -j DROP', '--tcp-flags requires two args.'],
    ['iptables', '-A INPUT -p tcp --tcp-flags zorglub SYN -j DROP', 'Unknown TCP flag `zorglub\''],
    ['iptables', '-A INPUT -p tcp --tcp-flags SYN,ACK zorglub -j DROP', 'Unknown TCP flag `zorglub\''],
    ['iptables', '-A INPUT -p tcp --tcp-option 0 -j DROP', 'Bad TCP option "0"'],
    ['iptables', '-A INPUT -p tcp --tcp-option 300 -j DROP', 'Bad TCP option "300"'],
    ['iptables', '-A INPUT -p icmp --icmp-type echo -j DROP', 'Ambiguous ICMP type `echo\': `echo-reply\' or `echo-request\'?'],
    ['ip6tables', '-A INPUT -p icmpv6 --icmpv6-type neighbo -j DROP', 'Ambiguous ICMPv6 type `neighbo\': `neighbour-solicitation\' or `neighbor-solicitation\'?'],
  ])('%s %s -> %s', async (tool, rule, message) => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand(`sudo ${tool} ${rule}`)).toBe(`${tool} v1.8.7 (nf_tables): ${message}${tryLine(tool)}`);
    expect(await host.executeCommand(`sudo ${tool} -S INPUT`)).toBe('-P INPUT ACCEPT');
  });

  it.each([
    ['-A INPUT -p icmp --icmp-type 300 -j DROP', 'Invalid ICMP type `300\'\n'],
    ['-A INPUT -p icmp --icmp-type zorglub -j DROP', 'Invalid ICMP type `zorglub\'\n'],
    ['-A INPUT -p icmp --icmp-type 3/300 -j DROP', 'Invalid ICMP code `300\'\n'],
    ['-A INPUT -p icmp --icmp-type 3/zorglub -j DROP', 'Invalid ICMP code `zorglub\'\n'],
  ])('%s -> a message that ends with its own line break, then the usual help line', async (rule, message) => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand(`sudo iptables ${rule}`)).toBe(`iptables v1.8.7 (nf_tables): ${message}${tryLine('iptables')}`);
  });

  it('a stray word is « Bad argument », with no program prefix', async () => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand('sudo iptables -A INPUT -p tcp --dport 22 bar -j DROP'))
      .toBe(`Bad argument \`bar'${tryLine('iptables')}`);
    expect(await host.executeCommand('sudo iptables -S INPUT')).toBe('-P INPUT ACCEPT');
  });

  it.each([
    ['-A INPUT -p udp -m tcp --dport 22 -j DROP'],
    ['-A INPUT -m tcp --dport 22 -j DROP'],
    ['-A INPUT -p tcp -m icmp --icmp-type 8 -j DROP'],
    ['-A INPUT -p icmp -m udp -j DROP'],
  ])('a module for another protocol is refused by the kernel check (Invalid argument) : %s', async (rule) => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand(`sudo iptables ${rule}`))
      .toBe('iptables v1.8.7 (nf_tables):  RULE_APPEND failed (Invalid argument): rule in chain INPUT');
    expect(await host.executeCommand('sudo iptables -S INPUT')).toBe('-P INPUT ACCEPT');
  });

  it('TEMOIN : the words that are options of something are still taken', async () => {
    const host = new LinuxPC('H', 0, 0);
    for (const rule of [
      '-A INPUT -p tcp --dport 22 -j ACCEPT', '-w -A INPUT -p tcp --dport 23 -j ACCEPT', '-A INPUT -w 2 -p tcp --dport 24 -j ACCEPT',
      '-A INPUT -c 5 600 -p udp --dport 53 -j ACCEPT', '-A INPUT -p tcp --dport 25 -m comment --comment "mail" -j ACCEPT',
      '-A INPUT -m state --state NEW,ESTABLISHED -j ACCEPT', '-A INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT',
      '-A INPUT -j LOG --log-prefix "x: " --log-level 4', '-A INPUT -p tcp --dport 26 -j REJECT --reject-with tcp-reset',
    ]) expect(await host.executeCommand(`sudo iptables ${rule}`)).toBe('');
  });
});

describe('a module that the engine cannot decide matches nothing, and is still listed', () => {
  it.each([
    '-m addrtype --src-type LOCAL', '-m mark --mark 1', '-m connmark --mark 1', '-m owner --uid-owner 1000',
    '-m pkttype --pkt-type broadcast', '-m length --length 1000:1500', '-m ttl --ttl-eq 1', '-m string --string GET --algo bm',
  ])('%s -j DROP drops nothing', async (module) => {
    const { answer, verdicts: seen } = await verdicts(4, `${module} -j DROP`, { tcp: tcp(22, SYN), ping: icmp(8) });
    expect(answer).toBe('');
    expect(seen).toEqual({ tcp: 'accept', ping: 'accept' });
  });

  it('and `-S` still shows what was typed', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -A INPUT -m addrtype --src-type LOCAL -j DROP');
    expect(await host.executeCommand('sudo iptables -S INPUT')).toContain('-A INPUT -m addrtype --src-type LOCAL -j DROP');
  });

  it('TEMOIN : the modules the engine does decide keep deciding', async () => {
    const { answer, verdicts: seen } = await verdicts(4, '-p tcp -m multiport --dports 22,80 -j DROP', { p22: tcp(22, SYN), p25: tcp(25, SYN) });
    expect(answer).toBe('');
    expect(seen).toEqual({ p22: 'drop', p25: 'accept' });
  });
});

describe('the rule is written back the way it was said, one representation per fact', () => {
  it('-S writes the canonical text of every option', async () => {
    const host = new LinuxPC('H', 0, 0);
    for (const rule of [
      '-p tcp --syn -j DROP', '-p tcp ! --dport 22 -j DROP', '-p tcp -m tcp --sport 1024:65535 --dport 80 -j ACCEPT',
      '-p tcp --tcp-flags syn,ack,fin,rst syn -j DROP', '-p tcp --tcp-flags ALL NONE -j DROP', '-p tcp ! --tcp-option 8 -j DROP',
      '-p icmp --icmp-type echo-request -j DROP', '-p icmp -m icmp ! --icmp-type port-unreachable -j DROP', '-p icmp --icmp-type any -j DROP',
      '-p icmp --icmp-type destination-unreachable -j DROP', '-f -j DROP', '! -f -j DROP',
    ]) await host.executeCommand(`sudo iptables -A INPUT ${rule}`);
    expect(await host.executeCommand('sudo iptables -S INPUT')).toBe([
      '-P INPUT ACCEPT',
      '-A INPUT -p tcp --tcp-flags FIN,SYN,RST,ACK SYN -j DROP',
      '-A INPUT -p tcp ! --dport 22 -j DROP',
      '-A INPUT -p tcp --sport 1024:65535 --dport 80 -j ACCEPT',
      '-A INPUT -p tcp --tcp-flags FIN,SYN,RST,ACK SYN -j DROP',
      '-A INPUT -p tcp --tcp-flags FIN,SYN,RST,PSH,ACK,URG NONE -j DROP',
      '-A INPUT -p tcp ! --tcp-option 8 -j DROP',
      '-A INPUT -p icmp --icmp-type 8 -j DROP',
      '-A INPUT -p icmp ! --icmp-type 3/3 -j DROP',
      '-A INPUT -p icmp --icmp-type any -j DROP',
      '-A INPUT -p icmp --icmp-type 3 -j DROP',
      '-A INPUT -f -j DROP',
      '-A INPUT ! -f -j DROP',
    ].join('\n'));
  });

  it('-S writes the ICMPv6 type with its own option', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo ip6tables -A INPUT -p icmpv6 --icmpv6-type echo-request -j ACCEPT');
    await host.executeCommand('sudo ip6tables -A INPUT -p icmpv6 ! --icmpv6-type 1/4 -j ACCEPT');
    expect(await host.executeCommand('sudo ip6tables -S INPUT')).toBe([
      '-P INPUT ACCEPT',
      '-A INPUT -p icmpv6 --icmpv6-type 128 -j ACCEPT',
      '-A INPUT -p icmpv6 ! --icmpv6-type 1/4 -j ACCEPT',
    ].join('\n'));
  });

  it('-L shows the ports once, the flags and the type in the words of the match', async () => {
    const host = new LinuxPC('H', 0, 0);
    for (const rule of [
      '-p tcp --sport 1024 --dport 22 --tcp-flags SYN,ACK SYN -j DROP', '-p tcp ! --dport 80 -j DROP', '-p icmp --icmp-type echo-request -j DROP',
      '-p icmp --icmp-type 3/3 -j DROP', '-p icmp ! --icmp-type 12 -j DROP', '-f -j DROP', '! -f -j DROP', '-p udp ! --sport 1:1023 -j DROP',
    ]) await host.executeCommand(`sudo iptables -A INPUT ${rule}`);
    const plain = (await host.executeCommand('sudo iptables -L INPUT')).split('\n');
    const numeric = (await host.executeCommand('sudo iptables -L INPUT -n')).split('\n');
    expect(plain[2]).toMatch(/tcp spt:\w+ dpt:\w+ flags:SYN,ACK\/SYN$/);
    expect(numeric[2]).toMatch(/tcp spt:1024 dpt:22 flags:0x12\/0x02$/);
    expect(numeric[3]).toMatch(/tcp dpt:!80$/);
    expect(plain[4]).toMatch(/icmp echo-request$/);
    expect(numeric[4]).toMatch(/icmptype 8$/);
    expect(plain[5]).toMatch(/icmp port-unreachable$/);
    expect(numeric[5]).toMatch(/icmptype 3 code 3$/);
    expect(plain[6]).toMatch(/icmp !parameter-problem$/);
    expect(numeric[6]).toMatch(/icmp !type 12$/);
    expect(numeric[7]).toMatch(/^DROP\s+all\s+-f\s+0\.0\.0\.0\/0/);
    expect(numeric[8]).toMatch(/^DROP\s+all\s+!f\s+0\.0\.0\.0\/0/);
    expect(numeric[9]).toMatch(/udp spts:!1:1023$/);
  });

  it('-L shows the ICMPv6 type behind ipv6-icmp, in the words and the numbers of the match', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo ip6tables -A INPUT -p icmpv6 --icmpv6-type echo-request -j ACCEPT');
    await host.executeCommand('sudo ip6tables -A INPUT -p icmpv6 ! --icmpv6-type 1/4 -j ACCEPT');
    const plain = (await host.executeCommand('sudo ip6tables -L INPUT')).split('\n');
    const numeric = (await host.executeCommand('sudo ip6tables -L INPUT -n')).split('\n');
    expect(plain[2]).toMatch(/ipv6-icmp echo-request$/);
    expect(plain[3]).toMatch(/ipv6-icmp !port-unreachable$/);
    expect(numeric[2]).toMatch(/ipv6-icmptype 128$/);
    expect(numeric[3]).toMatch(/ipv6-icmp !type 1 code 4$/);
  });

  it('the same rule typed with or without the module is the same rule for -C and -D', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -A INPUT -p tcp -m tcp --dport 22 -j DROP');
    expect(await host.executeCommand('sudo iptables -C INPUT -p tcp --dport 22 -j DROP')).toBe('');
    expect(await host.executeCommand('sudo iptables -D INPUT -p tcp --dport 22 -j DROP')).toBe('');
    expect(await host.executeCommand('sudo iptables -S INPUT')).toBe('-P INPUT ACCEPT');
    await host.executeCommand('sudo iptables -A INPUT -p icmp --icmp-type echo-request -j DROP');
    expect(await host.executeCommand('sudo iptables -C INPUT -p icmp -m icmp --icmp-type 8 -j DROP')).toBe('');
    expect(await host.executeCommand('sudo iptables -C INPUT -p icmp --icmp-type 0 -j DROP')).toContain('Bad rule');
    expect(await host.executeCommand('sudo iptables -C INPUT -p tcp ! --dport 22 -j DROP')).toContain('Bad rule');
  });

  it('-C tells two rules apart by each option of their modules and by the negation of each', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -A INPUT -p tcp -m limit --limit 3/min --limit-burst 5 -m multiport --dports 22,80 -j ACCEPT');
    const check = (rule: string): Promise<string> => host.executeCommand(`sudo iptables -C INPUT ${rule}`);
    expect(await check('-p tcp -m limit --limit 3/min --limit-burst 5 -m multiport --dports 22,80 -j ACCEPT')).toBe('');
    expect(await check('-p tcp -m limit --limit 3/min --limit-burst 6 -m multiport --dports 22,80 -j ACCEPT')).toContain('Bad rule');
    expect(await check('-p tcp -m limit --limit 3/min --limit-burst 5 -m multiport --dports 22,81 -j ACCEPT')).toContain('Bad rule');
    expect(await check('-p tcp -m limit --limit 3/min --limit-burst 5 -m multiport ! --dports 22,80 -j ACCEPT')).toContain('Bad rule');
  });

  it('a rule that another subsystem built, with no negation set on its modules, is the rule that -C finds when it is typed', async () => {
    const host = new LinuxPC('H', 0, 0);
    const manager = managerOf(host, 4);
    manager.appendRule('filter', 'INPUT', LinuxIptablesManager.createRule({
      protocol: 'tcp', target: 'DROP', matches: [{ module: 'comment', options: new Map([['--comment', 'built']]) }],
    }));
    expect(await host.executeCommand('sudo iptables -C INPUT -p tcp -m comment --comment built -j DROP')).toBe('');
    expect(await host.executeCommand('sudo iptables -C INPUT -p tcp -m comment --comment other -j DROP')).toContain('Bad rule');
  });

  it('save then restore gives back rules that decide the same way', async () => {
    const host = new LinuxPC('H', 0, 0);
    for (const rule of ['-p tcp --syn -j DROP', '-p tcp ! --dport 22 -j DROP', '-p icmp --icmp-type echo-request -j DROP', '-f -j DROP'])
      await host.executeCommand(`sudo iptables -A INPUT ${rule}`);
    const saved = await host.executeCommand('sudo iptables-save');
    await host.executeCommand('sudo iptables -F');
    expect(await host.executeCommand('sudo iptables -S INPUT')).toBe('-P INPUT ACCEPT');
    await host.executeCommand(`cat > /tmp/rules.v4 <<'EOF'\n${saved}\nEOF`);
    await host.executeCommand('sudo iptables-restore < /tmp/rules.v4');
    const manager = managerOf(host, 4);
    expect(manager.filterPacket(tcp(22, SYN))).toBe('drop');
    expect(manager.filterPacket(icmp(8))).toBe('drop');
    expect(manager.filterPacket(tcp(22, ACK))).toBe('accept');
    expect(manager.filterPacket(icmp(0))).toBe('accept');
  });

  it('REDIRECT --to-port is the getopt abbreviation of --to-ports and is written in full', async () => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand('sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 8080')).toBe('');
    expect(await host.executeCommand('sudo iptables -t nat -S PREROUTING')).toContain('-j REDIRECT --to-ports 8080');
  });
});

describe('on the wire : a rule on the type of the message lets the other types through', () => {
  it('IPv4 : B drops echo requests and nothing else', async () => {
    const { a, b } = lab();
    await b.executeCommand('sudo iptables -A INPUT -p icmp --icmp-type echo-request -j DROP');
    const toB = await pingOnSimulatedClock(a, 'ping -c 1 -W 1 10.0.0.2');
    expect(toB).toContain('1 packets transmitted, 0 received, 100% packet loss');
    const toA = await pingOnSimulatedClock(b, 'ping -c 1 -W 1 10.0.0.1');
    expect(toA).toContain('64 bytes from 10.0.0.1: icmp_seq=1');
  });

  it('IPv6 : B drops echo requests, and the neighbour discovery that lets B answer is untouched', async () => {
    const { a, b } = lab();
    await b.executeCommand('sudo ip6tables -A INPUT -p icmpv6 --icmpv6-type echo-request -j DROP');
    const toB = await pingOnSimulatedClock(a, 'ping -6 -c 1 -W 1 2001:db8::2');
    expect(toB).toContain('1 packets transmitted, 0 received, 100% packet loss');
    expect(toB).not.toContain('Address unreachable');
    const toA = await pingOnSimulatedClock(b, 'ping -6 -c 1 -W 1 2001:db8::1');
    expect(toA).toContain('64 bytes from 2001:db8::1: icmp_seq=1');
  });

  it('IPv6 : the reply is a type of its own, and a rule on it blocks the replies that A would get', async () => {
    const { a, b } = lab();
    await a.executeCommand('sudo ip6tables -A INPUT -p icmpv6 --icmpv6-type echo-reply -j DROP');
    expect(await pingOnSimulatedClock(a, 'ping -6 -c 1 -W 1 2001:db8::2')).toContain('100% packet loss');
    expect(await pingOnSimulatedClock(b, 'ping -6 -c 1 -W 1 2001:db8::1')).toContain('64 bytes from 2001:db8::1: icmp_seq=1');
  });

  it('IPv4 : a rule on the type and the code catches the error of that code and lets the others through', async () => {
    const { a, b } = lab();
    await b.executeCommand('sudo iptables -A INPUT -p icmp --icmp-type echo-request -j REJECT');
    await a.executeCommand('sudo iptables -A INPUT -p icmp --icmp-type 3/1 -j DROP');
    expect(await pingOnSimulatedClock(a, 'ping -c 1 -W 1 10.0.0.2')).toContain('Destination Port Unreachable');
    await a.executeCommand('sudo iptables -F INPUT');
    await a.executeCommand('sudo iptables -A INPUT -p icmp --icmp-type 3/3 -j DROP');
    expect(await pingOnSimulatedClock(a, 'ping -c 1 -W 1 10.0.0.2')).not.toContain('Destination Port Unreachable');
  });

  it('IPv6 : a rule on the type and the code catches the error of that code and lets the others through', async () => {
    const { a, b } = lab();
    await b.executeCommand('sudo ip6tables -A INPUT -p icmpv6 --icmpv6-type echo-request -j REJECT');
    await a.executeCommand('sudo ip6tables -A INPUT -p icmpv6 --icmpv6-type 1/3 -j DROP');
    expect(await pingOnSimulatedClock(a, 'ping -6 -c 1 -W 1 2001:db8::2')).toContain('Destination unreachable: Port unreachable');
    await a.executeCommand('sudo ip6tables -F INPUT');
    await a.executeCommand('sudo ip6tables -A INPUT -p icmpv6 --icmpv6-type 1/4 -j DROP');
    expect(await pingOnSimulatedClock(a, 'ping -6 -c 1 -W 1 2001:db8::2')).not.toContain('Destination unreachable');
  });

  it('IPv4 : the length of the packet reaches the counters of the rule', async () => {
    const { a, b } = lab();
    await b.executeCommand('sudo iptables -A INPUT -p icmp --icmp-type echo-request -j ACCEPT');
    await pingOnSimulatedClock(a, 'ping -c 2 10.0.0.2');
    expect(await b.executeCommand('sudo iptables -L INPUT -v -x -n')).toMatch(/^\s*2\s+168\s+ACCEPT\s+icmp/m);
  });
});

const ICMPV4_SOURCE_TABLE: ReadonlyArray<readonly [string, number, number, number]> = [
  ['any', 255, 0, 255],
  ['echo-reply', 0, 0, 255],
  ['pong', 0, 0, 255],
  ['destination-unreachable', 3, 0, 255],
  ['network-unreachable', 3, 0, 0],
  ['host-unreachable', 3, 1, 1],
  ['protocol-unreachable', 3, 2, 2],
  ['port-unreachable', 3, 3, 3],
  ['fragmentation-needed', 3, 4, 4],
  ['source-route-failed', 3, 5, 5],
  ['network-unknown', 3, 6, 6],
  ['host-unknown', 3, 7, 7],
  ['network-prohibited', 3, 9, 9],
  ['host-prohibited', 3, 10, 10],
  ['TOS-network-unreachable', 3, 11, 11],
  ['TOS-host-unreachable', 3, 12, 12],
  ['communication-prohibited', 3, 13, 13],
  ['host-precedence-violation', 3, 14, 14],
  ['precedence-cutoff', 3, 15, 15],
  ['source-quench', 4, 0, 255],
  ['redirect', 5, 0, 255],
  ['network-redirect', 5, 0, 0],
  ['host-redirect', 5, 1, 1],
  ['TOS-network-redirect', 5, 2, 2],
  ['TOS-host-redirect', 5, 3, 3],
  ['echo-request', 8, 0, 255],
  ['ping', 8, 0, 255],
  ['router-advertisement', 9, 0, 255],
  ['router-solicitation', 10, 0, 255],
  ['time-exceeded', 11, 0, 255],
  ['ttl-exceeded', 11, 0, 255],
  ['ttl-zero-during-transit', 11, 0, 0],
  ['ttl-zero-during-reassembly', 11, 1, 1],
  ['parameter-problem', 12, 0, 255],
  ['ip-header-bad', 12, 0, 0],
  ['required-option-missing', 12, 1, 1],
  ['timestamp-request', 13, 0, 255],
  ['timestamp-reply', 14, 0, 255],
  ['address-mask-request', 17, 0, 255],
  ['address-mask-reply', 18, 0, 255],
];

const ICMPV6_SOURCE_TABLE: ReadonlyArray<readonly [string, number, number, number]> = [
  ['destination-unreachable', 1, 0, 255],
  ['no-route', 1, 0, 0],
  ['communication-prohibited', 1, 1, 1],
  ['beyond-scope', 1, 2, 2],
  ['address-unreachable', 1, 3, 3],
  ['port-unreachable', 1, 4, 4],
  ['failed-policy', 1, 5, 5],
  ['reject-route', 1, 6, 6],
  ['packet-too-big', 2, 0, 255],
  ['time-exceeded', 3, 0, 255],
  ['ttl-exceeded', 3, 0, 255],
  ['ttl-zero-during-transit', 3, 0, 0],
  ['ttl-zero-during-reassembly', 3, 1, 1],
  ['parameter-problem', 4, 0, 255],
  ['bad-header', 4, 0, 0],
  ['unknown-header-type', 4, 1, 1],
  ['unknown-option', 4, 2, 2],
  ['echo-request', 128, 0, 255],
  ['ping', 128, 0, 255],
  ['echo-reply', 129, 0, 255],
  ['pong', 129, 0, 255],
  ['router-solicitation', 133, 0, 255],
  ['router-advertisement', 134, 0, 255],
  ['neighbour-solicitation', 135, 0, 255],
  ['neighbor-solicitation', 135, 0, 255],
  ['neighbour-advertisement', 136, 0, 255],
  ['neighbor-advertisement', 136, 0, 255],
  ['redirect', 137, 0, 255],
];

describe('every name of the two xtables tables means its type and its codes', () => {
  const written = (type: number, min: number, max: number): string =>
    type === 255 ? 'any' : min !== 0 || max !== 255 ? `${type}/${min}` : String(type);

  it.each(ICMPV4_SOURCE_TABLE)('IPv4 : %s -> type %i, codes %i..%i', async (name, type, min, max) => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand(`sudo iptables -A INPUT -p icmp --icmp-type ${name} -j DROP`)).toBe('');
    expect(await host.executeCommand('sudo iptables -S INPUT')).toContain(`-A INPUT -p icmp --icmp-type ${written(type, min, max)} -j DROP`);
    const manager = managerOf(host, 4);
    if (type === 255) {
      expect(manager.filterPacket(icmp(8))).toBe('drop');
      return;
    }
    expect(manager.filterPacket(icmp(type, min))).toBe('drop');
    expect(manager.filterPacket(icmp(type, max))).toBe('drop');
    if (max < 255) expect(manager.filterPacket(icmp(type, max + 1))).toBe('accept');
    if (min > 0) expect(manager.filterPacket(icmp(type, min - 1))).toBe('accept');
    expect(manager.filterPacket(icmp(type === 254 ? 253 : type + 1, min))).toBe('accept');
  });

  it.each(ICMPV6_SOURCE_TABLE)('IPv6 : %s -> type %i, codes %i..%i', async (name, type, min, max) => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand(`sudo ip6tables -A INPUT -p icmpv6 --icmpv6-type ${name} -j DROP`)).toBe('');
    expect(await host.executeCommand('sudo ip6tables -S INPUT')).toContain(`-A INPUT -p icmpv6 --icmpv6-type ${written(type, min, max)} -j DROP`);
    const manager = managerOf(host, 6);
    expect(manager.filterPacket(icmpv6(type, min))).toBe('drop');
    expect(manager.filterPacket(icmpv6(type, max))).toBe('drop');
    if (max < 255) expect(manager.filterPacket(icmpv6(type, max + 1))).toBe('accept');
    if (min > 0) expect(manager.filterPacket(icmpv6(type, min - 1))).toBe('accept');
    expect(manager.filterPacket(icmpv6(type + 1, min))).toBe('accept');
  });

  it.each([
    ['010', '8'],
    ['0x08', '8'],
    ['0x10', '16'],
    ['0', '0'],
    ['00', '0'],
    ['255', 'any'],
    ['0xff', 'any'],
    ['3/010', '3/8'],
    ['3/255', '3/255'],
  ])('a number is read in base 0 as strtoul does : --icmp-type %s is written %s', async (typed, written) => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand(`sudo iptables -A INPUT -p icmp --icmp-type ${typed} -j DROP`)).toBe('');
    expect(await host.executeCommand('sudo iptables -S INPUT')).toContain(`--icmp-type ${written} -j DROP`);
  });

  it.each(['08', '09', '256', '0x100', '1e1', '-1'])('--icmp-type %s is not a number xtables accepts', async (typed) => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand(`sudo iptables -A INPUT -p icmp --icmp-type '${typed}' -j DROP`)).toContain('Invalid ICMP type');
    expect(await host.executeCommand('sudo iptables -S INPUT')).toBe('-P INPUT ACCEPT');
  });

  it('an empty type is a prefix of every name, so the first two rows of the table are the ambiguity', async () => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand("sudo iptables -A INPUT -p icmp --icmp-type '' -j DROP"))
      .toBe(`iptables v1.8.7 (nf_tables): Ambiguous ICMP type \`': \`any' or \`echo-reply'?${tryLine('iptables')}`);
  });

  it('a prefix shared by several names is ambiguous, and a longer prefix of one of them is taken', async () => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand('sudo iptables -A INPUT -p icmp --icmp-type host -j DROP'))
      .toBe(`iptables v1.8.7 (nf_tables): Ambiguous ICMP type \`host': \`host-unreachable' or \`host-unknown'?${tryLine('iptables')}`);
    expect(await host.executeCommand('sudo iptables -A INPUT -p icmp --icmp-type host-unr -j DROP')).toBe('');
    expect(await host.executeCommand('sudo iptables -S INPUT')).toContain('--icmp-type 3/1');
  });
});

describe('module options can be inverted, and an option the engine cannot decide matches nothing', () => {
  const flows = {
    p22: tcp(22, SYN), p80: tcp(80, SYN), p25: tcp(25, SYN),
    reply22: tcp(40000, ACK, { srcPort: 22 }),
  };

  it.each([
    ['-p tcp -m multiport --dports 22,80 -j DROP', { p22: 'drop', p80: 'drop', p25: 'accept', reply22: 'accept' }],
    ['-p tcp -m multiport ! --dports 22,80 -j DROP', { p22: 'accept', p80: 'accept', p25: 'drop', reply22: 'drop' }],
    ['-p tcp -m multiport --destination-ports 22,80 -j DROP', { p22: 'drop', p80: 'drop', p25: 'accept', reply22: 'accept' }],
    ['-p tcp -m multiport --sports 22 -j DROP', { p22: 'accept', p80: 'accept', p25: 'accept', reply22: 'drop' }],
    ['-p tcp -m multiport --source-ports 22 -j DROP', { p22: 'accept', p80: 'accept', p25: 'accept', reply22: 'drop' }],
    ['-p tcp -m multiport ! --sports 22 -j DROP', { p22: 'drop', p80: 'drop', p25: 'drop', reply22: 'accept' }],
    ['-p tcp -m multiport --ports 22 -j DROP', { p22: 'drop', p80: 'accept', p25: 'accept', reply22: 'drop' }],
    ['-p tcp -m multiport ! --ports 22 -j DROP', { p22: 'accept', p80: 'drop', p25: 'drop', reply22: 'accept' }],
    ['-p tcp -m multiport --ports 1000:50000 -j DROP', { p22: 'drop', p80: 'drop', p25: 'drop', reply22: 'drop' }],
  ])('%s', async (rule, expected) => {
    const { answer, verdicts: seen } = await verdicts(4, rule, flows);
    expect(answer).toBe('');
    expect(seen).toEqual(expected);
  });

  it('-S writes the module options in the canonical long names, the inverted ones behind a !', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -A INPUT -p tcp -m multiport ! --destination-ports 22,80 -j DROP');
    await host.executeCommand('sudo iptables -A INPUT -m mac ! --mac-source 00:11:22:33:44:55 -j DROP');
    expect(await host.executeCommand('sudo iptables -S INPUT')).toBe([
      '-P INPUT ACCEPT',
      '-A INPUT -p tcp -m multiport ! --dports 22,80 -j DROP',
      '-A INPUT -m mac ! --mac-source 00:11:22:33:44:55 -j DROP',
    ].join('\n'));
  });

  it('-L shows the negation where the print function of each module puts it', async () => {
    const host = new LinuxPC('H', 0, 0);
    for (const rule of [
      '-p tcp -m multiport ! --dports 22,80 -j DROP', '-m mac ! --mac-source 00:11:22:33:44:55 -j DROP',
      '-m state ! --state NEW -j DROP', '-m conntrack ! --ctstate ESTABLISHED -j DROP', '-p tcp -m multiport --sports 22 -j DROP',
    ]) await host.executeCommand(`sudo iptables -A INPUT ${rule}`);
    const lines = (await host.executeCommand('sudo iptables -L INPUT -n')).split('\n');
    expect(lines[2]).toMatch(/multiport dports {2}!22,80$/);
    expect(lines[3]).toMatch(/MAC !00:11:22:33:44:55$/);
    expect(lines[4]).toMatch(/ ! state NEW$/);
    expect(lines[5]).toMatch(/ ! ctstate ESTABLISHED$/);
    expect(lines[6]).toMatch(/multiport sports 22$/);
  });

  it.each([
    ['-m mac --mac-source 00:11:22:33:44:55 -j DROP', { same: 'drop', other: 'accept', unknown: 'accept' }],
    ['-m mac ! --mac-source 00:11:22:33:44:55 -j DROP', { same: 'accept', other: 'drop', unknown: 'accept' }],
  ])('%s', async (rule, expected) => {
    const { answer, verdicts: seen } = await verdicts(4, rule, {
      same: facts(UDP, { macAddress: '00:11:22:33:44:55' }), other: facts(UDP, { macAddress: '00:11:22:33:44:66' }), unknown: facts(UDP),
    });
    expect(answer).toBe('');
    expect(seen).toEqual(expected);
  });

  it.each([
    ['-m iprange --src-range 10.0.0.1-10.0.0.9 -j DROP', { inside: 'drop', outside: 'accept' }],
    ['-m iprange ! --src-range 10.0.0.1-10.0.0.9 -j DROP', { inside: 'accept', outside: 'drop' }],
    ['-m iprange --dst-range 10.0.0.1-10.0.0.1 -j DROP', { inside: 'drop', outside: 'drop' }],
    ['-m iprange ! --dst-range 10.0.0.1-10.0.0.1 -j DROP', { inside: 'accept', outside: 'accept' }],
  ])('%s', async (rule, expected) => {
    const { answer, verdicts: seen } = await verdicts(4, rule, {
      inside: facts(UDP, { srcIP: '10.0.0.2' }), outside: facts(UDP, { srcIP: '10.0.1.2' }),
    });
    expect(answer).toBe('');
    expect(seen).toEqual(expected);
  });

  it('! --state inverts the connection state : the first packet is new, the next one of the same flow is not', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -A INPUT -m state ! --state NEW -j DROP');
    const manager = managerOf(host, 4);
    const inbound = tcp(22, SYN);
    expect(manager.filterPacket(inbound)).toBe('accept');
    expect(manager.filterPacket(inbound)).toBe('drop');
  });

  it('! --ctstate is the same on conntrack', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -A INPUT -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP');
    const manager = managerOf(host, 4);
    const inbound = tcp(22, SYN);
    expect(manager.filterPacket(inbound)).toBe('drop');
    manager.filterPacket({ ...tcp(40000, ACK, { srcPort: 22 }), direction: 'out', srcIP: '10.0.0.1', dstIP: '10.0.0.2' });
    expect(manager.filterPacket(inbound)).toBe('accept');
  });

  it('! --rcheck matches the source that is NOT in the list yet', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -A INPUT -m recent ! --rcheck --name L -j DROP');
    expect(managerOf(host, 4).filterPacket(tcp(22, SYN))).toBe('drop');
  });

  it.each([
    '-m conntrack --ctstate NEW --ctproto tcp -j DROP',
    '-m conntrack --ctorigsrc 10.0.0.2 --ctdir ORIGINAL -j DROP',
    '-m recent --set --rttl --name L -j DROP',
  ])('%s is a rule that iptables knows, is listed, and decides nothing', async (rule) => {
    const { answer, verdicts: seen } = await verdicts(4, rule, { syn: tcp(22, SYN) });
    expect(answer).toBe('');
    expect(seen).toEqual({ syn: 'accept' });
  });
});

describe('-c sets the counters of the rule, in the words of iptables.c', () => {
  it.each([
    ['-c 5 600 -p tcp --dport 22 -j ACCEPT', 5, 600],
    ['-c 7,900 -p tcp --dport 22 -j ACCEPT', 7, 900],
    ['-p tcp --dport 22 -c 0 0 -j ACCEPT', 0, 0],
    ['-c 12abc 34xyz -p tcp --dport 22 -j ACCEPT', 12, 34],
  ])('%s', async (rule, packets, bytes) => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand(`sudo iptables -A INPUT ${rule}`)).toBe('');
    expect(await host.executeCommand('sudo iptables -L INPUT -v -x -n')).toMatch(new RegExp(`^\\s*${packets}\\s+${bytes}\\s+ACCEPT`, 'm'));
  });

  it.each([
    ['-A INPUT -c', 'option "-c" requires an argument'],
    ['-A INPUT -c 5', '-c requires packet and byte counter'],
    ['-A INPUT -c 5 -j ACCEPT', '-c requires packet and byte counter'],
    ['-A INPUT -c five 600 -j ACCEPT', '-c packet counter not numeric'],
    ['-A INPUT -c 5 six -j ACCEPT', '-c byte counter not numeric'],
    ['-A INPUT -c 5,six -j ACCEPT', '-c byte counter not numeric'],
  ])('%s is refused : %s', async (rule, message) => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand(`sudo iptables ${rule}`)).toBe(`iptables v1.8.7 (nf_tables): ${message}${tryLine('iptables')}`);
    expect(await host.executeCommand('sudo iptables -S INPUT')).toBe('-P INPUT ACCEPT');
  });
});

describe('the options of a module are the options of that module, as getopt reads them', () => {
  it('a rule option after a module option is still the rule\'s : -m state --state NEW --dport 80 after -p tcp', async () => {
    const { answer, verdicts: seen } = await verdicts(4, '-p tcp -m state --state NEW --dport 80 -j DROP', {
      p80: tcp(80, SYN), p81: tcp(81, SYN),
    });
    expect(answer).toBe('');
    expect(seen).toEqual({ p80: 'drop', p81: 'accept' });
  });

  it.each([
    ['-m comment --comment "a rule" -j DROP', 'comment'],
    ['-m limit --limit 3/min --jump DROP', 'limit'],
    ['-m mac --mac-source 00:11:22:33:44:55 --source 10.0.0.2 -j DROP', 'mac'],
    ['-p tcp -m multiport --dports 22,80 --syn -j DROP', 'multiport'],
  ])('%s : the module stops where the rule options begin', async (rule) => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand(`sudo iptables -A INPUT ${rule}`)).toBe('');
    expect(await host.executeCommand('sudo iptables -S INPUT')).toContain('-j DROP');
  });

  it('and the target of such a rule is read : the packet that matches is dropped', async () => {
    const { answer, verdicts: seen } = await verdicts(4, '-p tcp -m multiport --dports 22,80 --syn -j DROP', {
      syn: tcp(22, SYN), ack: tcp(22, ACK), other: tcp(25, SYN),
    });
    expect(answer).toBe('');
    expect(seen).toEqual({ syn: 'drop', ack: 'accept', other: 'accept' });
  });

  it.each([
    ['-m state -j DROP', 'state: option "--state" must be specified\n'],
    ['-m mac -j DROP', 'mac: option "--mac-source" must be specified\n'],
    ['-m comment -j DROP', 'comment: option "--comment" must be specified\n'],
    ['-m state --state NEW --state ESTABLISHED -j DROP', 'state: option "--state" can only be used once.\n'],
    ['-m state --state', 'state: option "--state" requires an argument.\n'],
    ['-m limit ! --limit 3/min -j DROP', 'limit: option "--limit" cannot be inverted.\n'],
    ['-m limit ! --limit-burst 3 -j DROP', 'limit: option "--limit-burst" cannot be inverted.\n'],
    ['-m recent ! --seconds 60 --set -j DROP', 'recent: option "--seconds" cannot be inverted.\n'],
    ['-m comment ! --comment x -j DROP', 'comment: option "--comment" cannot be inverted.\n'],
    ['-m ttl ! --ttl-gt 3 -j DROP', 'ttl: option "--ttl-gt" cannot be inverted.\n'],
    ['-m recent --name L -j DROP', 'recent: you must specify one of `--set\', `--rcheck\' `--update\' or `--remove\''],
    ['-m string --algo bm -j DROP', 'STRING match: You must specify `--string\' or `--hex-string\''],
    ['-m string --string abc -j DROP', 'string: option "--algo" must be specified\n'],
    ['-m state --state NEW --zorglub -j DROP', 'unknown option "--zorglub"'],
    ['-m conntrack --ctstate NEW --ctzorglub tcp -j DROP', 'unknown option "--ctzorglub"'],
  ])('%s is refused with the words of xtoptions', async (rule, message) => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand(`sudo iptables -A INPUT ${rule}`)).toBe(`iptables v1.8.7 (nf_tables): ${message}${tryLine('iptables')}`);
    expect(await host.executeCommand('sudo iptables -S INPUT')).toBe('-P INPUT ACCEPT');
  });

  it.each([
    ['-m multiport --dports 22,80 -j DROP', "multiport needs `-p tcp', `-p udp', `-p udplite', `-p sctp' or `-p dccp'"],
    ['! -p tcp -m multiport --dports 22,80 -j DROP', 'multiport only works with TCP, UDP, UDPLITE, SCTP and DCCP'],
    ['-p icmp -m multiport --dports 22,80 -j DROP', 'multiport only works with TCP, UDP, UDPLITE, SCTP and DCCP'],
    ['-m multiport --dports 22,80 -p tcp -j DROP', "multiport needs `-p tcp', `-p udp', `-p udplite', `-p sctp' or `-p dccp'"],
  ])('%s : multiport needs a protocol with ports, read before it', async (rule, message) => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand(`sudo iptables -A INPUT ${rule}`)).toBe(`iptables v1.8.7 (nf_tables): ${message}${tryLine('iptables')}`);
  });

  it.each(['tcp', 'udp', 'udplite', '132', '33'])('TEMOIN : -p %s -m multiport is accepted', async (protocol) => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand(`sudo iptables -A INPUT -p ${protocol} -m multiport --dports 22,80 -j DROP`)).toBe('');
  });

  it.each([
    ['-m ttl --ttl 64 -j DROP', '-m ttl --ttl-eq 64'],
    ['-m hashlimit --hashlimit 1/s --hashlimit-name n -j DROP', '-m hashlimit --hashlimit-upto 1/s --hashlimit-name n'],
    ['-p tcp -m multiport --source-ports 22 -j DROP', '-m multiport --sports 22'],
  ])('%s : the long alias is written with the canonical name', async (rule, written) => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand(`sudo iptables -A INPUT ${rule}`)).toBe('');
    expect(await host.executeCommand('sudo iptables -S INPUT')).toContain(written);
  });
});

describe('the order of the words is the order of the engine : the protocol first, the target anywhere', () => {
  it('-j DROP before -p tcp --dport 22 is the same rule', async () => {
    const { answer, verdicts: seen } = await verdicts(4, '-j DROP -p tcp --dport 22', { p22: tcp(22, SYN), p80: tcp(80, SYN) });
    expect(answer).toBe('');
    expect(seen).toEqual({ p22: 'drop', p80: 'accept' });
  });

  it('but --dport before -p is an unknown option, as in iptables', async () => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand('sudo iptables -A INPUT --dport 22 -p tcp -j DROP'))
      .toBe(`iptables v1.8.7 (nf_tables): unknown option "--dport"${tryLine('iptables')}`);
  });
});

describe('-g jumps for good : a RETURN in the chain does not come back to the caller', () => {
  async function chains(jump: string): Promise<{ host: LinuxPC; manager: LinuxIptablesManager }> {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -N SUB');
    await host.executeCommand('sudo iptables -A SUB -p tcp --dport 22 -j ACCEPT');
    await host.executeCommand(`sudo iptables -A INPUT -p tcp ${jump} SUB`);
    await host.executeCommand('sudo iptables -A INPUT -j DROP');
    return { host, manager: managerOf(host, 4) };
  }

  it('with -j the packet that SUB lets fall comes back to the next rule of INPUT', async () => {
    const { manager } = await chains('-j');
    expect(manager.filterPacket(tcp(22, SYN))).toBe('accept');
    expect(manager.filterPacket(tcp(80, SYN))).toBe('drop');
  });

  it('with -g it does not : the packet leaves INPUT and meets its policy', async () => {
    const { host, manager } = await chains('-g');
    expect(manager.filterPacket(tcp(22, SYN))).toBe('accept');
    expect(manager.filterPacket(tcp(80, SYN))).toBe('accept');
    expect(await host.executeCommand('sudo iptables -S INPUT')).toContain('-A INPUT -p tcp -g SUB');
  });
});
