/**
 * RFC 6146 (docs/rfc/nat/rfc6146.txt), le traducteur NAT64 a etats, niveau moteur : tables BIB et de
 * sessions, mappage independant de la destination (RFC 4787), appariement d'adresses (§3.6.1.1),
 * filtrage dependant de l'adresse (§1.2.3), machine a etats TCP et delais (§3.5.2), plus la
 * traduction des en-tetes des trois protocoles (TCP, UDP, echo ICMP).
 *
 * Mesure avant correction : aucun traducteur n'existait dans le depot (le mot-cle `nat64` du schema
 * FortiOS etait refuse faute de moteur), donc tout le fichier tombait a l'import. Les temoins qui
 * ne peuvent pas diverger d'une implementation correcte : le paquet SYN traduit porte les adresses
 * IPv4 attendues et une somme TCP verifiee par recalcul independant.
 *
 * RFC 7915 (docs/rfc/nat/rfc7915.txt, telechargee depuis le depot Ubuntu doc-rfc-std-proposed) : sections 4.1
 * et 5.1 pour les en-tetes (TOS/classe de trafic copies, DF a zero jusqu'a 1260 octets, TTL/limite de
 * saut conserve : le routeur decremente), 4.2 et 5.2 pour les tables de codes ICMP et de pointeurs.
 * Les MTU des prochains sauts entrent dans le calcul de l'erreur « packet too big » / « fragmentation
 * needed » (min(...) des sections 4.2 et 5.2) par `nexthopMtu` ; sans lui le calcul reste celui du
 * message seul. Cas ajoutes : 3 ; 2 tombent avant (les deux min qui retiennent un MTU de saut suivant),
 * 1 passe dans les deux etats (le temoin : des MTU de saut suivant plus grands que celui du message ne
 * changent rien).
 * Plusieurs prefixes sur un traducteur (RFC 6052 §3, `secondaryPrefixes`) : 3 cas ajoutes, qui tombent
 * tous avant (le prefixe secondaire n'etait pas reconnu). Le retour d'un flux repart du prefixe par lequel
 * il est entre, les erreurs aussi.
 * Fragments (RFC 7915 §4.1 et §5.1) : l'en-tete de fragment IPv6 devient les champs de fragment IPv4
 * (decalage, MF, identification sur 16 bits) et inversement ; seul le premier fragment porte l'en-tete de
 * transport, les suivants suivent l'etat qu'il a laisse. 6 cas ajoutes, dont 5 tombent avant (un
 * fragment etait refuse comme protocole non pris en charge ; le temoin sans fragment passe). Limite : un fragment qui precede son premier
 * fragment est jete (« fragment-without-head »), la file d'attente que la RFC 6146 autorise n'existe pas.
 */
import { describe, it, expect } from 'vitest';
import {
  IPAddress, IPv6Address, createIPv4Packet, createIPv6Packet, IP_PROTO_ICMP, IP_PROTO_ICMPV6,
  type IPv4Packet, type IPv6Packet, type UDPPacket,
} from '@/network/core/types';
import { computeTcpChecksum, type TcpSegment } from '@/network/tcp/types';
import { Nat64Prefix } from '@/network/nat/nat64/Nat64Prefix';
import { Nat64Translator, NAT64_DEFAULT_TIMEOUTS } from '@/network/nat/nat64/Nat64Translator';
import { fragmentIPv4, IPV4_FLAG_MF } from '@/network/core/Ipv4Fragmentation';
import { fragmentIPv6, ipv6FragmentOf, IPv6Reassembler } from '@/network/layers/internet/Ipv6Fragmentation';

const HOST_A = '2001:db8:1::a';
const HOST_B = '2001:db8:1::b';
const SERVER = '8.8.4.4';
const OTHER = '9.9.9.9';
const POOL = '203.0.113.1';

function lab(pool: string[] = [POOL]) {
  const time = { now: 0 };
  const translator = new Nat64Translator({
    prefix: Nat64Prefix.wellKnownPrefix(), pool: pool.map((a) => new IPAddress(a)), clock: () => time.now,
  });
  return { translator, time };
}

const flagsOf = (f: Partial<Record<'syn' | 'ack' | 'fin' | 'rst', boolean>>) =>
  ({ syn: false, ack: false, fin: false, rst: false, psh: false, urg: false, ...f });

