/**
 * Ce que la machine emet sans socket TCP ni UDP traverse les crochets comme tout paquet local. Un echo de `ping`, un echo forge par
 * `hping3 -1 -a`, un datagramme brut de `hping3 --rawip`, une sonde `traceroute -I` ou `-P`, un datagramme adresse a un groupe, le rapport
 * IGMP d'une machine qui rejoint un groupe, le datagramme externe d'un tunnel GRE : chacun passe, dans l'ordre du noyau, par la chaine OUTPUT
 * de la table nat (DNAT, REDIRECT vers 127.0.0.1, DROP), la recherche de route refaite quand l'adresse de destination a change, la chaine
 * OUTPUT du filtre, POSTROUTING de la table nat sur le datagramme ENTIER, puis la fragmentation, et seulement apres le voisin du saut suivant.
 * Le noyau n'envoie donc aucun ARP pour un paquet que OUTPUT jette, cherche le voisin de l'adresse TRADUITE et jamais de l'adresse composee,
 * et le premier echo vers un voisin inconnu paie l'ARP dans son temps aller-retour (iputils ping.c ping4_send_probe date la sonde avant sendmsg).
 *
 * Mesure de depart (arbre portant les lots precedents ; inside 10.0.0.2 -- voisin 10.0.0.3 -- GW 10.0.0.1 -- outside 203.0.113.2) :
 *     -t nat -A OUTPUT -d 10.0.0.9 -p icmp -j DNAT --to-destination 10.0.0.3 ; ping 10.0.0.9  ->  « Destination Host Unreachable », compteur de la
 *                                              regle a 0, aucun flux, et `ip neigh` garde « 10.0.0.9 FAILED » : la chaine nat n'est pas lue pour un
 *                                              echo, et le voisin de l'adresse composee est cherche par ARP avant toute chaine
 *     le meme REDIRECT, le meme DROP (ping vers le voisin : « 1 received »), le meme DNAT sur un echo forge, sur un datagramme de protocole 47 ou
 *                                              sur un datagramme UDP pour 224.0.0.251  ->  compteur a 0, aucun effet
 *     iptables -A OUTPUT -d 10.0.0.9 -j DROP ; ping 10.0.0.9  ->  « Destination Host Unreachable » et « FAILED » : l'ARP part avant la chaine OUTPUT
 *                                              du filtre, qui ne compte rien
 *     iptables -A OUTPUT -p 47 -j DROP ; hping3 --rawip -H 47 voisin, traceroute -P 47, `-p icmp` avec traceroute -I, `-p 2` avec un `join` de groupe,
 *     le datagramme externe d'un tunnel GRE (`encapsulateAndSend`)  ->  la trame part, compteur a 0 : ni `sendIpv4Packet` ni la sonde de traceroute
 *                                              ne consultaient la chaine OUTPUT
 *     ping -s 3000 avec un SNAT de POSTROUTING vers une seconde adresse de la machine  ->  les trois fragments partent sous l'adresse d'origine : le
 *                                              SNAT etait lu trame par trame, et aucun fragment n'est suivi ; meme chose pour un datagramme UDP de 3000
 *     Windows, `ping -t` vers un voisin qui ne repond pas  ->  « Request timed out. » une seule fois puis la fin du flux, la ou chaque sonde doit
 *                                              dire « Destination unreachable »
 *
 * Autorites : noyau Linux 6.1 -- net/ipv4/ip_output.c (__ip_local_out : NF_INET_LOCAL_OUT puis dst_output ; ip_output : NF_INET_POST_ROUTING puis
 * ip_finish_output ; __ip_finish_output : ip_fragment AVANT ip_finish_output2, qui seul cherche le voisin par ip_neigh_for_gw), net/ipv4/raw.c
 * (raw_send_hdrinc : NF_HOOK(NF_INET_LOCAL_OUT) pour un paquet fourni avec son en-tete), net/ipv4/ping.c (ping_v4_sendmsg : ip_route_output_flow
 * puis ip_push_pending_frames, c'est-a-dire ip_local_out), net/ipv4/netfilter/iptable_nat.c et net/netfilter/nf_nat_proto.c
 * (nf_nat_ipv4_local_fn : la chaine est lue par nf_nat_ipv4_fn, puis `ip_route_me_harder` si l'adresse de destination du tuple d'origine
 * differe de l'adresse source du tuple de reponse, et l'echec de cette route rend NF_DROP_ERR(err), l'erreur de la route), net/ipv4/netfilter.c
 * (ip_route_me_harder garde l'adresse source locale du paquet : `fl4.saddr = saddr`), iputils 20221126 ping.c (ping4_send_probe : gettimeofday
 * dans la charge utile avant l'appel d'envoi) et ping_common.c (pinger : un envoi refuse sans erreur ICMP en attente n'ecrit aucune ligne) ;
 * iptables-extensions(8) pour DNAT, REDIRECT et SNAT.
 *
 * Discrimination : contre l'arbre sans le lot (EndHost remis a son etat, sonde conservee), 41 des 70 cas tombent et 29 passent des deux cotes :
 * dix TEMOINS qui disent que le laboratoire est sain (l'adresse que personne ne porte echoue, la regle REJECT du filtre rend bien une erreur a la
 * machine, l'entree FAILED existe sans regle, un datagramme de protocole 47, une sonde `traceroute -I`, une sonde synchrone, un datagramme de groupe,
 * un rapport IGMP et un tunnel GRE arrivent quand aucune regle ne les arrete) et dix-neuf non-regressions que l'ancien chemin tenait deja (une regle
 * pour une autre destination, un autre protocole ou un autre groupe ne change rien ; le SNAT d'un echo, d'un echo forge et d'un datagramme qui
 * tient en un morceau ; le DROP du filtre pour un echo ou une sonde synchrone et le resultat brut d'un REJECT ; le DROP de POSTROUTING pour un
 * echo ; un echo de diffusion sans ARP ; le texte d'un voisin muet et sa suite de sondes ; le TTL, la taille et les horodatages d'un echo forge ;
 * une route qui echoue pour un TCP).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  IPAddress, MACAddress, SubnetMask, resetCounters, createIPv4Packet, ETHERTYPE_ARP, ETHERTYPE_IPV4, IP_PROTO_ICMP, IP_PROTO_UDP,
  type ARPPacket, type EthernetFrame, type ICMPPacket, type IPv4Packet,
} from '@/network/core/types';
import type { EchoOptions, PingResult } from '@/network/devices/EndHost';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { Cable } from '@/network/hardware/Cable';
import { Hub } from '@/network/devices/Hub';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../support/fastPing';
import { framesReceivedOn, framesSentOn } from '../../support/wireWatch';
import {
  natGateway, nat, sudo, flows, connect, escaped, type Host, type NatGateway,
  INSIDE_IP, NEIGHBOUR_IP, OUTSIDE_IP,
} from '../../support/natGateway';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const NOBODY = '10.0.0.9';
const SECOND = '10.0.0.22';
const FORGED = '10.0.0.77';
const GRE = 47;
const ECHO_BYTES = 3000;

const ping = (host: Host, target: string, ...options: string[]): Promise<string> =>
  pingOnSimulatedClock(host, ['ping', '-c', '1', '-W', '1', ...options, target].join(' '));
const run = (host: Host, command: string): Promise<string> => pingOnSimulatedClock(host, command);

interface RawEchoEngine {
  executePingSequence(
    target: IPAddress, count: number, timeoutMs: number, ttl: number | undefined, options: EchoOptions,
  ): Promise<PingResult[]>;
}

const rawEchoEngine = (host: Host): RawEchoEngine => host as unknown as RawEchoEngine;

async function onVirtualClock<T>(host: Host, work: () => Promise<T>): Promise<T> {
  const clock = new VirtualTimeScheduler();
  host.setScheduler(clock);
  try {
    return await clock.advanceUntilSettled(work());
  } finally {
    host.setScheduler(null);
  }
}

const ipv4Of = (frames: readonly EthernetFrame[]): IPv4Packet[] =>
  frames.filter((frame) => frame.etherType === ETHERTYPE_IPV4).map((frame) => frame.payload as IPv4Packet);
const echoRequestsOf = (frames: readonly EthernetFrame[]): IPv4Packet[] =>
  ipv4Of(frames).filter((packet) => packet.protocol === IP_PROTO_ICMP && (packet.payload as ICMPPacket).icmpType === 'echo-request');
const ofProtocol = (frames: readonly EthernetFrame[], protocol: number): IPv4Packet[] =>
  ipv4Of(frames).filter((packet) => packet.protocol === protocol);
const arpTargetsOf = (frames: readonly EthernetFrame[]): string[] =>
  frames.filter((frame) => frame.etherType === ETHERTYPE_ARP)
    .map((frame) => frame.payload as ARPPacket)
    .filter((arp) => arp.operation === 'request')
    .map((arp) => arp.targetIP.toString());

async function counter(host: Host, table: string, chain: string, ruleIndex = 1): Promise<number> {
  const listing = await sudo(host, `iptables ${table === 'filter' ? '' : `-t ${table} `}-L ${chain} -v -n`);
  const rows = listing.split('\n').slice(2).filter((row) => row.trim() !== '');
  return Number(rows[ruleIndex - 1].trim().split(/\s+/)[0]);
}
const natCounter = (host: Host, chain: string, ruleIndex = 1): Promise<number> => counter(host, 'nat', chain, ruleIndex);
const filterCounter = (host: Host, chain: string, ruleIndex = 1): Promise<number> => counter(host, 'filter', chain, ruleIndex);

const dnatEcho = (to: string, destination = NOBODY): string =>
  `-A OUTPUT -d ${destination} -p icmp -j DNAT --to-destination ${to}`;

async function withSecondAddress(lab: NatGateway, protocol: 'icmp' | 'udp'): Promise<NatGateway> {
  await sudo(lab.inside, `ip addr add ${SECOND}/24 dev eth0`);
  await nat(lab.inside, `-A POSTROUTING -o eth0 -p ${protocol} -j SNAT --to-source ${SECOND}`);
  return lab;
}

describe('DNAT in OUTPUT sends the echo the host emits to another address', () => {
  it('TEMOIN : with no nat rule an echo to an address nobody holds ends in Host Unreachable', async () => {
    const { inside } = await natGateway();
    expect(await ping(inside, NOBODY)).toContain('From 10.0.0.2 icmp_seq=1 Destination Host Unreachable');
  });

  it('an echo dialed at an address nobody holds is answered, under the dialed address, by the host the rule names', async () => {
    const { inside } = await natGateway();
    await nat(inside, dnatEcho(NEIGHBOUR_IP));
    const output = await ping(inside, NOBODY);
    expect(output).toContain(`64 bytes from ${NOBODY}: icmp_seq=1`);
    expect(output).toContain('1 packets transmitted, 1 received');
  });

  it('the neighbour receives the request addressed to itself, from the address the sender composed it with', async () => {
    const { inside, neighbour } = await natGateway();
    await nat(inside, dnatEcho(NEIGHBOUR_IP));
    const heard = framesReceivedOn(neighbour, 'eth0');
    await ping(inside, NOBODY);
    expect(echoRequestsOf(heard).map((packet) => `${packet.sourceIP}>${packet.destinationIP}`)).toEqual([`${INSIDE_IP}>${NEIGHBOUR_IP}`]);
  });

  it('the host asks for the link address of the translated destination and never of the dialed one', async () => {
    const { inside } = await natGateway();
    await nat(inside, dnatEcho(NEIGHBOUR_IP));
    const sent = framesSentOn(inside, 'eth0');
    await ping(inside, NOBODY);
    expect(arpTargetsOf(sent)).toEqual([NEIGHBOUR_IP]);
    const neighbours = await sudo(inside, 'ip neigh show');
    expect(neighbours).toContain(NEIGHBOUR_IP);
    expect(neighbours).not.toContain(NOBODY);
  });

  it('the flow keeps the dialed address in the original tuple and the translated one in the reply tuple', async () => {
    const { inside } = await natGateway();
    await nat(inside, dnatEcho(NEIGHBOUR_IP));
    await ping(inside, NOBODY);
    const lines = await flows(inside, '-p', 'icmp');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(
      `src=${escaped(INSIDE_IP)} dst=${escaped(NOBODY)} type=8 code=0 id=\\d+ src=${escaped(NEIGHBOUR_IP)} dst=${escaped(INSIDE_IP)} type=0 code=0 id=\\d+`));
  });

  it('the nat chain is read for the first packet of the flow only', async () => {
    const { inside } = await natGateway();
    await nat(inside, dnatEcho(NEIGHBOUR_IP));
    const output = await run(inside, `ping -c 3 -W 1 ${NOBODY}`);
    expect(output).toContain('3 packets transmitted, 3 received');
    expect(await natCounter(inside, 'OUTPUT')).toBe(1);
  });

  it('the route is looked up again after the rewrite : a host beyond the gateway is reached through the gateway', async () => {
    const { inside, gateway } = await natGateway();
    await nat(inside, dnatEcho(OUTSIDE_IP));
    const sent = framesSentOn(inside, 'eth0');
    expect(await ping(inside, NOBODY)).toContain(`64 bytes from ${NOBODY}: icmp_seq=1`);
    const [request] = echoRequestsOf(sent);
    expect(`${request.sourceIP}>${request.destinationIP}`).toBe(`${INSIDE_IP}>${OUTSIDE_IP}`);
    const toGateway = sent.find((frame) => frame.etherType === ETHERTYPE_IPV4 && (frame.payload as IPv4Packet) === request);
    expect(toGateway!.dstMAC.toString()).toBe(gateway.getPort('eth0')!.getMAC().toString());
  });

  it('a rewritten echo to an address off the link leaves through the default route', async () => {
    const { inside, gateway } = await natGateway();
    await nat(inside, dnatEcho('192.0.2.77'));
    const sent = framesSentOn(inside, 'eth0');
    await ping(inside, NOBODY);
    const [request] = echoRequestsOf(sent);
    expect(request.destinationIP.toString()).toBe('192.0.2.77');
    const frame = sent.find((candidate) => candidate.etherType === ETHERTYPE_IPV4 && (candidate.payload as IPv4Packet) === request);
    expect(frame!.dstMAC.toString()).toBe(gateway.getPort('eth0')!.getMAC().toString());
  });

  it('a route that fails after the rewrite refuses the send with ENETUNREACH, the error ip_route_me_harder returns', async () => {
    const { inside } = await natGateway();
    await sudo(inside, 'ip route del default');
    await nat(inside, dnatEcho('192.0.2.77'));
    const sent = framesSentOn(inside, 'eth0');
    const [result] = await rawEchoEngine(inside).executePingSequence(new IPAddress(NOBODY), 1, 500, undefined, {});
    expect(result).toMatchObject({ success: false, error: 'Network is unreachable', sendError: 'ENETUNREACH' });
    expect(echoRequestsOf(sent)).toEqual([]);
  });

  it('-o names the interface of the route chosen before the rewrite', async () => {
    const { inside } = await natGateway();
    await nat(inside, `-A OUTPUT -o lo -d ${NOBODY} -p icmp -j DNAT --to-destination ${NEIGHBOUR_IP}`, `-A OUTPUT -o eth0 -d ${NOBODY} -p icmp -j DNAT --to-destination ${NEIGHBOUR_IP}`);
    await ping(inside, NOBODY);
    expect(await natCounter(inside, 'OUTPUT', 1)).toBe(0);
    expect(await natCounter(inside, 'OUTPUT', 2)).toBe(1);
  });

  it('a rule for another protocol is not read for an echo', async () => {
    const { inside } = await natGateway();
    await nat(inside, `-A OUTPUT -d ${NOBODY} -p udp -j DNAT --to-destination ${NEIGHBOUR_IP}`);
    expect(await ping(inside, NOBODY)).toContain('Destination Host Unreachable');
    expect(await natCounter(inside, 'OUTPUT')).toBe(0);
  });

  it('an echo to the machine\'s own address is rewritten too, and reaches the neighbour', async () => {
    const { inside, neighbour } = await natGateway();
    await nat(inside, dnatEcho(NEIGHBOUR_IP, INSIDE_IP));
    const heard = framesReceivedOn(neighbour, 'eth0');
    expect(await ping(inside, INSIDE_IP)).toContain(`64 bytes from ${INSIDE_IP}: icmp_seq=1`);
    expect(echoRequestsOf(heard)).toHaveLength(1);
  });

  it('an echo to the machine itself, rewritten to an address nobody holds, fails from the source it was sent with', async () => {
    const { inside } = await natGateway();
    await sudo(inside, `ip addr add ${SECOND}/24 dev eth0`);
    await nat(inside, dnatEcho(NOBODY, INSIDE_IP));
    expect(await ping(inside, INSIDE_IP, '-I', SECOND)).toContain(`From ${SECOND} icmp_seq=1 Destination Host Unreachable`);
  });

  it('an echo to 127.0.0.1 is rewritten and leaves the machine under its loopback source, which the route keeps', async () => {
    const { inside, neighbour } = await natGateway();
    await nat(inside, dnatEcho(NEIGHBOUR_IP, '127.0.0.1'));
    const heard = framesReceivedOn(neighbour, 'eth0');
    await ping(inside, '127.0.0.1');
    expect(echoRequestsOf(heard).map((packet) => `${packet.sourceIP}>${packet.destinationIP}`)).toEqual([`127.0.0.1>${NEIGHBOUR_IP}`]);
  });
});

describe('REDIRECT and DROP in OUTPUT', () => {
  it('REDIRECT answers the echo on the machine itself, under the dialed address', async () => {
    const { inside } = await natGateway();
    await nat(inside, `-A OUTPUT -d ${NOBODY} -p icmp -j REDIRECT`);
    expect(await ping(inside, NOBODY)).toContain(`64 bytes from ${NOBODY}: icmp_seq=1`);
  });

  it('REDIRECT keeps the dialed address in the original tuple and 127.0.0.1 in the reply tuple, and nothing leaves', async () => {
    const { inside } = await natGateway();
    await nat(inside, `-A OUTPUT -d ${NOBODY} -p icmp -j REDIRECT`);
    const sent = framesSentOn(inside, 'eth0');
    await ping(inside, NOBODY);
    const lines = await flows(inside, '-p', 'icmp');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`src=${escaped(INSIDE_IP)} dst=${escaped(NOBODY)} type=8 code=0 id=\\d+ src=127\\.0\\.0\\.1 dst=${escaped(INSIDE_IP)} type=0`));
    expect(echoRequestsOf(sent)).toEqual([]);
  });

  it('an echo that REDIRECT keeps on the machine takes the time of a loopback round trip', async () => {
    const { inside } = await natGateway();
    await nat(inside, `-A OUTPUT -d ${NOBODY} -p icmp -j REDIRECT`);
    expect(await ping(inside, NOBODY)).toContain('time=0.010 ms');
  });

  it('DROP refuses the echo before anything leaves, and the rule counts it', async () => {
    const { inside } = await natGateway();
    await nat(inside, '-A OUTPUT -p icmp -j DROP');
    const sent = framesSentOn(inside, 'eth0');
    expect(await ping(inside, NEIGHBOUR_IP)).toContain('1 packets transmitted, 0 received');
    expect(echoRequestsOf(sent)).toEqual([]);
    expect(await natCounter(inside, 'OUTPUT')).toBe(1);
  });

  it('the raw result of a send that DROP refuses names the errno and nothing else', async () => {
    const { inside } = await natGateway();
    await nat(inside, '-A OUTPUT -p icmp -j DROP');
    const raw = await rawEchoEngine(inside).executePingSequence(new IPAddress(NEIGHBOUR_IP), 1, 500, undefined, {});
    expect(raw).toEqual([{
      success: false, rttMs: 0, ttl: 0, seq: 1, bytes: 0, fromIP: '', error: 'Operation not permitted', sendError: 'EPERM',
    }]);
  });

  it('the raw result of a send that a filter REJECT answers carries the same errno, after the error it chose', async () => {
    const { inside } = await natGateway();
    await sudo(inside, `iptables -A OUTPUT -d ${NEIGHBOUR_IP} -p icmp --icmp-type echo-request -j REJECT --reject-with icmp-host-unreachable`);
    const [result] = await rawEchoEngine(inside).executePingSequence(new IPAddress(NEIGHBOUR_IP), 1, 500, undefined, {});
    expect(result).toMatchObject({ success: false, sendError: 'EPERM' });
    expect(result.error).toContain('Destination unreachable');
  });

  it('every probe of a dropped flow reads the chain again : the flow was never confirmed', async () => {
    const { inside } = await natGateway();
    await nat(inside, '-A OUTPUT -p icmp -j DROP');
    await run(inside, `ping -c 2 -W 1 ${NEIGHBOUR_IP}`);
    expect(await natCounter(inside, 'OUTPUT')).toBe(2);
  });

  it('a DROP for another destination leaves the echo alone', async () => {
    const { inside } = await natGateway();
    await nat(inside, `-A OUTPUT -d ${NOBODY} -p icmp -j DROP`);
    expect(await ping(inside, NEIGHBOUR_IP)).toContain('1 packets transmitted, 1 received');
    expect(await natCounter(inside, 'OUTPUT')).toBe(0);
  });

  it('DROP refuses the echo the machine sends to itself', async () => {
    const { inside } = await natGateway();
    await nat(inside, '-A OUTPUT -p icmp -j DROP');
    expect(await ping(inside, INSIDE_IP)).toContain('1 packets transmitted, 0 received');
    expect(await natCounter(inside, 'OUTPUT')).toBe(1);
  });

  it('a rule for another destination leaves the echo the machine sends to itself alone', async () => {
    const { inside } = await natGateway();
    await nat(inside, `-A OUTPUT -d ${NOBODY} -p icmp -j DROP`);
    expect(await ping(inside, INSIDE_IP)).toContain('1 packets transmitted, 1 received');
  });
});

describe('POSTROUTING reads the datagram the host emits as a whole, before it is cut', () => {
  it('SNAT to a second address of the machine : the request leaves under it and the reply is accepted', async () => {
    const lab = await withSecondAddress(await natGateway(), 'icmp');
    const heard = framesReceivedOn(lab.neighbour, 'eth0');
    expect(await ping(lab.inside, NEIGHBOUR_IP)).toContain('1 packets transmitted, 1 received');
    expect(echoRequestsOf(heard).map((packet) => packet.sourceIP.toString())).toEqual([SECOND]);
  });

  it('the flow shows the second address in the reply tuple', async () => {
    const lab = await withSecondAddress(await natGateway(), 'icmp');
    await ping(lab.inside, NEIGHBOUR_IP);
    const lines = await flows(lab.inside, '-p', 'icmp');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`src=${escaped(NEIGHBOUR_IP)} dst=${escaped(SECOND)} type=0`));
  });

  it(`an echo of ${ECHO_BYTES} bytes leaves in three pieces, all under the second address`, async () => {
    const lab = await withSecondAddress(await natGateway(), 'icmp');
    const heard = framesReceivedOn(lab.neighbour, 'eth0');
    const output = await run(lab.inside, `ping -c 1 -W 1 -s ${ECHO_BYTES} ${NEIGHBOUR_IP}`);
    expect(output).toContain(`${ECHO_BYTES + 8} bytes from ${NEIGHBOUR_IP}`);
    const pieces = ofProtocol(heard, IP_PROTO_ICMP);
    expect(pieces).toHaveLength(3);
    expect(pieces.map((packet) => packet.sourceIP.toString())).toEqual([SECOND, SECOND, SECOND]);
  });

  it(`a UDP datagram of ${ECHO_BYTES} bytes leaves in three pieces, all under the second address`, async () => {
    const lab = await withSecondAddress(await natGateway(), 'udp');
    const heard = framesReceivedOn(lab.neighbour, 'eth0');
    expect(lab.inside.sendUdpDatagram(new IPAddress(NEIGHBOUR_IP), 9, 5000, null, ECHO_BYTES)).toBe(true);
    const pieces = ofProtocol(heard, IP_PROTO_UDP);
    expect(pieces).toHaveLength(3);
    expect(pieces.map((packet) => packet.sourceIP.toString())).toEqual([SECOND, SECOND, SECOND]);
  });

  it('a datagram that fits in one piece is translated once', async () => {
    const lab = await withSecondAddress(await natGateway(), 'udp');
    const heard = framesReceivedOn(lab.neighbour, 'eth0');
    expect(lab.inside.sendUdpDatagram(new IPAddress(NEIGHBOUR_IP), 9, 5000, null, 100)).toBe(true);
    expect(ofProtocol(heard, IP_PROTO_UDP).map((packet) => packet.sourceIP.toString())).toEqual([SECOND]);
    expect(await natCounter(lab.inside, 'POSTROUTING')).toBe(1);
  });
});

describe('a refusal that the machine answers itself, and one that it does not', () => {
  const unreachableErrors = (host: NatGateway['inside']): unknown[] => {
    const errors: unknown[] = [];
    host.getBus().subscribe('host.icmp.unreachable', (event) => { errors.push(event.payload); });
    return errors;
  };

  it('TEMOIN : a REJECT of the filter OUTPUT chain draws an ICMP error from the machine itself', async () => {
    const { inside } = await natGateway();
    await sudo(inside, `iptables -A OUTPUT -p tcp --dport 8080 -j REJECT --reject-with icmp-host-unreachable`);
    const errors = unreachableErrors(inside);
    await connect(inside, NEIGHBOUR_IP, 8080);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('a rewritten destination with no route draws none : the route\'s error goes to the caller, nothing is rejected', async () => {
    const { inside } = await natGateway();
    await sudo(inside, 'ip route del default');
    await nat(inside, '-A OUTPUT -p tcp --dport 8080 -j DNAT --to-destination 192.0.2.77:80');
    const errors = unreachableErrors(inside);
    await connect(inside, NOBODY, 8080);
    expect(errors).toEqual([]);
  });
});

describe('DROP in POSTROUTING refuses what the host emits', () => {
  it('an echo that the nat POSTROUTING chain drops never reaches the wire, and the rule counts it', async () => {
    const { inside } = await natGateway();
    await nat(inside, '-A POSTROUTING -p icmp -j DROP');
    const sent = framesSentOn(inside, 'eth0');
    expect(await ping(inside, NEIGHBOUR_IP)).toContain('1 packets transmitted, 0 received');
    expect(echoRequestsOf(sent)).toEqual([]);
    expect(await natCounter(inside, 'POSTROUTING')).toBe(1);
  });

  it('a datagram of three pieces that it drops sends none of them', async () => {
    const { inside, neighbour } = await natGateway();
    await nat(inside, '-A POSTROUTING -p udp -j DROP');
    const heard = framesReceivedOn(neighbour, 'eth0');
    inside.sendUdpDatagram(new IPAddress(NEIGHBOUR_IP), 9, 5000, null, ECHO_BYTES);
    expect(ofProtocol(heard, IP_PROTO_UDP)).toEqual([]);
  });
});

describe('the OUTPUT chain of the filter table precedes the resolution of the neighbour', () => {
  it('TEMOIN : with no rule the host asks for the unreachable address and keeps the failed entry', async () => {
    const { inside } = await natGateway();
    const sent = framesSentOn(inside, 'eth0');
    await ping(inside, NOBODY);
    expect(arpTargetsOf(sent)).toContain(NOBODY);
    expect(await sudo(inside, 'ip neigh show')).toContain(`${NOBODY} dev eth0  FAILED`);
  });

  it('a DROP in OUTPUT sends no ARP request at all', async () => {
    const { inside } = await natGateway();
    await sudo(inside, `iptables -A OUTPUT -d ${NOBODY} -j DROP`);
    const sent = framesSentOn(inside, 'eth0');
    const output = await ping(inside, NOBODY);
    expect(arpTargetsOf(sent)).toEqual([]);
    expect(output).not.toContain('Destination Host Unreachable');
    expect(await sudo(inside, 'ip neigh show')).not.toContain(NOBODY);
  });

  it('every probe to an unreachable host traverses the chain, whether or not the neighbour answers', async () => {
    const { inside } = await natGateway();
    await sudo(inside, `iptables -A OUTPUT -d ${NOBODY} -j ACCEPT`);
    await run(inside, `ping -c 2 -W 1 ${NOBODY}`);
    expect(await filterCounter(inside, 'OUTPUT')).toBe(2);
  });

  it('one sequence of probes asks mcast_solicit (three) times for an unreachable neighbour and fails every probe with the local address', async () => {
    const { inside } = await natGateway();
    const sent = framesSentOn(inside, 'eth0');
    const results = await onVirtualClock(inside, () =>
      rawEchoEngine(inside).executePingSequence(new IPAddress(NOBODY), 3, 500, undefined, {}));
    expect(arpTargetsOf(sent).filter((target) => target === NOBODY)).toHaveLength(3);
    expect(results.map((result) => [result.seq, result.success, result.fromIP, result.error])).toEqual([
      [1, false, INSIDE_IP, `Destination unreachable from ${INSIDE_IP} code 1`],
      [2, false, INSIDE_IP, `Destination unreachable from ${INSIDE_IP} code 1`],
      [3, false, INSIDE_IP, `Destination unreachable from ${INSIDE_IP} code 1`],
    ]);
  });

  it('a broadcast echo leaves for the broadcast address without any ARP request', async () => {
    const { inside } = await natGateway();
    const sent = framesSentOn(inside, 'eth0');
    await run(inside, 'ping -b -c 1 -W 1 10.0.0.255');
    const [request] = echoRequestsOf(sent);
    expect(request.destinationIP.toString()).toBe('10.0.0.255');
    const frame = sent.find((candidate) => candidate.etherType === ETHERTYPE_IPV4 && (candidate.payload as IPv4Packet) === request);
    expect(frame!.dstMAC.toString()).toBe('ff:ff:ff:ff:ff:ff');
    expect(arpTargetsOf(sent)).toEqual([]);
  });

  it('the text the user reads for an unreachable host does not change', async () => {
    const { inside } = await natGateway();
    const output = await run(inside, `ping -c 2 -W 1 ${NOBODY}`);
    expect(output).toContain('From 10.0.0.2 icmp_seq=1 Destination Host Unreachable');
    expect(output).toContain('From 10.0.0.2 icmp_seq=2 Destination Host Unreachable');
    expect(output).toContain('2 packets transmitted, 0 received, +2 errors, 100% packet loss');
  });

  it('a DROP in OUTPUT of the echo to a neighbour that answers still silences it', async () => {
    const { inside } = await natGateway();
    await sudo(inside, `iptables -A OUTPUT -d ${NEIGHBOUR_IP} -p icmp -j DROP`);
    expect(await ping(inside, NEIGHBOUR_IP)).toContain('1 packets transmitted, 0 received');
  });

  it('the first echo to a neighbour not yet resolved pays the ARP exchange in its round-trip time', async () => {
    const { inside } = await natGateway();
    const output = await run(inside, `ping -c 2 -W 1 ${NEIGHBOUR_IP}`);
    const times = [...output.matchAll(/time=([\d.]+) ms/g)].map((match) => Number(match[1]));
    expect(times).toHaveLength(2);
    expect(times[0]).toBeGreaterThan(times[1]);
  });
});

describe('crafted echoes, raw datagrams and probes traverse the same hooks', () => {
  it('a forged echo (hping3 -1 -a) is rewritten by DNAT in OUTPUT and keeps its forged source', async () => {
    const { inside, neighbour } = await natGateway();
    await nat(inside, dnatEcho(NEIGHBOUR_IP));
    const heard = framesReceivedOn(neighbour, 'eth0');
    await run(inside, `hping3 -1 -a ${FORGED} -c 1 ${NOBODY}`);
    expect(echoRequestsOf(heard).map((packet) => `${packet.sourceIP}>${packet.destinationIP}`)).toEqual([`${FORGED}>${NEIGHBOUR_IP}`]);
  });

  it('a forged echo keeps the TTL and the data size the user asked for', async () => {
    const { inside, neighbour } = await natGateway();
    const heard = framesReceivedOn(neighbour, 'eth0');
    await run(inside, `hping3 -1 -a ${FORGED} -t 5 -d 100 -c 1 ${NEIGHBOUR_IP}`);
    const [request] = echoRequestsOf(heard);
    expect([request.sourceIP.toString(), request.ttl, request.totalLength]).toEqual([FORGED, 5, 128]);
    expect((request.payload as ICMPPacket).code).toBe(0);
    expect((request.payload as ICMPPacket).timestamps).toBeUndefined();
  });

  it('a crafted timestamp request leaves with the originate timestamp and the twelve bytes of timestamp data', async () => {
    const { inside, neighbour } = await natGateway();
    const heard = framesReceivedOn(neighbour, 'eth0');
    expect(inside.sendCraftedIcmpTimestamp(new IPAddress(NEIGHBOUR_IP))).toBe(true);
    const request = ipv4Of(heard).find((packet) => packet.protocol === IP_PROTO_ICMP && (packet.payload as ICMPPacket).icmpType === 'timestamp-request')!;
    const icmp = request.payload as ICMPPacket;
    expect([request.totalLength, icmp.code, icmp.sequence]).toEqual([40, 0, 0]);
    expect(icmp.timestamps).toMatchObject({ receive: 0, transmit: 0 });
    expect(icmp.timestamps!.originate).toBeGreaterThanOrEqual(0);
    expect(icmp.timestamps!.originate).toBeLessThan(86_400_000);
  });

  it('a crafted timestamp request is read by the same chains : DROP in the nat OUTPUT chain refuses it', async () => {
    const { inside } = await natGateway();
    await nat(inside, '-A OUTPUT -p icmp -j DROP');
    expect(inside.sendCraftedIcmpTimestamp(new IPAddress(NEIGHBOUR_IP))).toBe(false);
    expect(await natCounter(inside, 'OUTPUT')).toBe(1);
  });

  it('an echo of hping3 -1 is answered through a DNAT of OUTPUT', async () => {
    const { inside } = await natGateway();
    await nat(inside, dnatEcho(NEIGHBOUR_IP));
    expect(await run(inside, `hping3 -1 -c 1 ${NOBODY}`)).toContain('1 packets transmitted, 1 packets received');
  });

  it('TEMOIN : a raw datagram of protocol 47 reaches the wire when no rule stops it', async () => {
    const { inside } = await natGateway();
    const sent = framesSentOn(inside, 'eth0');
    await run(inside, `hping3 --rawip -H ${GRE} -c 1 ${NEIGHBOUR_IP}`);
    expect(ofProtocol(sent, GRE)).toHaveLength(1);
  });

  it('a raw datagram is rewritten by DNAT in OUTPUT and reaches the neighbour', async () => {
    const { inside, neighbour } = await natGateway();
    await nat(inside, `-A OUTPUT -d ${NOBODY} -p ${GRE} -j DNAT --to-destination ${NEIGHBOUR_IP}`);
    const heard = framesReceivedOn(neighbour, 'eth0');
    await run(inside, `hping3 --rawip -H ${GRE} -c 1 ${NOBODY}`);
    expect(ofProtocol(heard, GRE).map((packet) => `${packet.sourceIP}>${packet.destinationIP}`)).toEqual([`${INSIDE_IP}>${NEIGHBOUR_IP}`]);
  });

  it('a raw datagram is refused by a DROP of the nat OUTPUT chain', async () => {
    const { inside } = await natGateway();
    await nat(inside, `-A OUTPUT -p ${GRE} -j DROP`);
    const sent = framesSentOn(inside, 'eth0');
    await run(inside, `hping3 --rawip -H ${GRE} -c 1 ${NEIGHBOUR_IP}`);
    expect(ofProtocol(sent, GRE)).toEqual([]);
    expect(await natCounter(inside, 'OUTPUT')).toBe(1);
  });

  it('a raw datagram is refused by a DROP of the filter OUTPUT chain, and the rule counts it', async () => {
    const { inside } = await natGateway();
    await sudo(inside, `iptables -A OUTPUT -p ${GRE} -j DROP`);
    const sent = framesSentOn(inside, 'eth0');
    await run(inside, `hping3 --rawip -H ${GRE} -c 1 ${NEIGHBOUR_IP}`);
    expect(ofProtocol(sent, GRE)).toEqual([]);
    expect(await filterCounter(inside, 'OUTPUT')).toBe(1);
  });

  it('the probes of traceroute -P are raw datagrams and obey the same chain', async () => {
    const { inside } = await natGateway();
    await sudo(inside, `iptables -A OUTPUT -p ${GRE} -j DROP`);
    const sent = framesSentOn(inside, 'eth0');
    const output = await run(inside, `traceroute -P ${GRE} -n -m 1 -q 1 -w 1 ${NEIGHBOUR_IP}`);
    expect(ofProtocol(sent, GRE)).toEqual([]);
    expect(output).toMatch(/^ 1 {2}\*$/m);
    expect(await filterCounter(inside, 'OUTPUT')).toBe(1);
  });

  it('the probes of traceroute -I are echoes and obey the same chain', async () => {
    const { inside } = await natGateway();
    await sudo(inside, 'iptables -A OUTPUT -p icmp -j DROP');
    const sent = framesSentOn(inside, 'eth0');
    const output = await run(inside, `traceroute -I -n -m 1 -q 1 -w 1 ${NEIGHBOUR_IP}`);
    expect(echoRequestsOf(sent)).toEqual([]);
    expect(output).toMatch(/^ 1 {2}\*$/m);
  });

  it('TEMOIN : the probes of traceroute -I reach the neighbour when no rule stops them', async () => {
    const { inside } = await natGateway();
    const sent = framesSentOn(inside, 'eth0');
    expect(await run(inside, `traceroute -I -n -m 1 -q 1 -w 1 ${NEIGHBOUR_IP}`)).toMatch(/^ 1 {2}10\.0\.0\.3 /m);
    expect(echoRequestsOf(sent)).toHaveLength(1);
  });

  it('a forged echo is read by POSTROUTING : SNAT rewrites its source', async () => {
    const lab = await withSecondAddress(await natGateway(), 'icmp');
    const heard = framesReceivedOn(lab.neighbour, 'eth0');
    await run(lab.inside, `hping3 -1 -a ${FORGED} -c 1 ${NEIGHBOUR_IP}`);
    expect(echoRequestsOf(heard).map((packet) => packet.sourceIP.toString())).toEqual([SECOND]);
  });
});

describe('the streaming ping of Windows learns of an unreachable neighbour probe by probe', () => {
  async function stream(timeoutMs: number): Promise<{ outcome: unknown; failures: string[]; elapsedMs: number }> {
    const windows = new WindowsPC('windows-pc', 'WIN');
    const hub = new Hub('HUB', 2);
    windows.configureInterface('eth0', new IPAddress(INSIDE_IP), new SubnetMask('255.255.255.0'));
    new Cable('windows').connect(windows.getPort('eth0')!, hub.getPort('eth0')!);
    const clock = new VirtualTimeScheduler();
    windows.setScheduler(clock);
    const failures: string[] = [];
    const outcome = await clock.advanceUntilSettled(windows.pingStreamInSession(NOBODY, {
      count: 2, timeoutMs, intervalMs: 1000,
      onResult: (result) => failures.push(`${result.seq} ${result.success} ${result.error}`),
      shouldStop: () => false,
      sleep: (ms) => clock.delay(ms),
    }));
    return { outcome, failures, elapsedMs: clock.now() };
  }

  it('every probe fails with the unreachable text, and the stream goes on', async () => {
    const { outcome, failures } = await stream(1000);
    expect(outcome).toEqual({ resolved: true });
    expect(failures).toEqual([
      `1 false Destination unreachable from ${INSIDE_IP} code 1`,
      `2 false Destination unreachable from ${INSIDE_IP} code 1`,
    ]);
  });

  it('the first probe waits for the neighbour as long as the timeout says, the second does not wait again', async () => {
    const { elapsedMs } = await stream(1000);
    expect(elapsedMs).toBe(2000);
  });
});

describe('the synchronous probe of mtr and Test-Connection traverses the same hooks', () => {
  const probe = (host: NatGateway['inside'], target = NOBODY): boolean => host.sendPingProbeSync(new IPAddress(target)).success;

  it('TEMOIN : an address nobody holds gets no answer', async () => {
    const { inside } = await natGateway();
    expect(probe(inside)).toBe(false);
  });

  it('DNAT in OUTPUT sends the probe to the host the rule names, which answers', async () => {
    const { inside } = await natGateway();
    await nat(inside, dnatEcho(NEIGHBOUR_IP));
    expect(probe(inside)).toBe(true);
    expect(await natCounter(inside, 'OUTPUT')).toBe(1);
  });

  it('TEMOIN : the neighbour answers a probe no rule touches', async () => {
    const { inside } = await natGateway();
    expect(probe(inside, NEIGHBOUR_IP)).toBe(true);
  });

  it('DROP in the nat OUTPUT chain refuses it before any ARP request', async () => {
    const { inside } = await natGateway();
    await nat(inside, '-A OUTPUT -p icmp -j DROP');
    const sent = framesSentOn(inside, 'eth0');
    expect(probe(inside, NEIGHBOUR_IP)).toBe(false);
    expect(arpTargetsOf(sent)).toEqual([]);
    expect(await natCounter(inside, 'OUTPUT')).toBe(1);
  });

  it('DROP in the filter OUTPUT chain refuses it, and the rule counts it', async () => {
    const { inside } = await natGateway();
    await sudo(inside, `iptables -A OUTPUT -d ${NEIGHBOUR_IP} -p icmp -j DROP`);
    expect(probe(inside, NEIGHBOUR_IP)).toBe(false);
    expect(await filterCounter(inside, 'OUTPUT')).toBe(1);
  });
});

describe('a datagram addressed to a group is a local datagram too', () => {
  const GROUP = '224.0.0.251';
  const IGMP = 2;
  const sendToGroup = (host: NatGateway['inside']): boolean => host.sendUdpDatagram(new IPAddress(GROUP), 5353, 5353, null, 20);

  it('TEMOIN : with no rule the datagram leaves as a frame for the group', async () => {
    const { inside, neighbour } = await natGateway();
    const heard = framesReceivedOn(neighbour, 'eth0');
    expect(sendToGroup(inside)).toBe(true);
    const frame = heard.find((candidate) => candidate.etherType === ETHERTYPE_IPV4 && (candidate.payload as IPv4Packet).protocol === IP_PROTO_UDP);
    expect((frame!.payload as IPv4Packet).destinationIP.toString()).toBe(GROUP);
    expect(frame!.dstMAC.toString()).toBe('01:00:5e:00:00:fb');
  });

  it('DNAT in OUTPUT turns it into a unicast datagram for the host the rule names', async () => {
    const { inside, neighbour } = await natGateway();
    await nat(inside, `-A OUTPUT -d ${GROUP} -p udp -j DNAT --to-destination ${NEIGHBOUR_IP}`);
    const heard = framesReceivedOn(neighbour, 'eth0');
    expect(sendToGroup(inside)).toBe(true);
    const frame = heard.find((candidate) => candidate.etherType === ETHERTYPE_IPV4 && (candidate.payload as IPv4Packet).protocol === IP_PROTO_UDP);
    expect((frame!.payload as IPv4Packet).destinationIP.toString()).toBe(NEIGHBOUR_IP);
    expect(frame!.dstMAC.toString()).toBe(neighbour.getPort('eth0')!.getMAC().toString());
  });

  it('DROP in the nat OUTPUT chain refuses it, and the rule counts it', async () => {
    const { inside, neighbour } = await natGateway();
    await nat(inside, `-A OUTPUT -d ${GROUP} -p udp -j DROP`);
    const heard = framesReceivedOn(neighbour, 'eth0');
    expect(sendToGroup(inside)).toBe(false);
    expect(ofProtocol(heard, IP_PROTO_UDP)).toEqual([]);
    expect(await natCounter(inside, 'OUTPUT')).toBe(1);
  });

  it('a rule for another group leaves it alone', async () => {
    const { inside, neighbour } = await natGateway();
    await nat(inside, `-A OUTPUT -d 224.0.0.252 -p udp -j DROP`);
    const heard = framesReceivedOn(neighbour, 'eth0');
    expect(sendToGroup(inside)).toBe(true);
    expect(ofProtocol(heard, IP_PROTO_UDP)).toHaveLength(1);
  });

  it('TEMOIN : the membership report of a host that joins a group reaches the wire', async () => {
    const { inside, neighbour } = await natGateway();
    const heard = framesReceivedOn(neighbour, 'eth0');
    expect(inside.joinMulticastGroup('eth0', '239.1.2.3')).toBe(true);
    expect(ofProtocol(heard, IGMP)).toHaveLength(1);
  });

  it('a DROP of protocol 2 in OUTPUT keeps the membership report off the wire, and the rule counts it', async () => {
    const { inside, neighbour } = await natGateway();
    await sudo(inside, `iptables -A OUTPUT -p ${IGMP} -j DROP`);
    const heard = framesReceivedOn(neighbour, 'eth0');
    inside.joinMulticastGroup('eth0', '239.1.2.3');
    expect(ofProtocol(heard, IGMP)).toEqual([]);
    expect(await filterCounter(inside, 'OUTPUT')).toBe(1);
  });
});

describe('the datagram a protocol agent emits is a local datagram', () => {
  const tunnelledEcho = (): IPv4Packet => createIPv4Packet(
    new IPAddress('192.168.100.1'), new IPAddress('192.168.100.2'), IP_PROTO_ICMP, 64,
    { type: 'icmp', icmpType: 'echo-request', code: 0, id: 7, sequence: 1, dataSize: 8 } as ICMPPacket, 16);

  async function tunnel(lab: NatGateway): Promise<{ decapsulated: () => number }> {
    await sudo(lab.inside, `ip tunnel add gre0 mode gre remote ${NEIGHBOUR_IP} local ${INSIDE_IP}`);
    await sudo(lab.neighbour, `ip tunnel add gre0 mode gre remote ${INSIDE_IP} local ${NEIGHBOUR_IP}`);
    let seen = 0;
    lab.neighbour.getBus().subscribe('gre.packet.decapsulated', () => { seen++; });
    return { decapsulated: () => seen };
  }

  it('TEMOIN : the outer datagram of a GRE tunnel reaches the far end when no rule stops it', async () => {
    const lab = await natGateway();
    const far = await tunnel(lab);
    expect(lab.inside.getGreAgent().encapsulateAndSend('gre0', tunnelledEcho())).toBe(true);
    expect(far.decapsulated()).toBe(1);
  });

  it('a DROP of protocol 47 in OUTPUT stops the tunnel, and the rule counts the outer datagram', async () => {
    const lab = await natGateway();
    const far = await tunnel(lab);
    await sudo(lab.inside, `iptables -A OUTPUT -p ${GRE} -j DROP`);
    expect(lab.inside.getGreAgent().encapsulateAndSend('gre0', tunnelledEcho())).toBe(false);
    expect(far.decapsulated()).toBe(0);
    expect(await filterCounter(lab.inside, 'OUTPUT')).toBe(1);
  });

  it('a rule for another protocol leaves the tunnel alone', async () => {
    const lab = await natGateway();
    const far = await tunnel(lab);
    await sudo(lab.inside, 'iptables -A OUTPUT -p icmp -j DROP');
    expect(lab.inside.getGreAgent().encapsulateAndSend('gre0', tunnelledEcho())).toBe(true);
    expect(far.decapsulated()).toBe(1);
  });
});
