/**
 * ECN pour TCP (RFC 3168 §6.1) : la negociation sur le SYN, le marquage ECT(0)
 * des donnees neuves, l'echo des paquets CE, la reaction de l'emetteur — une
 * fois par fenetre — et les prises `net.ipv4.tcp_ecn` et
 * `net.ipv4.tcp_ecn_fallback`.
 *
 * Mesure de depart (commit precedent), pair SCRIPTE puis deux machines reelles
 * sur un cable :
 *
 *   - `sysctl net.ipv4.tcp_ecn` : « cannot stat /proc/sys/net/ipv4/tcp_ecn » ;
 *     la machine n'avait aucune politique ECN ;
 *   - un SYN ECE|CWR recevait un SYN-ACK ordinaire, et un client n'en
 *     emettait jamais ;
 *   - aucune donnee ne partait ECT(0) ; un segment CE n'etait ni acquitte tout
 *     de suite ni echo, l'ACK ne portait jamais ECE ; un ACK ECE faisait
 *     GRANDIR la fenetre de congestion (8 MSS, puis 9) au lieu de la
 *     reduire, et rien ne posait CWR ;
 *   - `nc -T 0x03` posait CE (`tos 0x3,CE`) sur chaque segment d'une
 *     connexion TCP ordinaire, ou un noyau Linux masque les bits ECN d'un
 *     IP_TOS de prise STREAM ;
 *   - `tcpdump -i lo` rendait `[S]` pour un SYN `[SEW]`, avec `win 0`, `id 0`,
 *     `flags [none]` et `tos 0x0` : un enregistrement synthetique plus pauvre
 *     que celui du fil, pour le meme segment ;
 *   - `tcpdump -v` n'imprimait aucun en-tete IPv6, donc ni classe de trafic ni
 *     limite de sauts.
 *
 * Autorite : RFC 3168 §6.1.1 (le SYN ECN-setup porte ECE et CWR, le SYN-ACK
 * ECN-setup ECE seul, aucun des deux n'est ECT), §6.1.1.1 (le SYN
 * retransmis peut repartir sans ECE ni CWR), §6.1.2 (donnees neuves ECT(0),
 * fenetre divisee par deux et ssthresh reduit, pas d'augmentation sur un ACK
 * ECE, une seule reduction par fenetre, CWR sur le premier segment neuf apres
 * toute reduction — RTO, retransmission rapide ou ECN —, jamais sur une
 * retransmission, fenetre d'un segment : temporisateur de retransmission
 * rearme et envoi suspendu jusqu'a son echeance), §6.1.3 (ECE sur chaque ACK
 * jusqu'au CWR), §6.1.4 (ACK purs non-ECT), §6.1.5 (retransmissions non-ECT,
 * CE hors fenetre ignore), §6.1.6 (sonde de fenetre nulle ni ECT ni CWR).
 * RFC 8311 n'est pas une autorite ici : il ouvre des EXPERIENCES (ECT sur SYN,
 * ACK purs, retransmissions) que ni 3168 ni Linux ne font. Linux 5.15, le
 * noyau d'Ubuntu 22.04 que `uname -r` annonce (source lue,
 * raw.githubusercontent.com) : `tcp_sk_init` (`sysctl_tcp_ecn = 2`),
 * `tcp_ecn_create_request` (le SYN ECE|CWR n'est accepte que si
 * `tcp_ecn` est non nul et que le SYN n'est pas ECT), `tcp_ecn_send_syn` (le
 * SYN demande ECN quand `tcp_ecn == 1`), `tcp_ecn_send_synack`,
 * `tcp_ecn_rcv_synack` (ECE sans CWR), `tcp_ecn_clear_syn` (la
 * retransmission du SYN perd ECE|CWR si `tcp_ecn_fallback`),
 * `__tcp_ecn_check_ce` et `tcp_ecn_accept_cwr` (ACK immediat sur un segment
 * CE ou porteur de CWR), `tcp_ecn_send` (ECT seulement sur une donnee neuve,
 * CWR en file), `tcp_try_to_open` et `tcp_enter_cwr` (la reaction a ECE, hors
 * des etats CWR, Recovery et Loss), `tcp_init_cwnd_reduction` et
 * `tcp_enter_loss` (CWR en file), `sysctl_net_ipv4.c` (`tcp_ecn` et
 * `tcp_ecn_fallback` sont des u8 lus par `proc_dou8vec_minmax` : 0 a 255, pas
 * de signe), `ip-sysctl.rst` (0 refuse tout, 1 demande et accepte, 2 accepte
 * seulement ; 2 par defaut). tcpdump 4.99.1, `print-ip6.c` : l'en-tete IPv6 de
 * `-v` (`class`, `flowlabel`, `hlim`, `next-header`, `payload length:`).
 *
 * Ce qui est construit : `TcpEcn` (module d'etat de la negociation, de l'echo
 * et de la reduction), la politique `TcpHost.ecnPolicy` et
 * `TcpHost.ecnFallback`, `EcnCodepoint` (le type du champ ECN de l'en-tete,
 * lu en IPv4 comme en IPv6 par chaque pile), `TcpCongestionControl.onCongestionEcho`,
 * l'evenement `tcp.ecn.reaction`, les prises `net.ipv4.tcp_ecn` (2 par defaut,
 * 1 demande, 0 refuse tout, tout octet non nul accepte) et
 * `net.ipv4.tcp_ecn_fallback`. Un poste Windows et les piles de gestion des
 * routeurs ne demandent ni n'acceptent ECN, comme leur configuration par
 * defaut. La capture du bouclage decode le paquet IP livre en memoire par
 * le meme decodeur que le fil (`tcp.segment.sent` le porte), `tcpdump -v`
 * imprime l'en-tete IPv6, et la table des noms ECN de `tcpdump` est celle
 * d'`EcnCodepoint`.
 *
 * Ce qui n'est PAS construit : AccECN et les extensions de RFC 8311, la
 * serie de deux ACK immediats de `tcp_enter_quickack_mode` (un seul ici), les
 * controles de congestion qui exigent ECN (`tcp_ca_needs_ecn`), le drapeau ECN
 * par route, et la prise Windows (`netsh int tcp set global ecncapability`,
 * `Set-NetTCPSetting`) : aucune de ces commandes n'existe dans le simulateur
 * et aucune disposition de sortie n'en est sourcable d'ici.
 *
 * Discrimination (fichier copie sur le commit precedent, avec l'aide
 * `tcpScriptedPeer.ts` et le type `EcnCodepoint`) : QUARANTE-SEPT cas sur
 * soixante et un tombent. Les QUATORZE autres passent des deux cotes : huit
 * NON-REGRESSIONS d'une machine qui ne negocie pas (le SYN ECE seul, CWR seul
 * ou nu n'ouvre pas ECN, le SYN-ACK sans ECE ou a deux drapeaux ne l'ouvre
 * pas, la donnee n'est jamais marquee, le CE et l'ECE sont ignores sans
 * negociation) ; trois REFUS dont le temoin est le cas positif du meme
 * laboratoire, qui tombe (`tcp_ecn=0`, le SYN deja ECT, le poste Windows) ;
 * trois TEMOINS (le defaut 2 ne demande pas ECN, deux machines par defaut ne
 * negocient pas, l'ECE d'un SYN-ACK n'est pas un signal de congestion : aucune
 * reaction, fenetre initiale intacte).
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import {
  scriptedPeer, openPassive, openActive, lettersOf, PEER_ISN, type ScriptedPeer, type OpenConnection,
} from '../../support/tcpScriptedPeer';
import { EcnCodepoint } from '@/network/core/IpHeaderFields';
import { payloadBytes } from '@/network/layers/transport/L4Checksum';
import type { TcpOption, TcpSegment } from '@/network/tcp/types';
import type { TcpSocket } from '@/network/tcp/TcpStack';

const MSS = 1460;
const MSS_OFFER: TcpOption[] = [{ kind: 'mss', value: MSS }];

async function setting(peer: ScriptedPeer, value: number | string): Promise<void> {
  await peer.dut.executeCommand(`sudo sysctl -w net.ipv4.tcp_ecn=${value}`);
}

function listen(peer: ScriptedPeer): void {
  peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: () => undefined });
}

function sizeOf(segment: TcpSegment): number {
  return payloadBytes(segment.payload).length;
}

function dataSegments(peer: ScriptedPeer): TcpSegment[] {
  return peer.replies.filter((segment) => sizeOf(segment) > 0);
}

function negotiatedPassive(peer: ScriptedPeer): OpenConnection {
  return openPassive(peer, MSS_OFFER, PEER_ISN, 65535, {}, 'SEC');
}

async function negotiatedActive(peer: ScriptedPeer): Promise<OpenConnection> {
  await setting(peer, 1);
  return openActive(peer, MSS_OFFER, PEER_ISN, 65535, {}, 'SAE');
}

function peerData(
  peer: ScriptedPeer, connection: OpenConnection, offset: number, length: number,
  ecn: EcnCodepoint = EcnCodepoint.NOT_ECT, flags = 'PA',
): void {
  peer.send({
    flags, sequence: connection.peerIsn + 1 + offset, acknowledgement: connection.dutIsn + 1,
    payload: 'x'.repeat(length), ecn,
  });
}

function acknowledge(peer: ScriptedPeer, connection: OpenConnection, upTo: number, flags = 'A'): void {
  peer.send({
    flags, sequence: connection.peerIsn + 1, acknowledgement: connection.dutIsn + 1 + upTo,
  });
}

function sentSoFar(connection: OpenConnection): number {
  return (connection.socket.sendNext - connection.dutIsn - 1) >>> 0;
}

function grow(peer: ScriptedPeer, connection: OpenConnection, rounds: number): void {
  connection.socket.write('x'.repeat(200 * MSS));
  for (let round = 0; round < rounds; round++) {
    acknowledge(peer, connection, sentSoFar(connection));
  }
}

function listenCapturing(peer: ScriptedPeer): TcpSocket[] {
  const accepted: TcpSocket[] = [];
  peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: (socket) => { accepted.push(socket); } });
  return accepted;
}

function reactionsOn(peer: ScriptedPeer): number[] {
  const seen: number[] = [];
  peer.bus.subscribe('tcp.ecn.reaction', (event) => { seen.push(event.payload.congestionWindow); });
  return seen;
}

function retransmissionsOn(peer: ScriptedPeer): number[] {
  const seen: number[] = [];
  peer.bus.subscribe('tcp.retransmit', (event) => { seen.push(event.payload.sequence); });
  return seen;
}

describe('a listener negotiates ECN from the SYN it receives (RFC 3168 §6.1.1)', () => {
  it('answers an ECN-setup SYN with an ECN-setup SYN-ACK: ECE without CWR', () => {
    const peer = scriptedPeer();
    listen(peer);
    peer.send({ flags: 'SEC', sequence: PEER_ISN });
    expect(lettersOf(peer.last()!.flags)).toBe('SAE');
  });

  it('never marks the SYN-ACK ECT, whatever it negotiates', () => {
    const peer = scriptedPeer();
    listen(peer);
    peer.send({ flags: 'SEC', sequence: PEER_ISN });
    expect(lettersOf(peer.last()!.flags)).toBe('SAE');
    expect(peer.ecnOf(peer.last()!)).toBe(EcnCodepoint.NOT_ECT);
  });

  it.each(['SE', 'SC', 'S'])('a SYN %s is not an ECN-setup SYN: the SYN-ACK carries neither flag', (flags) => {
    const peer = scriptedPeer();
    listen(peer);
    peer.send({ flags, sequence: PEER_ISN });
    expect(lettersOf(peer.last()!.flags)).toBe('SA');
  });

  it('net.ipv4.tcp_ecn=0 neither initiates nor accepts ECN', async () => {
    const peer = scriptedPeer();
    await setting(peer, 0);
    listen(peer);
    peer.send({ flags: 'SEC', sequence: PEER_ISN });
    expect(lettersOf(peer.last()!.flags)).toBe('SA');
  });

  it('any non-zero net.ipv4.tcp_ecn accepts ECN requested by an incoming connection', async () => {
    const peer = scriptedPeer();
    await setting(peer, 7);
    listen(peer);
    peer.send({ flags: 'SEC', sequence: PEER_ISN });
    expect(lettersOf(peer.last()!.flags)).toBe('SAE');
  });

  it('refuses an ECN-setup SYN whose IP header already carries ECT', () => {
    const peer = scriptedPeer();
    listen(peer);
    peer.send({ flags: 'SEC', sequence: PEER_ISN, ecn: EcnCodepoint.ECT_0 });
    expect(lettersOf(peer.last()!.flags)).toBe('SA');
  });

  it('a Windows machine, ECN disabled by default, answers an ECN-setup SYN without ECE', () => {
    const peer = scriptedPeer('windows');
    listen(peer);
    peer.send({ flags: 'SEC', sequence: PEER_ISN });
    expect(lettersOf(peer.last()!.flags)).toBe('SA');
  });

  it('negotiates over IPv6 the same way', () => {
    const peer = scriptedPeer('linux', 'ipv6');
    listen(peer);
    peer.send({ flags: 'SEC', sequence: PEER_ISN });
    expect(lettersOf(peer.last()!.flags)).toBe('SAE');
  });
});

describe('a client asks for ECN only when the machine says so (RFC 3168 §6.1.1)', () => {
  it('net.ipv4.tcp_ecn=1 sends an ECN-setup SYN, never marked ECT', async () => {
    const peer = scriptedPeer();
    await setting(peer, 1);
    peer.dut.getTcpStack().connect(peer.addresses.peer, peer.ports.peer);
    expect(lettersOf(peer.last()!.flags)).toBe('SEC');
    expect(peer.ecnOf(peer.last()!)).toBe(EcnCodepoint.NOT_ECT);
  });

  it('the default net.ipv4.tcp_ecn=2 accepts but does not request', () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().connect(peer.addresses.peer, peer.ports.peer);
    expect(lettersOf(peer.last()!.flags)).toBe('S');
  });

  it('asks over IPv6 the same way', async () => {
    const peer = scriptedPeer('linux', 'ipv6');
    await setting(peer, 1);
    peer.dut.getTcpStack().connect(peer.addresses.peer, peer.ports.peer);
    expect(lettersOf(peer.last()!.flags)).toBe('SEC');
  });

  it('an ECN-setup SYN-ACK turns ECN on: the next new data is ECT(0)', async () => {
    const peer = scriptedPeer();
    const connection = await negotiatedActive(peer);
    connection.socket.write('hello');
    expect(dataSegments(peer).map((segment) => peer.ecnOf(segment))).toEqual([EcnCodepoint.ECT_0]);
  });

  it('a SYN-ACK that echoes both flags is not an ECN-setup SYN-ACK', async () => {
    const peer = scriptedPeer();
    await setting(peer, 1);
    const connection = openActive(peer, MSS_OFFER, PEER_ISN, 65535, {}, 'SAEC');
    connection.socket.write('hello');
    expect(dataSegments(peer).map((segment) => peer.ecnOf(segment))).toEqual([EcnCodepoint.NOT_ECT]);
  });

  it('a SYN-ACK without ECE leaves ECN off', async () => {
    const peer = scriptedPeer();
    await setting(peer, 1);
    const connection = openActive(peer, MSS_OFFER);
    connection.socket.write('hello');
    expect(dataSegments(peer).map((segment) => peer.ecnOf(segment))).toEqual([EcnCodepoint.NOT_ECT]);
  });

  it('the first SYN retransmission is a plain SYN (RFC 3168 §6.1.1.1)', async () => {
    const peer = scriptedPeer();
    await setting(peer, 1);
    peer.dut.getTcpStack().connect(peer.addresses.peer, peer.ports.peer);
    expect(lettersOf(peer.last()!.flags)).toBe('SEC');
    peer.clear();
    peer.advance(1500);
    expect(lettersOf(peer.last()!.flags)).toBe('S');
  });

  it('net.ipv4.tcp_ecn_fallback=0 keeps ECE and CWR on every SYN retransmission', async () => {
    const peer = scriptedPeer();
    await setting(peer, 1);
    await peer.dut.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn_fallback=0');
    peer.dut.getTcpStack().connect(peer.addresses.peer, peer.ports.peer);
    peer.clear();
    peer.advance(1500);
    expect(lettersOf(peer.last()!.flags)).toBe('SEC');
  });

  it('after that fallback an ECE in the SYN-ACK does not turn ECN on', async () => {
    const peer = scriptedPeer();
    await setting(peer, 1);
    peer.dut.getTcpStack().connect(peer.addresses.peer, peer.ports.peer);
    expect(lettersOf(peer.last()!.flags)).toBe('SEC');
    peer.advance(1500);
    const syn = peer.last()!;
    peer.ports.dut = syn.sourcePort;
    peer.send({ flags: 'SAE', sequence: PEER_ISN, acknowledgement: syn.sequence + 1, options: MSS_OFFER });
    const socket = peer.dut.getTcpStack().listSockets()[0];
    peer.clear();
    socket.write('hello');
    expect(dataSegments(peer).map((segment) => peer.ecnOf(segment))).toEqual([EcnCodepoint.NOT_ECT]);
  });
});

describe('an ECN-capable sender marks new data only (RFC 3168 §6.1.2, §6.1.4, §6.1.5, §6.1.6)', () => {
  it('marks a new data segment ECT(0)', () => {
    const peer = scriptedPeer();
    const connection = negotiatedPassive(peer);
    connection.socket.write('hello');
    expect(dataSegments(peer).map((segment) => peer.ecnOf(segment))).toEqual([EcnCodepoint.ECT_0]);
  });

  it('marks it over IPv6 through the traffic class', () => {
    const peer = scriptedPeer('linux', 'ipv6');
    const connection = negotiatedPassive(peer);
    connection.socket.write('hello');
    expect(dataSegments(peer).map((segment) => peer.ecnOf(segment))).toEqual([EcnCodepoint.ECT_0]);
  });

  it('leaves pure ACKs and the FIN not-ECT while its data is ECT(0)', () => {
    const peer = scriptedPeer();
    const connection = negotiatedPassive(peer);
    connection.socket.write('hello');
    acknowledge(peer, connection, 5);
    peerData(peer, connection, 0, 100);
    peer.advance(300);
    connection.socket.close();
    const data = dataSegments(peer);
    const control = peer.replies.filter((segment) => sizeOf(segment) === 0);
    expect(data.map((segment) => peer.ecnOf(segment))).toEqual([EcnCodepoint.ECT_0]);
    expect(control.some((segment) => segment.flags.fin)).toBe(true);
    expect(control.some((segment) => !segment.flags.fin)).toBe(true);
    expect(control.every((segment) => peer.ecnOf(segment) === EcnCodepoint.NOT_ECT)).toBe(true);
  });

  it('never marks a retransmission', () => {
    const peer = scriptedPeer();
    const connection = negotiatedPassive(peer);
    connection.socket.write('hello');
    const first = dataSegments(peer)[0];
    expect(peer.ecnOf(first)).toBe(EcnCodepoint.ECT_0);
    peer.clear();
    peer.advance(250);
    const again = dataSegments(peer);
    expect(again).toHaveLength(1);
    expect(again[0].sequence).toBe(first.sequence);
    expect(peer.ecnOf(again[0])).toBe(EcnCodepoint.NOT_ECT);
  });

  it('sends a zero-window probe neither ECT nor CWR, and marks the data once the window opens', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, MSS_OFFER, PEER_ISN, 0, {}, 'SEC');
    connection.socket.write('hello');
    expect(dataSegments(peer)).toHaveLength(0);
    peer.advance(250);
    const probe = dataSegments(peer);
    expect(probe).toHaveLength(1);
    expect(sizeOf(probe[0])).toBe(1);
    expect(peer.ecnOf(probe[0])).toBe(EcnCodepoint.NOT_ECT);
    expect(probe[0].flags.cwr).toBe(false);
    peer.clear();
    peer.send({
      flags: 'A', sequence: connection.peerIsn + 1, acknowledgement: probe[0].sequence + 1, window: 65535,
    });
    expect(dataSegments(peer).map((segment) => peer.ecnOf(segment))).toEqual([EcnCodepoint.ECT_0]);
  });

  it('does not mark data at all when ECN was not negotiated', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, MSS_OFFER);
    connection.socket.write('hello');
    expect(dataSegments(peer).map((segment) => peer.ecnOf(segment))).toEqual([EcnCodepoint.NOT_ECT]);
  });
});

describe('an ECN-capable receiver echoes congestion (RFC 3168 §6.1.3, §6.1.5)', () => {
  it('acknowledges a CE data segment at once, with ECE', () => {
    const peer = scriptedPeer();
    const connection = negotiatedPassive(peer);
    peerData(peer, connection, 0, 100, EcnCodepoint.CE);
    expect(peer.replies.map((segment) => lettersOf(segment.flags))).toEqual(['AE']);
    expect(peer.ecnOf(peer.last()!)).toBe(EcnCodepoint.NOT_ECT);
  });

  it('repeats ECE on every ACK until a CWR arrives, then stops', () => {
    const peer = scriptedPeer();
    const connection = negotiatedPassive(peer);
    peerData(peer, connection, 0, 100, EcnCodepoint.CE);
    expect(lettersOf(peer.last()!.flags)).toBe('AE');
    peer.clear();
    peerData(peer, connection, 100, 100);
    peer.advance(300);
    expect(peer.replies.map((segment) => lettersOf(segment.flags))).toEqual(['AE']);
    peer.clear();
    peerData(peer, connection, 200, 100, EcnCodepoint.ECT_0, 'PAC');
    expect(peer.replies.map((segment) => lettersOf(segment.flags))).toEqual(['A']);
    peer.clear();
    peerData(peer, connection, 300, 100);
    peer.advance(300);
    expect(peer.replies.map((segment) => lettersOf(segment.flags))).toEqual(['A']);
  });

  it('a delayed ACK that covers a plain segment and a CE one carries ECE', () => {
    const peer = scriptedPeer();
    const connection = negotiatedPassive(peer);
    peerData(peer, connection, 0, 100);
    expect(peer.replies).toHaveLength(0);
    peerData(peer, connection, 100, 100, EcnCodepoint.CE);
    expect(peer.replies).toHaveLength(1);
    expect(lettersOf(peer.last()!.flags)).toBe('AE');
    expect(peer.last()!.acknowledgement).toBe(connection.peerIsn + 1 + 200);
  });

  it('ignores CE on a segment outside the window, then honours it inside', () => {
    const peer = scriptedPeer();
    const connection = negotiatedPassive(peer);
    peerData(peer, connection, 200000, 100, EcnCodepoint.CE);
    expect(peer.replies.map((segment) => lettersOf(segment.flags))).toEqual(['A']);
    peer.clear();
    peerData(peer, connection, 0, 100, EcnCodepoint.CE);
    expect(peer.replies.map((segment) => lettersOf(segment.flags))).toEqual(['AE']);
  });

  it('ignores CE on a duplicate of data it already holds, then honours it on new data', () => {
    const peer = scriptedPeer();
    const connection = negotiatedPassive(peer);
    peerData(peer, connection, 0, 100);
    peer.advance(300);
    peer.clear();
    peerData(peer, connection, 0, 100, EcnCodepoint.CE);
    expect(peer.replies.map((segment) => lettersOf(segment.flags))).toEqual(['A']);
    peer.clear();
    peerData(peer, connection, 100, 100, EcnCodepoint.CE);
    expect(peer.replies.map((segment) => lettersOf(segment.flags))).toEqual(['AE']);
  });

  it('ignores CE when ECN was not negotiated', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, MSS_OFFER);
    peerData(peer, connection, 0, 100, EcnCodepoint.CE);
    peer.advance(300);
    expect(peer.replies.map((segment) => lettersOf(segment.flags))).toEqual(['A']);
  });

  it('echoes CE read from the IPv6 traffic class', () => {
    const peer = scriptedPeer('linux', 'ipv6');
    const connection = negotiatedPassive(peer);
    peerData(peer, connection, 0, 100, EcnCodepoint.CE);
    expect(peer.replies.map((segment) => lettersOf(segment.flags))).toEqual(['AE']);
  });
});

describe('an ECN-capable sender answers ECE as to a loss, once per window (RFC 3168 §6.1.2)', () => {
  it('halves the congestion window and ssthresh, and does not grow the window on that ACK', () => {
    const peer = scriptedPeer();
    const connection = negotiatedPassive(peer);
    grow(peer, connection, 5);
    const socket = connection.socket;
    expect(socket.cc.cwnd).toBe(8 * MSS);
    acknowledge(peer, connection, sentSoFar(connection) - 7 * MSS, 'AE');
    expect(socket.cc.cwnd).toBe(4 * MSS);
    expect(socket.cc.ssthresh).toBe(4 * MSS);
  });

  it('publishes one reaction and retransmits nothing', () => {
    const peer = scriptedPeer();
    const connection = negotiatedPassive(peer);
    grow(peer, connection, 5);
    const reactions = reactionsOn(peer);
    const retransmissions = retransmissionsOn(peer);
    acknowledge(peer, connection, sentSoFar(connection) - 7 * MSS, 'AE');
    expect(reactions).toEqual([4 * MSS]);
    expect(retransmissions).toEqual([]);
  });

  it('puts CWR on the first new data after the reduction and on no other', () => {
    const peer = scriptedPeer();
    const connection = negotiatedPassive(peer);
    grow(peer, connection, 5);
    acknowledge(peer, connection, sentSoFar(connection) - 7 * MSS, 'AE');
    peer.clear();
    acknowledge(peer, connection, sentSoFar(connection));
    const fresh = dataSegments(peer);
    expect(fresh.length).toBeGreaterThan(1);
    expect(fresh[0].flags.cwr).toBe(true);
    expect(fresh.slice(1).some((segment) => segment.flags.cwr)).toBe(false);
    expect(fresh.every((segment) => peer.ecnOf(segment) === EcnCodepoint.ECT_0)).toBe(true);
  });

  it('never puts CWR on a retransmission', () => {
    const peer = scriptedPeer();
    const connection = negotiatedPassive(peer);
    grow(peer, connection, 5);
    acknowledge(peer, connection, sentSoFar(connection) - 7 * MSS, 'AE');
    expect(connection.socket.cc.cwnd).toBe(4 * MSS);
    peer.clear();
    peer.advance(250);
    const again = dataSegments(peer);
    expect(again).toHaveLength(1);
    expect(again[0].flags.cwr).toBe(false);
    expect(peer.ecnOf(again[0])).toBe(EcnCodepoint.NOT_ECT);
  });

  it('reduces once per window: a second ECE inside the same window changes nothing', () => {
    const peer = scriptedPeer();
    const connection = negotiatedPassive(peer);
    grow(peer, connection, 5);
    const reactions = reactionsOn(peer);
    const base = sentSoFar(connection) - 8 * MSS;
    acknowledge(peer, connection, base + MSS, 'AE');
    acknowledge(peer, connection, base + 2 * MSS, 'AE');
    expect(reactions).toEqual([4 * MSS]);
    expect(connection.socket.cc.cwnd).toBe(4 * MSS);
  });

  it('reacts again to an ECE that answers data sent after the reduction', () => {
    const peer = scriptedPeer();
    const connection = negotiatedPassive(peer);
    grow(peer, connection, 5);
    const reactions = reactionsOn(peer);
    const windowEnd = sentSoFar(connection);
    acknowledge(peer, connection, windowEnd - 7 * MSS, 'AE');
    acknowledge(peer, connection, windowEnd);
    expect(sentSoFar(connection)).toBeGreaterThan(windowEnd);
    acknowledge(peer, connection, windowEnd + MSS, 'AE');
    expect(reactions).toHaveLength(2);
    expect(connection.socket.cc.cwnd).toBeLessThan(4 * MSS);
  });

  it('ignores ECE on a connection that did not negotiate ECN', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, MSS_OFFER);
    grow(peer, connection, 5);
    const reactions = reactionsOn(peer);
    acknowledge(peer, connection, sentSoFar(connection) - 7 * MSS, 'AE');
    expect(reactions).toEqual([]);
    expect(connection.socket.cc.cwnd).toBeGreaterThan(8 * MSS);
  });

  it('treats the ECE of the SYN-ACK as negotiation, not as congestion', async () => {
    const peer = scriptedPeer();
    const reactions = reactionsOn(peer);
    const connection = await negotiatedActive(peer);
    expect(reactions).toEqual([]);
    expect(connection.socket.cc.cwnd).toBe(3 * MSS);
  });

  it('a retransmission timeout queues CWR for the first new data', () => {
    const peer = scriptedPeer();
    const connection = negotiatedPassive(peer);
    connection.socket.write('hello');
    peer.clear();
    peer.advance(1500);
    acknowledge(peer, connection, 5);
    peer.clear();
    connection.socket.write('world');
    const fresh = dataSegments(peer);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].flags.cwr).toBe(true);
    expect(peer.ecnOf(fresh[0])).toBe(EcnCodepoint.ECT_0);
  });

  it('a fast retransmit queues CWR for the first new data', () => {
    const peer = scriptedPeer();
    const connection = negotiatedPassive(peer);
    connection.socket.write('x'.repeat(10 * MSS));
    expect(dataSegments(peer)).toHaveLength(3);
    for (let duplicate = 0; duplicate < 3; duplicate++) acknowledge(peer, connection, 0);
    peer.clear();
    acknowledge(peer, connection, sentSoFar(connection));
    const fresh = dataSegments(peer);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh[0].flags.cwr).toBe(true);
    expect(fresh.slice(1).some((segment) => segment.flags.cwr)).toBe(false);
  });

  it('holds new data for one retransmission timeout when the window is one segment', () => {
    const peer = scriptedPeer();
    const accepted = listenCapturing(peer);
    peer.send({ flags: 'SEC', sequence: PEER_ISN, options: MSS_OFFER });
    const synAck = peer.last()!;
    peer.advance(1500);
    expect(lettersOf(peer.last()!.flags)).toBe('SAE');
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: synAck.sequence + 1 });
    const socket = accepted[0];
    const connection = { socket, dutIsn: synAck.sequence, peerIsn: PEER_ISN };
    peer.clear();
    socket.write('x'.repeat(4 * MSS));
    expect(dataSegments(peer)).toHaveLength(1);
    expect(socket.cc.cwnd).toBe(MSS);
    const rto = socket.rtt.currentRto();
    peer.clear();
    acknowledge(peer, connection, MSS, 'AE');
    expect(dataSegments(peer)).toHaveLength(0);
    peer.advance(rto - 1);
    expect(dataSegments(peer)).toHaveLength(0);
    peer.advance(2);
    const released = dataSegments(peer);
    expect(released).toHaveLength(1);
    expect(released[0].flags.cwr).toBe(true);
  });
});

describe('net.ipv4.tcp_ecn is the Linux knob (kernel 5.15, ip-sysctl.rst)', () => {
  it('reads 2 by default, through sysctl and through /proc', async () => {
    const peer = scriptedPeer();
    expect((await peer.dut.executeCommand('sysctl net.ipv4.tcp_ecn')).trim()).toBe('net.ipv4.tcp_ecn = 2');
    expect((await peer.dut.executeCommand('cat /proc/sys/net/ipv4/tcp_ecn')).trim()).toBe('2');
  });

  it('reads back what sysctl -w wrote', async () => {
    const peer = scriptedPeer();
    expect((await peer.dut.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn=1')).trim())
      .toBe('net.ipv4.tcp_ecn = 1');
    expect((await peer.dut.executeCommand('cat /proc/sys/net/ipv4/tcp_ecn')).trim()).toBe('1');
  });

  it.each(['maybe', '-1', '256', '1.5'])('refuses %s, which a byte cannot hold, and keeps the old value', async (value) => {
    const peer = scriptedPeer();
    expect(await peer.dut.executeCommand(`sudo sysctl -w net.ipv4.tcp_ecn=${value}`)).toContain('Invalid argument');
    expect((await peer.dut.executeCommand('sysctl -n net.ipv4.tcp_ecn')).trim()).toBe('2');
  });

  it('accepts the whole byte range: 255 still accepts an incoming request', async () => {
    const peer = scriptedPeer();
    await setting(peer, 255);
    expect((await peer.dut.executeCommand('sysctl -n net.ipv4.tcp_ecn')).trim()).toBe('255');
    listen(peer);
    peer.send({ flags: 'SEC', sequence: PEER_ISN });
    expect(lettersOf(peer.last()!.flags)).toBe('SAE');
  });

  it('net.ipv4.tcp_ecn_fallback reads 1 by default, accepts a byte and refuses the rest', async () => {
    const peer = scriptedPeer();
    expect((await peer.dut.executeCommand('sysctl -n net.ipv4.tcp_ecn_fallback')).trim()).toBe('1');
    await peer.dut.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn_fallback=0');
    expect((await peer.dut.executeCommand('cat /proc/sys/net/ipv4/tcp_ecn_fallback')).trim()).toBe('0');
    expect(await peer.dut.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn_fallback=256')).toContain('Invalid argument');
    expect((await peer.dut.executeCommand('sysctl -n net.ipv4.tcp_ecn_fallback')).trim()).toBe('0');
  });
});

async function twoMachines(): Promise<{ client: LinuxPC; server: LinuxServer }> {
  const server = new LinuxServer('linux-server', 'srv', 0, 0);
  const client = new LinuxPC('linux-pc', 'cli', 0, 0);
  server.powerOn();
  client.powerOn();
  new Cable('wire').connect(server.getPort('eth0')!, client.getPort('eth0')!);
  await server.executeCommand('ifconfig eth0 192.168.1.1 netmask 255.255.255.0');
  await client.executeCommand('ifconfig eth0 192.168.1.2 netmask 255.255.255.0');
  return { client, server };
}

async function bannerCapture(client: LinuxPC, iface: string, target: string): Promise<string> {
  const pending = client.executeCommand(`sudo tcpdump -n -v -i ${iface} -c 6 port 22`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await client.executeCommand(`nc -w 1 ${target} 22`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return pending;
}

function lineOf(capture: string, flags: string, source: 'client' | 'server'): string | undefined {
  const origin = source === 'client' ? '192\\.168\\.1\\.2\\.\\d+ > 192\\.168\\.1\\.1\\.22' : '192\\.168\\.1\\.1\\.22 > 192\\.168\\.1\\.2\\.\\d+';
  const pattern = new RegExp(`IP \\((.*)\\)\\n\\s+${origin}: Flags \\[${flags}\\]`);
  return pattern.exec(capture)?.[1];
}

describe('two machines negotiate ECN through real frames, and tcpdump shows it', () => {
  it('a client with tcp_ecn=1 and a default server: [SEW], [S.E], then ECT(0) data', async () => {
    const { client } = await twoMachines();
    await client.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn=1');
    const capture = await bannerCapture(client, 'eth0', '192.168.1.1');
    expect(lineOf(capture, 'SEW', 'client')).toMatch(/^tos 0x0, /);
    expect(lineOf(capture, 'S\\.E', 'server')).toMatch(/^tos 0x0, /);
    expect(lineOf(capture, 'P\\.', 'server')).toMatch(/^tos 0x2,ECT\(0\), /);
  });

  it('two default machines never negotiate: the knob alone decides', async () => {
    const { client } = await twoMachines();
    const capture = await bannerCapture(client, 'eth0', '192.168.1.1');
    expect(lineOf(capture, 'S', 'client')).toMatch(/^tos 0x0, /);
    expect(lineOf(capture, 'S\\.', 'server')).toMatch(/^tos 0x0, /);
    expect(lineOf(capture, 'P\\.', 'server')).toMatch(/^tos 0x0, /);
    expect(capture).not.toMatch(/ECT|Flags \[[A-Z.]*[EW]\]/);
  });

  it('a server with tcp_ecn=0 refuses: the SYN-ACK carries no ECE and the data no ECT', async () => {
    const { client, server } = await twoMachines();
    await server.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn=0');
    await client.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn=1');
    const capture = await bannerCapture(client, 'eth0', '192.168.1.1');
    expect(lineOf(capture, 'SEW', 'client')).toMatch(/^tos 0x0, /);
    expect(lineOf(capture, 'S\\.', 'server')).toMatch(/^tos 0x0, /);
    expect(capture).not.toMatch(/ECT/);
  });

  it.each([['0xba', '0xb8'], ['0x03', '0x0']])(
    'nc -T %s on a TCP socket keeps the DSCP and never the ECN bits: the wire carries tos %s', async (asked, wire) => {
      const { client } = await twoMachines();
      const pending = client.executeCommand('sudo tcpdump -n -v -i eth0 -c 4 port 22');
      await new Promise((resolve) => setTimeout(resolve, 20));
      await client.executeCommand(`nc -T ${asked} -w 1 192.168.1.1 22`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const capture = await pending;
      expect(lineOf(capture, 'S', 'client')).toMatch(new RegExp(`^tos ${wire}, `));
    });

  it('nc -T 0xb8 on an ECN-capable connection: the stack adds ECT(0) to the DSCP of its data', async () => {
    const { client } = await twoMachines();
    await client.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn=1');
    const pending = client.executeCommand('sudo tcpdump -n -v -i eth0 -c 8 port 22');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.executeCommand("printf 'SSH-2.0-probe\\r\\n' | nc -T 0xb8 -w 1 192.168.1.1 22");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const capture = await pending;
    expect(lineOf(capture, 'SEW', 'client')).toMatch(/^tos 0xb8, /);
    expect(lineOf(capture, 'P\\.', 'client')).toMatch(/^tos 0xba,ECT\(0\), /);
  });

  it('over IPv6, tcpdump -v prints the traffic class: class 0x02 on ECT(0) data, none on the rest', async () => {
    const { client, server } = await twoMachines();
    await server.executeCommand('ip -6 addr add fd00::1/64 dev eth0');
    await client.executeCommand('ip -6 addr add fd00::2/64 dev eth0');
    await client.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn=1');
    const pending = client.executeCommand('sudo tcpdump -n -v -i eth0 -c 6 port 22');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.executeCommand('nc -w 1 fd00::1 22');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const capture = await pending;
    expect(capture).toMatch(/IP6 \(hlim 64, next-header TCP \(6\) payload length: 40\) fd00::2\.\d+ > fd00::1\.22: Flags \[SEW\]/);
    expect(capture).toMatch(/IP6 \(hlim 64, next-header TCP \(6\) payload length: 40\) fd00::1\.22 > fd00::2\.\d+: Flags \[S\.E\]/);
    expect(capture).toMatch(/IP6 \(class 0x02, hlim 64, next-header TCP \(6\) payload length: 73\) fd00::1\.22 > fd00::2\.\d+: Flags \[P\.\]/);
  });

  it('the loopback capture shows the same flags and the same ECT(0) as a wire does', async () => {
    const { server } = await twoMachines();
    await server.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn=1');
    const pending = server.executeCommand('sudo tcpdump -n -v -i lo -c 6 port 22');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await server.executeCommand('nc -w 1 127.0.0.1 22');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const capture = await pending;
    expect(capture).toMatch(/Flags \[SEW\]/);
    expect(capture).toMatch(/Flags \[S\.E\]/);
    expect(capture).toMatch(/tos 0x2,ECT\(0\)[^\n]*\n\s+127\.0\.0\.1\.22 > 127\.0\.0\.1\.\d+: Flags \[P\.\]/);
  });
});

async function run(device: { executeCommand(command: string): Promise<string> }, commands: string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

describe('a router forwards the ECN field of a TCP segment untouched', () => {
  it('through two Cisco routers: the SYN keeps its flags and the banner arrives ECT(0)', async () => {
    const r1 = new CiscoRouter('R1', 0, 0);
    const r2 = new CiscoRouter('R2', 200, 0);
    const client = new LinuxPC('linux-pc', 'H1', -100, 0);
    const server = new LinuxServer('linux-server', 'H2', 300, 0);
    new Cable('a').connect(client.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    new Cable('b').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    new Cable('c').connect(r2.getPort('GigabitEthernet0/0')!, server.getPort('eth0')!);
    await run(r1, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.12.12.1 255.255.255.252', 'no shutdown', 'exit',
      'ip route 10.0.2.0 255.255.255.0 10.12.12.2', 'end']);
    await run(r2, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.12.12.2 255.255.255.252', 'no shutdown', 'exit',
      'ip route 10.0.1.0 255.255.255.0 10.12.12.1', 'end']);
    await run(client, ['ip link set eth0 up', 'ip addr add 10.0.1.10/24 dev eth0', 'ip route add default via 10.0.1.1']);
    await run(server, ['ip link set eth0 up', 'ip addr add 10.0.2.10/24 dev eth0', 'ip route add default via 10.0.2.1']);
    await client.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn=1');
    const pending = client.executeCommand('sudo tcpdump -n -v -i eth0 -c 6 port 22');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.executeCommand('nc -w 1 10.0.2.10 22');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const capture = await pending;
    expect(capture).toMatch(/Flags \[S\.E\]/);
    expect(capture).toMatch(/tos 0x2,ECT\(0\), ttl 62[^\n]*\n\s+10\.0\.2\.10\.22 > 10\.0\.1\.10\.\d+: Flags \[P\.\]/);
  });

  it('through a Linux router with ip_forward: the same banner arrives ECT(0)', async () => {
    const client = new LinuxPC('linux-pc', 'PC1');
    const gateway = new LinuxPC('linux-pc', 'GW');
    const server = new LinuxServer('linux-server', 'PC2', 0, 0);
    new Cable('pc1-gw').connect(client.getPort('eth0')!, gateway.getPort('eth0')!);
    new Cable('gw-pc2').connect(gateway.getPort('eth1')!, server.getPort('eth0')!);
    await run(client, ['ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1']);
    await run(gateway, ['ip addr add 192.168.1.1/24 dev eth0', 'ip addr add 10.0.0.1/24 dev eth1',
      'sudo sysctl -w net.ipv4.ip_forward=1']);
    await run(server, ['ip addr add 10.0.0.2/24 dev eth0', 'ip route add default via 10.0.0.1']);
    await client.executeCommand('sudo sysctl -w net.ipv4.tcp_ecn=1');
    const pending = client.executeCommand('sudo tcpdump -n -v -i eth0 -c 6 port 22');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.executeCommand('nc -w 1 10.0.0.2 22');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const capture = await pending;
    expect(capture).toMatch(/Flags \[S\.E\]/);
    expect(capture).toMatch(/tos 0x2,ECT\(0\), ttl 63[^\n]*\n\s+10\.0\.0\.2\.22 > 192\.168\.1\.10\.\d+: Flags \[P\.\]/);
  });
});