function tcp6(src: string, dst: string, sport: number, dport: number, flags: Partial<Record<'syn' | 'ack' | 'fin' | 'rst', boolean>>): IPv6Packet {
  const segment = { type: 'tcp', sourcePort: sport, destinationPort: dport, sequence: 1000, acknowledgement: 0,
    dataOffset: 5, flags: flagsOf(flags), window: 65535, checksum: 0, urgentPointer: 0, options: [], payload: null };
  return createIPv6Packet(new IPv6Address(src), new IPv6Address(dst), 6, 64, segment, 20, { trafficClass: 0x2e });
}

function tcp4(src: string, dst: string, sport: number, dport: number, flags: Partial<Record<'syn' | 'ack' | 'fin' | 'rst', boolean>>): IPv4Packet {
  const segment = { type: 'tcp', sourcePort: sport, destinationPort: dport, sequence: 5000, acknowledgement: 1001,
    dataOffset: 5, flags: flagsOf(flags), window: 65535, checksum: 0, urgentPointer: 0, options: [], payload: null };
  return createIPv4Packet(new IPAddress(src), new IPAddress(dst), 6, 60, segment, 20);
}

function udp6(src: string, dst: string, sport: number, dport: number): IPv6Packet {
  const datagram: UDPPacket = { type: 'udp', sourcePort: sport, destinationPort: dport, length: 8, checksum: 0, payload: null };
  return createIPv6Packet(new IPv6Address(src), new IPv6Address(dst), 17, 64, datagram, 8);
}

function udp4(src: string, dst: string, sport: number, dport: number): IPv4Packet {
  const datagram: UDPPacket = { type: 'udp', sourcePort: sport, destinationPort: dport, length: 8, checksum: 0, payload: null };
  return createIPv4Packet(new IPAddress(src), new IPAddress(dst), 17, 60, datagram, 8);
}

const toServer = (ip = SERVER) => Nat64Prefix.wellKnownPrefix().synthesize(new IPAddress(ip)).toString();

function unwrap<T>(result: { ok: boolean; packet?: T; reason?: string }): T {
  if (!result.ok) throw new Error(`dropped: ${result.reason}`);
  return result.packet!;
}

describe('RFC 6146 section 3.5: the translation of a TCP connection', () => {
  it('translates a SYN: pool address, the embedded server, the port kept, a checksum that verifies', () => {
    const { translator } = lab();
    const out = unwrap(translator.translate6to4(tcp6(HOST_A, toServer(), 49152, 80, { syn: true })));
    expect(out.sourceIP.toString()).toBe(POOL);
    expect(out.destinationIP.toString()).toBe(SERVER);
    expect(out.protocol).toBe(6);
    expect(out.ttl).toBe(64);
    expect(out.tos).toBe(0x2e);
    expect(out.flags & 0b010).toBe(0);
    const segment = out.payload as unknown as TcpSegment;
    expect(segment.sourcePort).toBe(49152);
    expect(segment.destinationPort).toBe(80);
    const independent = { ...segment, checksum: 0 };
    expect(segment.checksum).toBe(computeTcpChecksum(independent, POOL, SERVER));
    expect(out.totalLength).toBe(40);
  });

  it('translates the SYN-ACK back, and the connection is established', () => {
    const { translator } = lab();
    translator.translate6to4(tcp6(HOST_A, toServer(), 49152, 80, { syn: true }));
    const back = unwrap(translator.translate4to6(tcp4(SERVER, POOL, 80, 49152, { syn: true, ack: true })));
    expect(back.sourceIP.toString()).toBe(toServer());
    expect(back.destinationIP.toString()).toBe(HOST_A);
    expect((back.payload as TcpSegment).destinationPort).toBe(49152);
    expect(back.hopLimit).toBe(60);
    expect(back.trafficClass).toBe(0);
    expect(translator.getSessions()[0].tcpState).toBe('established');
  });

  it('drops a SYN from the IPv4 side that no IPv6 host has opened toward (address-dependent filtering)', () => {
    const { translator } = lab();
    translator.translate6to4(tcp6(HOST_A, toServer(), 49152, 80, { syn: true }));
    const refused = translator.translate4to6(tcp4(OTHER, POOL, 4444, 49152, { syn: true }));
    expect(refused).toEqual({ ok: false, reason: 'filtered' });
  });

  it('drops an IPv4 packet for a transport address that has no binding', () => {
    const { translator } = lab();
    expect(translator.translate4to6(tcp4(SERVER, POOL, 80, 5555, { syn: true }))).toEqual({ ok: false, reason: 'no-binding' });
  });

  it('closes through FIN on both sides into the transitory state, and RST goes there at once', () => {
    const { translator } = lab();
    translator.translate6to4(tcp6(HOST_A, toServer(), 49152, 80, { syn: true }));
    translator.translate4to6(tcp4(SERVER, POOL, 80, 49152, { syn: true, ack: true }));
    translator.translate6to4(tcp6(HOST_A, toServer(), 49152, 80, { fin: true, ack: true }));
    expect(translator.getSessions()[0].tcpState).toBe('v6-fin-rcv');
    translator.translate4to6(tcp4(SERVER, POOL, 80, 49152, { fin: true, ack: true }));
    expect(translator.getSessions()[0].tcpState).toBe('v6-fin-v4-fin-rcv');
    translator.translate6to4(tcp6(HOST_A, toServer(), 49152, 80, { ack: true }));
    expect(translator.getSessions()[0].tcpState).toBe('trans');
    const second = lab();
    second.translator.translate6to4(tcp6(HOST_A, toServer(), 49152, 80, { syn: true }));
    second.translator.translate4to6(tcp4(SERVER, POOL, 80, 49152, { syn: true, ack: true }));
    second.translator.translate4to6(tcp4(SERVER, POOL, 80, 49152, { rst: true }));
    expect(second.translator.getSessions()[0].tcpState).toBe('trans');
  });
});

