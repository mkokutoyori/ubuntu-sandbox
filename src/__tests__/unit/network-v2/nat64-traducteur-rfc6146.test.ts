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
 * La RFC 7915 (traduction des en-tetes) ne fait pas partie de docs/rfc : la forme des en-tetes
 * (TOS, DF positionne, TTL, longueur, table des codes ICMP) vient de la memoire de l'auteur et le dit.
 * Les messages d'erreur ICMP sont traduits avec le paquet qu'ils citent ; limite : un paquet fragmente
 * ne l'est pas (la fragmentation IPv6 n'est pas modelisee par le plan de donnees).
 */
import { describe, it, expect } from 'vitest';
import {
  IPAddress, IPv6Address, createIPv4Packet, createIPv6Packet, IP_PROTO_ICMP, IP_PROTO_ICMPV6,
  type IPv4Packet, type IPv6Packet, type TCPPacket, type UDPPacket,
} from '@/network/core/types';
import { computeTcpChecksum, type TcpSegment } from '@/network/tcp/types';
import { Nat64Prefix } from '@/network/nat/nat64/Nat64Prefix';
import { Nat64Translator, NAT64_DEFAULT_TIMEOUTS } from '@/network/nat/nat64/Nat64Translator';

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
    expect(out.flags & 0b010).toBe(0b010);
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
    expect((back.payload as TCPPacket).destinationPort).toBe(49152);
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
});
