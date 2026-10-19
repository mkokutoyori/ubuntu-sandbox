/**
 * Le suivi de connexions de Linux suit les flux comme le noyau 6.1 : un paquet est NEW, ESTABLISHED, RELATED, INVALID ou UNTRACKED selon ce
 * que la table sait de lui, et la table est la meme que celle que `conntrack` montre. La table d'avant tenait deux entrees par paquet
 * accepte, sans direction ni etat : tout tuple connu etait « etabli », une erreur ICMP n'appartenait jamais a la connexion qu'elle
 * rapportait, INVALID ne correspondait a rien, les messages de decouverte de voisins etaient suivis comme des flux, et `conntrack -L`
 * montrait chaque flux par son tuple RETOUR, avec `[UNREPLIED]` jamais ecrit et un etat TCP fabrique.
 *
 * Mesure de depart (a070e21d ; deux LinuxPC sur un lien, v4 et v6) :
 *     INPUT DROP + `-m state --state ESTABLISHED,RELATED -j ACCEPT`, B rejette l'echo avec icmp-host-prohibited
 *                                                        ->  ping de A : « 100% packet loss » sans la ligne « From 10.0.0.2 ... Destination Host Prohibited » ;
 *                                                            le compteur de la regle reste a 0 (l'erreur est jetee par la politique)
 *     memes regles, `traceroute -n -m 1 -q 1 -w 1 10.0.0.2`  ->  « 1  * » au lieu du saut
 *     une regle par etat (RELATED, ESTABLISHED, INVALID, NEW) ->  l'erreur ICMP de B est comptee par la regle NEW
 *     `conntrack -L` apres une requete UDP vers un port ferme ->  le tuple retour d'abord (src=B ... sport=9999), « ESTABLISHED » alors
 *                                                            qu'aucune reponse du flux n'est venue, et l'erreur ICMP de B suivie comme un flux
 *     `conntrack -L` apres un ping rejete                     ->  « [UNREPLIED] » ecrit AVANT le premier tuple, ports a 0 pour de l'ICMP
 *     isEstablished incrementait « found » a chaque regle evaluee, « invalid » ne bougeait jamais
 *
 * Autorites (regle 8) : noyau Linux 6.1.176 -- net/netfilter/nf_conntrack_core.c (resolve_normal_ct : un paquet du sens original est
 * NEW tant qu'aucune reponse n'a ete vue, ESTABLISHED apres ; un paquet du sens retour est ESTABLISHED), nf_conntrack_proto_icmp.c
 * (invmap : seuls l'echo, l'horodatage, la demande d'information et le masque ont un type inverse ; nf_conntrack_inet_error : une erreur
 * est RELATED au flux du paquet qu'elle cite si elle est adressee a l'emetteur de ce paquet, INVALID sinon ; seuls les messages de type
 * demande creent un flux), nf_conntrack_proto_icmpv6.c (echo et requete NI seulement ; routeur, voisin et ecoute de groupe sont
 * UNTRACKED), nf_conntrack_proto_tcp.c (tcp_valid_flags, tcp_conntracks, tcp_new, les delais de tcp_timeouts, ASSURED, la fin d'un flux
 * dont la seule reponse est un RST), nf_conntrack_proto_udp.c (30 s sans reponse, 120 s et ASSURED apres deux secondes de flux),
 * nf_conntrack_proto_generic.c (600 s) ; libnetfilter_conntrack 1.0.9 snprintf_default.c (le format des lignes de `-L`) ;
 * conntrack-tools 1.4.7 conntrack.c (`-L` sans `-f` liste les deux familles).
 *
 * Discrimination : contre l'arbre sans le lot (sources remises a leur etat, sonde conservee, l'import du suiveur remplace par une classe
 * qui leve), les 71 cas tombent, aucun ne passe des deux cotes. 61 tombent PAR CONSTRUCTION -- ils exercent ConnectionTracker, qui
 * n'existait pas : leur contenu est eprouve par la mutation, pas par cette mesure. 10 tombent sur le comportement : les six cas sur le
 * fil (l'erreur de B n'atteint pas ping derriere ESTABLISHED,RELATED, la regle RELATED compte zero, traceroute perd le saut, l'erreur
 * ICMPv6, et le TEMOIN dont la seconde moitie retrouve l'erreur cachee) et les quatre cas de la machine qui s'ecrit a elle-meme (un ping
 * ou un datagramme par lo est un flux inscrit une fois et vu une fois). Le format de `conntrack` et sa ligne de commande ont leur
 * propre sonde : probe-conntrack-lit-sa-ligne-de-commande-comme-conntrack-tools.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectionTracker, type ConnectionState, type TrackedPacket } from '@/network/devices/linux/ConnectionTracker';
import { LinuxIptablesManager, type PacketInfo } from '@/network/devices/linux/LinuxIptablesManager';
import { IPAddress } from '@/network/core/types';
import { PathClock } from '@/network/core/time/PathClock';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../support/fastPing';
import { linuxPair } from '../../support/linuxPair';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  __setDefaultScheduler(new VirtualTimeScheduler());
});

const A = '10.0.0.1';
const B = '10.0.0.2';
const FIN = 0x01;
const SYN = 0x02;
const RST = 0x04;
const PSH = 0x08;
const ACK = 0x10;
const URG = 0x20;

const udp = (src: string, sport: number, dst: string, dport: number): TrackedPacket => ({ protocol: 17, srcIP: src, srcPort: sport, dstIP: dst, dstPort: dport });
const tcp = (src: string, sport: number, dst: string, dport: number, tcpFlags: number): TrackedPacket => ({ protocol: 6, srcIP: src, srcPort: sport, dstIP: dst, dstPort: dport, tcpFlags });
const echo = (src: string, dst: string, icmpType: number, icmpId: number, protocol = 1): TrackedPacket => ({ protocol, srcIP: src, srcPort: 0, dstIP: dst, dstPort: 0, icmpType, icmpId });
const error = (src: string, dst: string, icmpType: number, related: TrackedPacket, protocol = 1): TrackedPacket => ({ protocol, srcIP: src, srcPort: 0, dstIP: dst, dstPort: 0, icmpType, related });

function lab(family: 4 | 6 = 4) {
  const tracker = new ConnectionTracker(family);
  const feed = (packet: TrackedPacket, accepted = true): ConnectionState => {
    const entry = tracker.enter(packet);
    if (accepted) tracker.confirm(entry);
    return entry.state;
  };
  return { tracker, feed };
}

const clientToServer = (flags: number) => tcp(A, 40000, B, 22, flags);
const serverToClient = (flags: number) => tcp(B, 22, A, 40000, flags);

describe('a flow is NEW until the other side has answered, then ESTABLISHED in both directions', () => {
  it('UDP : request NEW, a second request before any answer NEW, answer ESTABLISHED, then both directions ESTABLISHED', () => {
    const { feed } = lab();
    expect(feed(udp(A, 5000, B, 53))).toBe('NEW');
    expect(feed(udp(A, 5000, B, 53))).toBe('NEW');
    expect(feed(udp(B, 53, A, 5000))).toBe('ESTABLISHED');
    expect(feed(udp(A, 5000, B, 53))).toBe('ESTABLISHED');
    expect(feed(udp(B, 53, A, 5000))).toBe('ESTABLISHED');
  });

  it('a first packet that the filter refused leaves no flow behind, so its retransmission is NEW again', () => {
    const { tracker, feed } = lab();
    expect(feed(udp(A, 5000, B, 53), false)).toBe('NEW');
    expect(tracker.flows()).toHaveLength(0);
    expect(feed(udp(A, 5000, B, 53), false)).toBe('NEW');
    expect(tracker.statistics.insert).toBe(0);
  });

  it('an answer that the filter drops is still the sight of a reply : the next request is ESTABLISHED', () => {
    const { feed } = lab();
    expect(feed(udp(A, 5000, B, 53))).toBe('NEW');
    expect(feed(udp(B, 53, A, 5000), false)).toBe('ESTABLISHED');
    expect(feed(udp(A, 5000, B, 53))).toBe('ESTABLISHED');
  });

  it('TEMOIN : a datagram from another port is another flow', () => {
    const { tracker, feed } = lab();
    feed(udp(A, 5000, B, 53));
    expect(feed(udp(A, 5001, B, 53))).toBe('NEW');
    expect(tracker.flows()).toHaveLength(2);
  });
});

describe('ICMP echo : the request starts a flow, the reply of the same identifier belongs to it, the rest is INVALID', () => {
  it('request NEW, reply ESTABLISHED, a reply of another identifier INVALID', () => {
    const { feed } = lab();
    expect(feed(echo(A, B, 8, 7))).toBe('NEW');
    expect(feed(echo(B, A, 0, 7))).toBe('ESTABLISHED');
    expect(feed(echo(B, A, 0, 8))).toBe('INVALID');
  });

  it('a reply with no request is INVALID and does not start a flow', () => {
    const { tracker, feed } = lab();
    expect(feed(echo(B, A, 0, 7))).toBe('INVALID');
    expect(tracker.flows()).toHaveLength(0);
  });

  it('a message type that has no reply type is INVALID : router advertisement', () => {
    const { feed } = lab();
    expect(feed(echo(A, B, 9, 1))).toBe('INVALID');
  });

  it.each([[8, 0], [13, 14], [15, 16], [17, 18]])('type %i is answered by type %i of the same identifier and by no other reply type', (request, reply) => {
    const { feed } = lab();
    expect(feed(echo(A, B, request, 3))).toBe('NEW');
    for (const other of [0, 14, 16, 18].filter((type) => type !== reply)) expect(feed(echo(B, A, other, 3))).toBe('INVALID');
    expect(feed(echo(B, A, reply, 3))).toBe('ESTABLISHED');
  });
});

describe('an ICMP error is RELATED to the flow of the packet it quotes, and to nothing else', () => {
  const request = echo(A, B, 8, 7);

  it('an unreachable that quotes our echo request, addressed to us : RELATED, and it starts no flow', () => {
    const { tracker, feed } = lab();
    feed(request);
    expect(feed(error(B, A, 3, request))).toBe('RELATED');
    expect(tracker.flows()).toHaveLength(1);
  });

  it('the quoted packet may be a UDP datagram of the flow, in either direction', () => {
    const { feed } = lab();
    feed(udp(A, 40000, B, 33434));
    expect(feed(error(B, A, 3, udp(A, 40000, B, 33434)))).toBe('RELATED');
    feed(udp(B, 33434, A, 40000));
    expect(feed(error('10.0.0.9', B, 3, udp(B, 33434, A, 40000)))).toBe('RELATED');
  });

  it('an error that quotes a packet nobody tracked is INVALID', () => {
    const { feed } = lab();
    expect(feed(error(B, A, 3, request))).toBe('INVALID');
  });

  it('an error that quotes a tracked packet but is addressed to someone else is INVALID', () => {
    const { feed } = lab();
    feed(request);
    expect(feed(error(B, '10.0.0.77', 3, request))).toBe('INVALID');
  });

  it('time exceeded and redirect are errors as well', () => {
    const { feed } = lab();
    feed(request);
    expect(feed(error('10.0.0.254', A, 11, request))).toBe('RELATED');
    expect(feed(error('10.0.0.254', A, 5, request))).toBe('RELATED');
  });

  it('counts the lookup as found, and the refusal as invalid', () => {
    const { tracker, feed } = lab();
    feed(request);
    const found = tracker.statistics.found;
    feed(error(B, A, 3, request));
    expect(tracker.statistics.found).toBe(found + 1);
    feed(error(B, '10.0.0.77', 3, request));
    expect(tracker.statistics.invalid).toBe(1);
  });
});

describe('ICMPv6 : neighbour discovery and multicast listener messages are not tracked at all', () => {
  it.each([130, 131, 132, 133, 134, 135, 136, 143])('type %i is UNTRACKED and leaves no flow', (type) => {
    const { tracker, feed } = lab(6);
    expect(feed(echo('fe80::1', 'ff02::1', type, 0, 58))).toBe('UNTRACKED');
    expect(tracker.flows()).toHaveLength(0);
    expect(tracker.statistics.invalid).toBe(0);
  });

  it.each([[128, 129], [139, 140]])('type %i is answered by type %i of the same identifier and by no other reply type', (request, reply) => {
    const { feed } = lab(6);
    expect(feed(echo('2001:db8::1', '2001:db8::2', request, 3, 58))).toBe('NEW');
    for (const other of [129, 140].filter((type) => type !== reply)) expect(feed(echo('2001:db8::2', '2001:db8::1', other, 3, 58))).toBe('INVALID');
    expect(feed(echo('2001:db8::2', '2001:db8::1', reply, 3, 58))).toBe('ESTABLISHED');
  });

  it('echo pairs, an unsolicited echo reply is INVALID, an error that quotes the request is RELATED', () => {
    const { feed } = lab(6);
    const request = echo('2001:db8::1', '2001:db8::2', 128, 9, 58);
    expect(feed(echo('2001:db8::2', '2001:db8::1', 129, 4, 58))).toBe('INVALID');
    expect(feed(request)).toBe('NEW');
    expect(feed(echo('2001:db8::2', '2001:db8::1', 129, 9, 58))).toBe('ESTABLISHED');
    expect(feed(error('2001:db8::2', '2001:db8::1', 1, request, 58))).toBe('RELATED');
  });
});

describe('TCP : the state machine of the kernel decides, not the mere sight of the tuple', () => {
  it('SYN, SYN-ACK, ACK walk the flow to ESTABLISHED and assure it', () => {
    const { tracker, feed } = lab();
    expect(feed(clientToServer(SYN))).toBe('NEW');
    expect(tracker.flows()[0].tcpState).toBe('SYN_SENT');
    expect(feed(serverToClient(SYN | ACK))).toBe('ESTABLISHED');
    expect(tracker.flows()[0].tcpState).toBe('SYN_RECV');
    expect(tracker.flows()[0].assured).toBe(false);
    expect(feed(clientToServer(ACK))).toBe('ESTABLISHED');
    expect(tracker.flows()[0].tcpState).toBe('ESTABLISHED');
    expect(tracker.flows()[0].assured).toBe(true);
    expect(tracker.flows()[0].replied).toBe(true);
  });

  it('a retransmitted SYN is NEW and does not renew the timeout', () => {
    const { tracker, feed } = lab();
    feed(clientToServer(SYN));
    const before = tracker.flows()[0].remainingMs;
    PathClock.wait(5000);
    expect(feed(clientToServer(SYN))).toBe('NEW');
    expect(Math.abs(tracker.flows()[0].remainingMs - (before - 5000))).toBeLessThanOrEqual(1);
  });

  it.each([
    ['RST', RST], ['RST|ACK', RST | ACK], ['FIN|ACK', FIN | ACK], ['SYN|ACK', SYN | ACK], ['no flag at all', 0],
    ['SYN|FIN', SYN | FIN], ['SYN|RST', SYN | RST], ['FIN|PSH|URG', FIN | PSH | URG],
  ])('%s cannot open a flow : INVALID', (_name, flags) => {
    const { tracker, feed } = lab();
    expect(feed(clientToServer(flags))).toBe('INVALID');
    expect(tracker.flows()).toHaveLength(0);
  });

  it.each([['ACK', ACK], ['PSH|ACK', PSH | ACK], ['ACK|URG', ACK | URG]])('%s picks a connection up in the middle (loose tracking) : NEW, then ESTABLISHED, assured by the packet after the answer', (_name, flags) => {
    const { tracker, feed } = lab();
    expect(feed(clientToServer(flags))).toBe('NEW');
    expect(tracker.flows()[0].tcpState).toBe('ESTABLISHED');
    expect(feed(serverToClient(ACK))).toBe('ESTABLISHED');
    expect(tracker.flows()[0].assured).toBe(false);
    expect(feed(clientToServer(ACK))).toBe('ESTABLISHED');
    expect(tracker.flows()[0].assured).toBe(true);
  });

  it('a RST that answers the SYN is the end of the flow : the packet is ESTABLISHED, the entry is gone', () => {
    const { tracker, feed } = lab();
    feed(clientToServer(SYN));
    expect(feed(serverToClient(RST | ACK))).toBe('ESTABLISHED');
    expect(tracker.flows()).toHaveLength(0);
  });

  it('a SYN-ACK from the client, or a SYN from the server inside an established flow, is INVALID', () => {
    const { feed } = lab();
    feed(clientToServer(SYN));
    feed(serverToClient(SYN | ACK));
    feed(clientToServer(ACK));
    expect(feed(clientToServer(SYN | ACK))).toBe('INVALID');
    expect(feed(serverToClient(SYN))).toBe('INVALID');
  });

  it('the close walks FIN_WAIT, CLOSE_WAIT, LAST_ACK, TIME_WAIT with the timeouts of each state', () => {
    const { tracker, feed } = lab();
    feed(clientToServer(SYN));
    feed(serverToClient(SYN | ACK));
    feed(clientToServer(ACK));
    expect(feed(clientToServer(FIN | ACK))).toBe('ESTABLISHED');
    expect(tracker.flows()[0].tcpState).toBe('FIN_WAIT');
    expect(tracker.flows()[0].remainingMs).toBe(120_000);
    feed(serverToClient(ACK));
    expect(tracker.flows()[0].tcpState).toBe('CLOSE_WAIT');
    expect(tracker.flows()[0].remainingMs).toBe(60_000);
    feed(serverToClient(FIN | ACK));
    expect(tracker.flows()[0].tcpState).toBe('LAST_ACK');
    expect(tracker.flows()[0].remainingMs).toBe(30_000);
    feed(clientToServer(ACK));
    expect(tracker.flows()[0].tcpState).toBe('TIME_WAIT');
    expect(tracker.flows()[0].remainingMs).toBe(120_000);
  });

  it('a SYN of the server while the client SYN is unanswered is a simultaneous open : SYN_SENT2, whose later packets keep it 120 seconds', () => {
    const { tracker, feed } = lab();
    feed(clientToServer(SYN));
    expect(feed(serverToClient(SYN))).toBe('ESTABLISHED');
    expect(tracker.flows()[0].tcpState).toBe('SYN_SENT2');
    PathClock.wait(10_000);
    expect(feed(clientToServer(SYN))).toBe('ESTABLISHED');
    expect(tracker.flows()[0].tcpState).toBe('SYN_SENT2');
    expect(tracker.flows()[0].remainingMs).toBe(120_000);
  });

  it('a SYN reopens a flow that a RST closed only when it comes from the side that sent the RST', () => {
    const sameSide = lab();
    sameSide.feed(clientToServer(SYN));
    sameSide.feed(serverToClient(SYN | ACK));
    sameSide.feed(clientToServer(ACK));
    sameSide.feed(clientToServer(RST));
    expect(sameSide.tracker.flows()[0].tcpState).toBe('CLOSE');
    expect(sameSide.feed(clientToServer(SYN))).toBe('NEW');
    expect(sameSide.tracker.flows()[0].tcpState).toBe('SYN_SENT');

    const otherSide = lab();
    otherSide.feed(clientToServer(SYN));
    otherSide.feed(serverToClient(SYN | ACK));
    otherSide.feed(clientToServer(ACK));
    otherSide.feed(serverToClient(RST));
    expect(otherSide.tracker.flows()[0].tcpState).toBe('CLOSE');
    expect(otherSide.feed(clientToServer(SYN))).toBe('ESTABLISHED');
    expect(otherSide.tracker.flows()[0].tcpState).toBe('CLOSE');
  });

  it('a RST closes the flow for ten seconds', () => {
    const { tracker, feed } = lab();
    feed(clientToServer(SYN));
    feed(serverToClient(SYN | ACK));
    feed(clientToServer(ACK));
    feed(clientToServer(RST));
    expect(tracker.flows()[0].tcpState).toBe('CLOSE');
    expect(tracker.flows()[0].remainingMs).toBe(10_000);
  });

  it('a new SYN of the client reopens a flow that was closed by a FIN : the old flow goes, the SYN is NEW', () => {
    const { tracker, feed } = lab();
    feed(clientToServer(SYN));
    feed(serverToClient(SYN | ACK));
    feed(clientToServer(ACK));
    feed(clientToServer(FIN | ACK));
    feed(serverToClient(FIN | ACK));
    feed(clientToServer(ACK));
    expect(tracker.flows()[0].tcpState).toBe('TIME_WAIT');
    expect(feed(clientToServer(SYN))).toBe('NEW');
    expect(tracker.flows()).toHaveLength(1);
    expect(tracker.flows()[0].tcpState).toBe('SYN_SENT');
    expect(tracker.flows()[0].replied).toBe(false);
  });

  it('a packet that carries no flags facts follows the tuple only', () => {
    const { feed } = lab();
    const bare: TrackedPacket = { protocol: 6, srcIP: A, srcPort: 40000, dstIP: B, dstPort: 22 };
    expect(feed(bare)).toBe('NEW');
    expect(feed({ protocol: 6, srcIP: B, srcPort: 22, dstIP: A, dstPort: 40000 })).toBe('ESTABLISHED');
  });
});

describe('every flow lives as long as the kernel lets it', () => {
  const lifetimeOf = (packets: readonly TrackedPacket[], family: 4 | 6 = 4): number => {
    const { tracker, feed } = lab(family);
    for (const packet of packets) feed(packet);
    return tracker.flows()[0].remainingMs;
  };

  const bare = (protocol: number, src: string, dst: string): TrackedPacket => ({ protocol, srcIP: src, srcPort: 0, dstIP: dst, dstPort: 0 });

  it('UDP and UDP-Lite unreplied 30 s, GRE unreplied 30 s, ICMP 30 s, another protocol 600 s, TCP established 5 days', () => {
    expect(lifetimeOf([udp(A, 1, B, 2)])).toBe(30_000);
    expect(lifetimeOf([{ ...udp(A, 1, B, 2), protocol: 136 }])).toBe(30_000);
    expect(lifetimeOf([bare(47, A, B)])).toBe(30_000);
    expect(lifetimeOf([echo(A, B, 8, 1)])).toBe(30_000);
    expect(lifetimeOf([bare(89, A, B)])).toBe(600_000);
    expect(lifetimeOf([clientToServer(SYN), serverToClient(SYN | ACK), clientToServer(ACK)])).toBe(5 * 24 * 3600 * 1000);
  });

  it('UDP-Lite becomes a stream like UDP does : 120 s and assured after more than two seconds of exchange', () => {
    const { tracker, feed } = lab();
    const lite = (src: string, sport: number, dst: string, dport: number): TrackedPacket => ({ ...udp(src, sport, dst, dport), protocol: 136 });
    feed(lite(A, 5000, B, 53));
    feed(lite(B, 53, A, 5000));
    PathClock.wait(2500);
    feed(lite(A, 5000, B, 53));
    expect(tracker.flows()[0].remainingMs).toBe(120_000);
    expect(tracker.flows()[0].assured).toBe(true);
  });

  it('GRE : the packet that follows the first answer lives 180 s and assures the flow, the answer itself still 30 s', () => {
    const { tracker, feed } = lab();
    const gre = (src: string, dst: string): TrackedPacket => ({ protocol: 47, srcIP: src, srcPort: 0, dstIP: dst, dstPort: 0 });
    feed(gre(A, B));
    feed(gre(B, A));
    expect(tracker.flows()[0].remainingMs).toBe(30_000);
    expect(tracker.flows()[0].assured).toBe(false);
    feed(gre(A, B));
    expect(tracker.flows()[0].remainingMs).toBe(180_000);
    expect(tracker.flows()[0].assured).toBe(true);
  });

  it('a UDP exchange that lasts more than two seconds becomes a stream : 120 s and assured', () => {
    const { tracker, feed } = lab();
    feed(udp(A, 5000, B, 53));
    feed(udp(B, 53, A, 5000));
    expect(tracker.flows()[0].remainingMs).toBe(30_000);
    expect(tracker.flows()[0].assured).toBe(false);
    PathClock.wait(2500);
    feed(udp(A, 5000, B, 53));
    expect(tracker.flows()[0].remainingMs).toBe(120_000);
    expect(tracker.flows()[0].assured).toBe(true);
  });

  it.each([
    [2000, 30_000, false],
    [2001, 120_000, true],
  ])('a UDP exchange is a stream only when time_after says so : %i ms after the first datagram the flow lives %i s, assured %s', (elapsed, remaining, assured) => {
    const { tracker, feed } = lab();
    feed(udp(A, 5000, B, 53));
    feed(udp(B, 53, A, 5000));
    PathClock.wait(elapsed);
    feed(udp(A, 5000, B, 53));
    expect(tracker.flows()[0].remainingMs).toBe(remaining);
    expect(tracker.flows()[0].assured).toBe(assured);
  });

  it('a UDP request that nobody answers keeps 30 s however long it is repeated', () => {
    const { tracker, feed } = lab();
    feed(udp(A, 5000, B, 53));
    PathClock.wait(3000);
    feed(udp(A, 5000, B, 53));
    expect(tracker.flows()[0].remainingMs).toBe(30_000);
    expect(tracker.flows()[0].assured).toBe(false);
  });

  it('an expired flow is gone : the answer to a request that waited too long is INVALID for ICMP and NEW for UDP', () => {
    const { tracker, feed } = lab();
    feed(echo(A, B, 8, 1));
    feed(udp(A, 5000, B, 53));
    PathClock.wait(30_001);
    expect(tracker.flows()).toHaveLength(0);
    expect(feed(echo(B, A, 0, 1))).toBe('INVALID');
    expect(feed(udp(B, 53, A, 5000))).toBe('NEW');
  });

  it('flush says how many flows it removed and leaves none', () => {
    const { tracker, feed } = lab();
    feed(udp(A, 1, B, 2));
    feed(udp(A, 3, B, 4));
    expect(tracker.flush()).toBe(2);
    expect(tracker.flows()).toHaveLength(0);
  });
});

describe('what is only looked at is not changed', () => {
  it('classify tells the state without moving the flow : a reply seen by classify is not a reply seen', () => {
    const { tracker, feed } = lab();
    feed(udp(A, 5000, B, 53));
    expect(tracker.classify(udp(B, 53, A, 5000))).toBe('ESTABLISHED');
    expect(tracker.flows()[0].replied).toBe(false);
    expect(feed(udp(A, 5000, B, 53))).toBe('NEW');
  });
});

const countersOf = (listing: string): number[] =>
  listing.split('\n').filter((line) => /^\s*\d+\s+\d+\s+\w+\s/.test(line)).map((line) => Number(line.trim().split(/\s+/)[0]));

describe('on the wire : the error that answers a packet of ours is RELATED, and a stateful host hears it', () => {
  it('INPUT DROP with ESTABLISHED,RELATED : the host-prohibited error of B reaches ping', async () => {
    const { a, b } = linuxPair();
    await b.executeCommand('sudo iptables -A INPUT -p icmp --icmp-type echo-request -j REJECT --reject-with icmp-host-prohibited');
    await a.executeCommand('sudo iptables -P INPUT DROP');
    await a.executeCommand('sudo iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT');
    const out = await pingOnSimulatedClock(a, 'ping -c 1 -W 1 10.0.0.2');
    expect(out).toContain('From 10.0.0.2 icmp_seq=1 Destination Host Prohibited');
    expect(out).toContain('+1 errors');
    expect(countersOf(await a.executeCommand('sudo iptables -L INPUT -v -n'))).toEqual([1]);
  });

  it('one rule per state : the error is counted by RELATED and by no other', async () => {
    const { a, b } = linuxPair();
    await b.executeCommand('sudo iptables -A INPUT -p icmp --icmp-type echo-request -j REJECT --reject-with icmp-host-prohibited');
    for (const state of ['RELATED', 'ESTABLISHED', 'INVALID', 'NEW']) await a.executeCommand(`sudo iptables -A INPUT -m state --state ${state}`);
    await pingOnSimulatedClock(a, 'ping -c 1 -W 1 10.0.0.2');
    expect(countersOf(await a.executeCommand('sudo iptables -L INPUT -v -n'))).toEqual([1, 0, 0, 0]);
  });

  it('the echo reply, on the other hand, is ESTABLISHED', async () => {
    const { a } = linuxPair();
    for (const state of ['RELATED', 'ESTABLISHED', 'INVALID']) await a.executeCommand(`sudo iptables -A INPUT -m state --state ${state}`);
    expect(await pingOnSimulatedClock(a, 'ping -c 1 -W 1 10.0.0.2')).toContain('64 bytes from 10.0.0.2');
    expect(countersOf(await a.executeCommand('sudo iptables -L INPUT -v -n'))).toEqual([0, 1, 0]);
  });

  it('traceroute behind the same policy sees the hop that answers with a port unreachable', async () => {
    const { a } = linuxPair();
    await a.executeCommand('sudo iptables -P INPUT DROP');
    await a.executeCommand('sudo iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT');
    const out = await a.executeCommand('traceroute -n -m 1 -q 1 -w 1 10.0.0.2');
    expect(out).toMatch(/^ 1 {2}10\.0\.0\.2 /m);
  });

  it('IPv6 : the neighbour discovery of B and A is UNTRACKED, the error is RELATED', async () => {
    const { a, b } = linuxPair();
    await b.executeCommand('sudo ip6tables -A INPUT -p icmpv6 --icmpv6-type echo-request -j REJECT');
    await a.executeCommand('sudo ip6tables -P INPUT DROP');
    await a.executeCommand('sudo ip6tables -A INPUT -m state --state UNTRACKED -j ACCEPT');
    await a.executeCommand('sudo ip6tables -A INPUT -m state --state RELATED -j ACCEPT');
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 1 -W 1 2001:db8::2');
    expect(out).toContain('From 2001:db8::2 icmp_seq=1 Destination unreachable: Port unreachable');
    expect(countersOf(await a.executeCommand('sudo ip6tables -L INPUT -v -n'))[1]).toBe(1);
  });

  it('TEMOIN : without any state rule the same error is printed, and the policy DROP without RELATED hides it', async () => {
    const { a, b } = linuxPair();
    await b.executeCommand('sudo iptables -A INPUT -p icmp --icmp-type echo-request -j REJECT --reject-with icmp-host-prohibited');
    expect(await pingOnSimulatedClock(a, 'ping -c 1 -W 1 10.0.0.2')).toContain('Destination Host Prohibited');
    await a.executeCommand('sudo iptables -P INPUT DROP');
    await a.executeCommand('sudo iptables -A INPUT -m state --state ESTABLISHED -j ACCEPT');
    expect(await pingOnSimulatedClock(a, 'ping -c 1 -W 1 10.0.0.2')).not.toContain('Destination Host Prohibited');
  });
});

describe('a deleted flow is gone from the table', () => {
  it('the answer to a request whose flow was deleted is INVALID, as it is after the flow timed out', () => {
    const { tracker, feed } = lab();
    feed(echo(A, B, 8, 7));
    expect(tracker.delete((flow) => flow.original.protocol === 1).length).toBe(1);
    expect(feed(echo(B, A, 0, 7))).toBe('INVALID');
  });

  it('delete reports the entries it took and leaves the others', () => {
    const { tracker, feed } = lab();
    feed(udp(A, 5000, B, 53));
    feed(udp(A, 5001, B, 53));
    const taken = tracker.delete((flow) => flow.original.srcPort === 5000);
    expect(taken.map((flow) => flow.original.srcPort)).toEqual([5000]);
    expect(tracker.flows().map((flow) => flow.original.srcPort)).toEqual([5001]);
  });
});

describe('a packet that leaves by lo and comes back in is one sighting of one flow', () => {
  const leg = (direction: 'out' | 'in'): PacketInfo => ({ direction, protocol: 17, srcIP: A, srcPort: 4000, dstIP: B, dstPort: 9, iface: 'lo' });

  it('two legs entered with the same packet insert the flow and never find it, entered apart the second finds what the first inserted', () => {
    const together = new LinuxIptablesManager();
    const packet = {};
    together.filterPacket(leg('out'), packet);
    together.filterPacket(leg('in'), packet);
    expect(together.connections.statistics).toMatchObject({ insert: 1, found: 0 });
    const apart = new LinuxIptablesManager();
    apart.filterPacket(leg('out'));
    apart.filterPacket(leg('in'));
    expect(apart.connections.statistics).toMatchObject({ insert: 1, found: 1 });
  });

  const counters = async (host: { executeCommand(command: string): Promise<string> | string }) => {
    const row = String(await host.executeCommand('sudo conntrack -S')).split('\n')[0];
    return { found: Number(/found=(\d+)/.exec(row)?.[1]), insert: Number(/ insert=(\d+)/.exec(row)?.[1]) };
  };

  it('a ping to oneself inserts one flow, and the kernel answer is the only sighting', async () => {
    const { a } = linuxPair();
    await pingOnSimulatedClock(a, 'ping -c 1 127.0.0.1');
    const before = await counters(a);
    await pingOnSimulatedClock(a, 'ping -c 1 127.0.0.1');
    const after = await counters(a);
    expect(after.insert - before.insert).toBe(1);
    expect(after.found - before.found).toBe(1);
  });

  it('a ping to ::1 inserts one flow, and the kernel answer is the only sighting', async () => {
    const { a } = linuxPair();
    await pingOnSimulatedClock(a, 'ping -6 -c 1 ::1');
    await counters(a);
    const before = await counters(a);
    await pingOnSimulatedClock(a, 'ping -6 -c 1 ::1');
    const after = await counters(a);
    expect(after.insert - before.insert).toBe(1);
    expect(after.found - before.found).toBe(1);
  });

  it('a datagram to a closed local port inserts one flow, and the error that answers it is the only sighting', async () => {
    const { a } = linuxPair();
    await counters(a);
    await counters(a);
    const before = await counters(a);
    a.sendUdpDatagram(new IPAddress('127.0.0.1'), 9, 4000, 'x', 1);
    const after = await counters(a);
    expect(after.insert - before.insert).toBe(1);
    expect(after.found - before.found).toBe(1);
  });
});