describe('RFC 6146 section 3.5.2 and 3.6.1: tables, bindings and timers', () => {
  it('endpoint-independent mapping: one IPv6 transport address keeps one IPv4 transport address toward two servers', () => {
    const { translator } = lab();
    const first = unwrap(translator.translate6to4(udp6(HOST_A, toServer(SERVER), 40000, 53)));
    const second = unwrap(translator.translate6to4(udp6(HOST_A, toServer(OTHER), 40000, 53)));
    expect((first.payload as UDPPacket).sourcePort).toBe((second.payload as UDPPacket).sourcePort);
    expect(first.sourceIP.toString()).toBe(second.sourceIP.toString());
    expect(translator.getBindings()).toHaveLength(1);
    expect(translator.getSessions()).toHaveLength(2);
  });

  it('paired address pooling: another source port of the same host keeps the same IPv4 address', () => {
    const { translator } = lab(['203.0.113.1', '203.0.113.2']);
    const a = unwrap(translator.translate6to4(udp6(HOST_A, toServer(), 40000, 53)));
    const b = unwrap(translator.translate6to4(udp6(HOST_A, toServer(), 40001, 53)));
    const other = unwrap(translator.translate6to4(udp6(HOST_B, toServer(), 40000, 53)));
    expect(b.sourceIP.toString()).toBe(a.sourceIP.toString());
    expect(other.sourceIP.toString()).toBe(a.sourceIP.toString());
    expect((other.payload as UDPPacket).sourcePort).not.toBe(40000);
  });

  it('two hosts that want the same port on a one-address pool: the second gets another port of the same class', () => {
    const { translator } = lab();
    unwrap(translator.translate6to4(udp6(HOST_A, toServer(), 40000, 53)));
    const second = unwrap(translator.translate6to4(udp6(HOST_B, toServer(), 40000, 53)));
    expect((second.payload as UDPPacket).sourcePort).toBe(1024);
    const lowA = unwrap(translator.translate6to4(udp6(HOST_A, toServer(), 53, 53)));
    const lowB = unwrap(translator.translate6to4(udp6(HOST_B, toServer(), 53, 53)));
    expect((lowA.payload as UDPPacket).sourcePort).toBe(53);
    expect((lowB.payload as UDPPacket).sourcePort).toBe(1);
  });

  it('address-dependent filtering for UDP: the contacted server may answer from any port, another host may not', () => {
    const { translator } = lab();
    translator.translate6to4(udp6(HOST_A, toServer(), 40000, 53));
    expect(translator.translate4to6(udp4(SERVER, POOL, 5353, 40000)).ok).toBe(true);
    expect(translator.translate4to6(udp4(OTHER, POOL, 53, 40000))).toEqual({ ok: false, reason: 'filtered' });
  });

  it('expires an idle UDP session after 5 minutes and frees its binding', () => {
    const { translator, time } = lab();
    translator.translate6to4(udp6(HOST_A, toServer(), 40000, 53));
    time.now = NAT64_DEFAULT_TIMEOUTS.udpMs - 1;
    expect(translator.translate4to6(udp4(SERVER, POOL, 53, 40000)).ok).toBe(true);
    time.now += NAT64_DEFAULT_TIMEOUTS.udpMs;
    translator.purge();
    expect(translator.getSessions()).toHaveLength(0);
    expect(translator.getBindings()).toHaveLength(0);
    expect(translator.translate4to6(udp4(SERVER, POOL, 53, 40000))).toEqual({ ok: false, reason: 'no-binding' });
  });

  it('keeps an established TCP session for 2 h 4 min and an unanswered SYN for only 6 s', () => {
    const { translator, time } = lab();
    translator.translate6to4(tcp6(HOST_A, toServer(), 49152, 80, { syn: true }));
    translator.translate4to6(tcp4(SERVER, POOL, 80, 49152, { syn: true, ack: true }));
    translator.translate6to4(tcp6(HOST_B, toServer(), 49152, 80, { syn: true }));
    time.now = NAT64_DEFAULT_TIMEOUTS.tcpInitialMs;
    translator.purge();
    expect(translator.getSessions().map((s) => s.v6Source)).toEqual([HOST_A]);
    time.now = NAT64_DEFAULT_TIMEOUTS.tcpEstablishedMs - 1;
    translator.purge();
    expect(translator.getSessions()).toHaveLength(1);
    time.now = NAT64_DEFAULT_TIMEOUTS.tcpEstablishedMs + NAT64_DEFAULT_TIMEOUTS.tcpInitialMs;
    translator.purge();
    expect(translator.getSessions()).toHaveLength(0);
  });
});

describe('RFC 6146 section 3.4 and RFC 6052 section 3.1: what is translated', () => {
  it('does not translate outside the prefix, and not a private address under the Well-Known Prefix', () => {
    const { translator } = lab();
    expect(translator.translate6to4(udp6(HOST_A, '2001:db8:ffff::1', 1, 2))).toEqual({ ok: false, reason: 'not-in-prefix' });
    expect(translator.translate6to4(udp6(HOST_A, '64:ff9b::a01:203', 1, 2))).toEqual({ ok: false, reason: 'non-global-destination' });
  });

  it('refuses a flow when the pool has no address left', () => {
    const { translator } = lab([]);
    expect(translator.translate6to4(udp6(HOST_A, toServer(), 40000, 53))).toEqual({ ok: false, reason: 'pool-exhausted' });
  });

  it('translates an echo request and its reply, the identifier standing for the port', () => {
    const { translator } = lab();
    const request = createIPv6Packet(new IPv6Address(HOST_A), new IPv6Address(toServer()), IP_PROTO_ICMPV6, 64,
      { type: 'icmpv6', icmpType: 'echo-request', code: 0, id: 77, sequence: 3, dataSize: 56 }, 64);
    const out = unwrap(translator.translate6to4(request));
    expect(out.protocol).toBe(IP_PROTO_ICMP);
    expect(out.payload).toMatchObject({ type: 'icmp', icmpType: 'echo-request', id: 77, sequence: 3, dataSize: 56 });
    expect(out.totalLength).toBe(84);
    const reply = createIPv4Packet(new IPAddress(SERVER), new IPAddress(POOL), IP_PROTO_ICMP, 60,
      { type: 'icmp', icmpType: 'echo-reply', code: 0, id: 77, sequence: 3, dataSize: 56 }, 64);
    const back = unwrap(translator.translate4to6(reply));
    expect(back.nextHeader).toBe(IP_PROTO_ICMPV6);
    expect(back.payload).toMatchObject({ type: 'icmpv6', icmpType: 'echo-reply', id: 77, sequence: 3 });
    expect(back.destinationIP.toString()).toBe(HOST_A);
    expect(back.payloadLength).toBe(64);
  });

  it('refuses an unsolicited echo reply and a protocol it does not translate', () => {
    const { translator } = lab();
    const reply = createIPv4Packet(new IPAddress(SERVER), new IPAddress(POOL), IP_PROTO_ICMP, 60,
      { type: 'icmp', icmpType: 'echo-reply', code: 0, id: 9, sequence: 1, dataSize: 56 }, 64);
    expect(translator.translate4to6(reply)).toEqual({ ok: false, reason: 'no-binding' });
    const other = createIPv6Packet(new IPv6Address(HOST_A), new IPv6Address(toServer()), 47, 64, null, 0);
    expect(translator.translate6to4(other)).toEqual({ ok: false, reason: 'unsupported-protocol' });
  });
});

describe('RFC 6146 / 7915 : error messages cross the translator with the packet they quote', () => {
  const sent = (translator: Nat64Translator) => unwrap(translator.translate6to4(udp6(HOST_A, toServer(), 40000, 53)));
  const icmpError4 = (original: IPv4Packet, icmpType: 'destination-unreachable' | 'time-exceeded', code: number, mtu?: number, from = SERVER) =>
    createIPv4Packet(new IPAddress(from), new IPAddress(POOL), IP_PROTO_ICMP, 60,
      { type: 'icmp', icmpType, code, id: 0, sequence: 0, dataSize: 0, originalPacket: original, ...(mtu === undefined ? {} : { mtu }) }, 8 + original.totalLength);

  it('port unreachable from the server becomes destination unreachable code 4, quoting the IPv6 datagram', () => {
    const { translator } = lab();
    const forward = sent(translator);
    const back = unwrap(translator.translate4to6(icmpError4(forward, 'destination-unreachable', 3)));
    expect(back.nextHeader).toBe(IP_PROTO_ICMPV6);
    expect(back.sourceIP.toString()).toBe(toServer());
    expect(back.destinationIP.toString()).toBe(HOST_A);
    expect(back.payload).toMatchObject({ type: 'icmpv6', icmpType: 'destination-unreachable', code: 4 });
    const quoted = (back.payload as { invokingPacket: IPv6Packet }).invokingPacket;
    expect(quoted.sourceIP.toString()).toBe(HOST_A);
    expect(quoted.destinationIP.toString()).toBe(toServer());
    expect(quoted.payload).toMatchObject({ sourcePort: 40000, destinationPort: 53 });
  });

  it('fragmentation needed becomes packet too big with the MTU grown by the header difference, 1280 at least', () => {
    const { translator } = lab();
    const forward = sent(translator);
    const big = unwrap(translator.translate4to6(icmpError4(forward, 'destination-unreachable', 4, 1400)));
    expect(big.payload).toMatchObject({ icmpType: 'packet-too-big', mtu: 1420 });
    const small = unwrap(translator.translate4to6(icmpError4(forward, 'destination-unreachable', 4, 576)));
    expect(small.payload).toMatchObject({ icmpType: 'packet-too-big', mtu: 1280 });
  });

  it('time exceeded keeps its code, the router that sent it is shown under the prefix', () => {
    const { translator } = lab();
    const forward = sent(translator);
    const back = unwrap(translator.translate4to6(icmpError4(forward, 'time-exceeded', 0, undefined, OTHER)));
    expect(back.sourceIP.toString()).toBe(toServer(OTHER));
    expect(back.payload).toMatchObject({ icmpType: 'time-exceeded', code: 0 });
  });

  it('an IPv4 error with no matching code, or quoting a flow nobody opened, is dropped', () => {
    const { translator } = lab();
    const forward = sent(translator);
    expect(translator.translate4to6(icmpError4(forward, 'destination-unreachable', 14))).toEqual({ ok: false, reason: 'unsupported-icmp' });
    const stranger = createIPv4Packet(new IPAddress('203.0.113.99'), new IPAddress(SERVER), 17, 64,
      { type: 'udp', sourcePort: 1, destinationPort: 2, length: 8, checksum: 0, payload: null } as UDPPacket, 8);
    expect(translator.translate4to6(icmpError4(stranger, 'destination-unreachable', 3))).toEqual({ ok: false, reason: 'no-binding' });
  });

  it('an IPv6 host that cannot take a packet too big tells the server in IPv4 terms', () => {
    const { translator } = lab();
    unwrap(translator.translate6to4(udp6(HOST_A, toServer(), 40000, 53)));
    const fromServer = unwrap(translator.translate4to6(udp4(SERVER, POOL, 53, 40000)));
    const error = createIPv6Packet(new IPv6Address(HOST_A), new IPv6Address(toServer()), IP_PROTO_ICMPV6, 64,
      { type: 'icmpv6', icmpType: 'packet-too-big', code: 0, mtu: 1400, invokingPacket: fromServer }, 8 + 40 + 8);
    const out = unwrap(translator.translate6to4(error));
    expect(out.protocol).toBe(IP_PROTO_ICMP);
    expect(out.sourceIP.toString()).toBe(POOL);
    expect(out.destinationIP.toString()).toBe(SERVER);
    expect(out.payload).toMatchObject({ icmpType: 'destination-unreachable', code: 4, mtu: 1380 });
    const quoted = (out.payload as { originalPacket: IPv4Packet }).originalPacket;
    expect(quoted.sourceIP.toString()).toBe(SERVER);
    expect(quoted.destinationIP.toString()).toBe(POOL);
    expect(quoted.payload).toMatchObject({ sourcePort: 53, destinationPort: 40000 });
  });

  it('an IPv6 unreachable maps its code (address 3 to host 1, port 4 to port 3)', () => {
    const { translator } = lab();
    unwrap(translator.translate6to4(udp6(HOST_A, toServer(), 40000, 53)));
    const fromServer = unwrap(translator.translate4to6(udp4(SERVER, POOL, 53, 40000)));
    const error = (code: number) => createIPv6Packet(new IPv6Address(HOST_A), new IPv6Address(toServer()), IP_PROTO_ICMPV6, 64,
      { type: 'icmpv6', icmpType: 'destination-unreachable', code, invokingPacket: fromServer }, 56);
    expect(unwrap(translator.translate6to4(error(3))).payload).toMatchObject({ icmpType: 'destination-unreachable', code: 1 });
    expect(unwrap(translator.translate6to4(error(4))).payload).toMatchObject({ icmpType: 'destination-unreachable', code: 3 });
  });

  it('RFC 7915 section 5.1: DF is clear up to 1260 bytes and set above', () => {
    const { translator } = lab();
    const small = unwrap(translator.translate6to4(udp6(HOST_A, toServer(), 40000, 53)));
    expect(small.flags & 0b010).toBe(0);
    const datagram: UDPPacket = { type: 'udp', sourcePort: 40001, destinationPort: 53, length: 1300, checksum: 0, payload: null };
    const big = unwrap(translator.translate6to4(createIPv6Packet(new IPv6Address(HOST_A), new IPv6Address(toServer()), 17, 64, datagram, 1300)));
    expect(big.flags & 0b010).toBe(0b010);
  });

  it('RFC 7915 section 4.2: code 15 maps to administratively prohibited, and a zero MTU uses the plateau table', () => {
    const { translator } = lab();
    const forward = sent(translator);
    expect(unwrap(translator.translate4to6(icmpError4(forward, 'destination-unreachable', 15))).payload)
      .toMatchObject({ icmpType: 'destination-unreachable', code: 1 });
    const longQuote = { ...forward, totalLength: 3000 };
    const plateau = unwrap(translator.translate4to6(icmpError4(longQuote, 'destination-unreachable', 4, 0)));
    expect(plateau.payload).toMatchObject({ icmpType: 'packet-too-big', mtu: 2002 + 20 });
  });

  it('RFC 7915 sections 4.2 and 5.2: parameter problems carry their pointer across, and drop when it has no counterpart', () => {
    const { translator } = lab();
    const forward = sent(translator);
    const v4 = (pointer: number) => createIPv4Packet(new IPAddress(SERVER), new IPAddress(POOL), IP_PROTO_ICMP, 60,
      { type: 'icmp', icmpType: 'parameter-problem', code: 0, id: 0, sequence: 0, dataSize: 0, pointer, originalPacket: forward }, 8 + forward.totalLength);
    expect(unwrap(translator.translate4to6(v4(8))).payload).toMatchObject({ icmpType: 'parameter-problem', code: 0, pointer: 7 });
    expect(translator.translate4to6(v4(4))).toEqual({ ok: false, reason: 'unsupported-icmp' });
    const fromServer = unwrap(translator.translate4to6(udp4(SERVER, POOL, 53, 40000)));
    const v6 = (pointer: number) => createIPv6Packet(new IPv6Address(HOST_A), new IPv6Address(toServer()), IP_PROTO_ICMPV6, 64,
      { type: 'icmpv6', icmpType: 'parameter-problem', code: 0, pointer, invokingPacket: fromServer }, 56);
    expect(unwrap(translator.translate6to4(v6(7))).payload).toMatchObject({ icmpType: 'parameter-problem', code: 0, pointer: 8 });
    expect(translator.translate6to4(v6(2))).toEqual({ ok: false, reason: 'unsupported-icmp' });
  });
});

describe('RFC 7915 sections 4.2 and 5.2 : the next-hop MTUs enter the MTU of a translated error', () => {
  const mtus = (ipv4: number | undefined, ipv6: number | undefined) => {
    const translator = new Nat64Translator({
      prefix: Nat64Prefix.wellKnownPrefix(), pool: [new IPAddress(POOL)], clock: () => 0,
      nexthopMtu: { ipv4: () => ipv4, ipv6: () => ipv6 },
    });
    const forward = unwrap(translator.translate6to4(udp6(HOST_A, toServer(), 40000, 53)));
    const back = unwrap(translator.translate4to6(udp4(SERVER, POOL, 53, 40000)));
    return { translator, forward, back };
  };
  const fragNeeded = (original: IPv4Packet, mtu: number) =>
    createIPv4Packet(new IPAddress(SERVER), new IPAddress(POOL), IP_PROTO_ICMP, 60,
      { type: 'icmp', icmpType: 'destination-unreachable', code: 4, id: 0, sequence: 0, dataSize: 0, originalPacket: original, mtu }, 8 + original.totalLength);
  const tooBig = (invoking: IPv6Packet, mtu: number) =>
    createIPv6Packet(new IPv6Address(HOST_A), new IPv6Address(toServer()), IP_PROTO_ICMPV6, 64,
      { type: 'icmpv6', icmpType: 'packet-too-big', code: 0, mtu, invokingPacket: invoking }, 8 + 40 + 8);

  it('witness: with larger next-hop MTUs the message MTU decides, both ways', () => {
    const { translator, forward, back } = mtus(9000, 9000);
    const toHost = unwrap(translator.translate4to6(fragNeeded(forward, 1400)));
    expect(toHost.payload).toMatchObject({ icmpType: 'packet-too-big', mtu: 1420 });
    const toServer4 = unwrap(translator.translate6to4(tooBig(back, 1400)));
    expect(toServer4.payload).toMatchObject({ icmpType: 'destination-unreachable', code: 4, mtu: 1380 });
  });

  it('fragmentation needed: min(mtu + 20, IPv6 next hop, IPv4 next hop + 20)', () => {
    const { translator, forward } = mtus(1300, 9000);
    expect(unwrap(translator.translate4to6(fragNeeded(forward, 1400))).payload).toMatchObject({ mtu: 1320 });
    const narrow = mtus(9000, 1300);
    expect(unwrap(narrow.translator.translate4to6(fragNeeded(narrow.forward, 1400))).payload).toMatchObject({ mtu: 1300 });
  });

  it('packet too big: min(mtu - 20, IPv4 next hop, IPv6 next hop - 20)', () => {
    const { translator, back } = mtus(1350, 1340);
    expect(unwrap(translator.translate6to4(tooBig(back, 1400))).payload).toMatchObject({ mtu: 1320 });
  });
});

describe('RFC 6052 section 3 : several prefixes on one translator', () => {
  const secondary = Nat64Prefix.parse('2001:db8:ffff::/64');
  const both = () => new Nat64Translator({
    prefix: Nat64Prefix.wellKnownPrefix(), secondaryPrefixes: [secondary],
    pool: [new IPAddress(POOL)], clock: () => 0,
  });
  const throughSecondary = secondary.synthesize(new IPAddress(SERVER)).toString();

  it('translates toward the secondary prefix and answers from it, not from the primary', () => {
    const translator = both();
    const forward = unwrap(translator.translate6to4(udp6(HOST_A, throughSecondary, 40000, 53)));
    expect(forward.destinationIP.toString()).toBe(SERVER);
    const back = unwrap(translator.translate4to6(udp4(SERVER, POOL, 53, 40000)));
    expect(back.sourceIP.toString()).toBe(throughSecondary);
  });

  it('the same host keeps the primary prefix for a flow that came through it', () => {
    const translator = both();
    unwrap(translator.translate6to4(udp6(HOST_A, toServer(), 40001, 53)));
    const back = unwrap(translator.translate4to6(udp4(SERVER, POOL, 53, 40001)));
    expect(back.sourceIP.toString()).toBe(toServer());
  });

  it('an error about a flow through the secondary prefix is sent from the secondary prefix', () => {
    const translator = both();
    const forward = unwrap(translator.translate6to4(udp6(HOST_A, throughSecondary, 40002, 53)));
    const error = createIPv4Packet(new IPAddress(OTHER), new IPAddress(POOL), IP_PROTO_ICMP, 60,
      { type: 'icmp', icmpType: 'time-exceeded', code: 0, id: 0, sequence: 0, dataSize: 0, originalPacket: forward }, 8 + forward.totalLength);
    const back = unwrap(translator.translate4to6(error));
    expect(back.sourceIP.toString()).toBe(secondary.synthesize(new IPAddress(OTHER)).toString());
  });
});

describe('RFC 7915 sections 4.1 and 5.1 : fragments', () => {
  const bigUdp6 = () => {
    const datagram: UDPPacket = { type: 'udp', sourcePort: 40000, destinationPort: 53, length: 3000, checksum: 0, payload: null };
    return createIPv6Packet(new IPv6Address(HOST_A), new IPv6Address(toServer()), 17, 64, datagram, 3000);
  };
  const bigUdp4 = () => {
    const datagram: UDPPacket = { type: 'udp', sourcePort: 53, destinationPort: 40000, length: 3000, checksum: 0, payload: null };
    return createIPv4Packet(new IPAddress(SERVER), new IPAddress(POOL), 17, 60, datagram, 3000, { flags: 0 });
  };

  it('IPv6 fragments become IPv4 fragments: offsets, more-fragments and a 16-bit identification', () => {
    const { translator } = lab();
    const pieces = fragmentIPv6(bigUdp6(), 1280, () => 0x12345);
    expect(pieces.length).toBe(3);
    const out = pieces.map((piece) => unwrap(translator.translate6to4(piece)));
    expect(out.map((p) => p.fragmentOffset)).toEqual(pieces.map((p) => ipv6FragmentOf(p)!.fragmentOffset));
    expect(out.map((p) => (p.flags & IPV4_FLAG_MF) !== 0)).toEqual([true, true, false]);
    expect(new Set(out.map((p) => p.identification))).toEqual(new Set([0x2345]));
    expect(out.every((p) => p.destinationIP.toString() === SERVER && p.sourceIP.toString() === POOL && p.protocol === 17)).toBe(true);
    expect(out[0].payload).toMatchObject({ type: 'udp', destinationPort: 53 });
  });

  it('IPv4 fragments become IPv6 fragments that an IPv6 host reassembles whole', () => {
    const { translator } = lab();
    unwrap(translator.translate6to4(udp6(HOST_A, toServer(), 40000, 53)));
    const pieces = fragmentIPv4(bigUdp4(), 1500);
    expect(pieces.length).toBe(3);
    const out = pieces.map((piece) => unwrap(translator.translate4to6(piece)));
    expect(out.every((p) => p.destinationIP.toString() === HOST_A && p.sourceIP.toString() === toServer())).toBe(true);
    const reassembler = new IPv6Reassembler({ highThresholdBytes: () => 1 << 20 });
    const outcomes = out.map((piece) => reassembler.add(piece, 'eth0'));
    const whole = outcomes[2];
    expect(whole.kind).toBe('complete');
    expect(whole.kind === 'complete' && whole.packet.payload).toMatchObject({ type: 'udp', sourcePort: 53, destinationPort: 40000 });
    expect(whole.kind === 'complete' && whole.packet.payloadLength).toBe(3000);
  });

  it('a fragment that grows past the IPv6 link MTU is split again, offsets kept on 8-byte units', () => {
    const translator = new Nat64Translator({
      prefix: Nat64Prefix.wellKnownPrefix(), pool: [new IPAddress(POOL)], clock: () => 0,
      nexthopMtu: { ipv4: () => 1500, ipv6: () => 1500 },
    });
    unwrap(translator.translate6to4(udp6(HOST_A, toServer(), 40000, 53)));
    const pieces = fragmentIPv4(bigUdp4(), 1500);
    const out = pieces.flatMap((piece) => unwrap(translator.translate4to6Fitted(piece)));
    expect(out.every((p) => 40 + p.payloadLength <= 1500)).toBe(true);
    const reassembler = new IPv6Reassembler({ highThresholdBytes: () => 1 << 20 });
    const outcomes = out.map((piece) => reassembler.add(piece, 'eth0'));
    const whole = outcomes[outcomes.length - 1];
    expect(whole.kind === 'complete' && whole.packet.payloadLength).toBe(3000);
  });

  it('a fragment that arrives before the first one is dropped', () => {
    const { translator } = lab();
    unwrap(translator.translate6to4(udp6(HOST_A, toServer(), 40000, 53)));
    const pieces = fragmentIPv4(bigUdp4(), 1500);
    expect(translator.translate4to6(pieces[1])).toEqual({ ok: false, reason: 'fragment-without-head' });
  });

  it('the same holds toward IPv4', () => {
    const { translator } = lab();
    const pieces = fragmentIPv6(bigUdp6(), 1280, () => 9);
    expect(translator.translate6to4(pieces[1])).toEqual({ ok: false, reason: 'fragment-without-head' });
  });

  it('witness: an unfragmented datagram still translates whole', () => {
    const { translator } = lab();
    const out = unwrap(translator.translate6to4(udp6(HOST_A, toServer(), 40000, 53)));
    expect(out.fragmentOffset).toBe(0);
    expect(out.flags & IPV4_FLAG_MF).toBe(0);
  });
});
