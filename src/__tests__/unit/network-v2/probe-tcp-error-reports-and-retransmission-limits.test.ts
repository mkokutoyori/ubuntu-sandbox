/**
 * Une erreur ICMP atteint la connexion selon ce qu'elle dit, l'application en
 * est informee, et la retransmission renonce sur des seuils mesures en temps
 * que l'application regle.
 *
 * Mesure de depart (commit precedent), pair SCRIPTE qui injecte des erreurs ICMP
 * portant le segment fautif :
 *
 *   - « protocol unreachable » (code 2) laissait la connexion en vie : seuls
 *     le port inatteignable et les interdictions administratives etaient durs ;
 *   - une erreur douce (hote inatteignable, temps depasse) ne laissait AUCUNE
 *     trace : ni abandon — c'est juste — ni signalement, alors que la RFC veut
 *     un mecanisme pour la rapporter ;
 *   - `TCP_MAX_RETRANSMITS = 5` faisait renoncer apres 63 secondes, pour les
 *     donnees comme pour le SYN, sans aucun reglage par connexion et sans que
 *     l'application sache que la livraison peinait ;
 *   - apres un SYN retransmis, les donnees partaient sur un RTO d'une seconde.
 *
 * Autorite : RFC 9293 §3.8.3 (R1 et R2 : « The value of R1 SHOULD correspond
 * to at least 3 retransmissions, at the current RTO (SHLD-10). The value of
 * R2 SHOULD correspond to at least 100 seconds (SHLD-11) » ; « R2 for a SYN
 * segment MUST be set large enough to provide retransmission of the segment
 * for at least 3 minutes (MUST-23) » ; « An application MUST (MUST-21) be able
 * to set the value for R2 for a particular connection » ; « TCP
 * implementations SHOULD inform the application of the delivery problem ...
 * when R1 is reached and before R2 (SHLD-9) »), §3.8.6.1 (« As long as the
 * receiving TCP peer continues to send acknowledgments in response to the
 * probe segments, the sending TCP peer MUST allow the connection to stay open
 * (MUST-37) »), §3.9.1.8 (« There MUST be a mechanism for reporting soft TCP
 * error conditions to the application (MUST-47) ») et le texte des erreurs
 * dures et douces de la meme section (codes 2 a 4 durs, SHLD-26 ; codes 0, 1,
 * 5, temps depasse, parametre errone doux, MUST-56, SHLD-25) ; RFC 6298 §5.7
 * (« the RTO MUST be re-initialized to 3 seconds when data transmission begins
 * »).
 *
 * Choix assume, ecrit plutot que tu : en SYN-SENT, une erreur douce ne fait
 * pas abandonner l'ouverture — c'est la lettre de MUST-56 — alors que les
 * noyaux courants la font echouer tout de suite ; la sonde ne l'epingle pas.
 *
 * Ce qui est construit : `socket.onErrorReport` (le canal de la RFC, qui porte
 * les erreurs ICMP et le seuil R1), `socket.setUserTimeout` (R2 par connexion,
 * `Infinity` pour ne jamais renoncer), des seuils de 100 s (donnees) et 180 s
 * (SYN) mesures depuis la premiere emission du segment le plus ancien — la
 * minuterie est bornee par l'echeance, si bien que l'abandon tombe a la
 * milliseconde — ou, quand la fenetre annoncee est nulle, depuis le dernier
 * segment recu du pair (c'est ce qui tient MUST-37) ; au troisieme envoi du
 * meme segment, l'application est avertie une fois et la pile redemande
 * l'adresse de lien du prochain saut (`adviseNegative`, une requete ARP de
 * plus : « negative advice » a la couche IP) ; RTO de 3 s apres un SYN
 * retransmis (`holdAtLeast`). `worstCaseRetransmitWindowMs()` rend desormais
 * le seuil du SYN, ce que les tests de delai attendent.
 *
 * Discrimination (fichier copie sur le commit precedent) : DIX cas sur quatorze
 * tombent. Les QUATRE autres passent des deux cotes : le TEMOIN du port
 * inatteignable, la NON-REGRESSION de l'hote inatteignable, la NON-REGRESSION
 * du sondage de fenetre nulle (MUST-37 tenait deja) et le TEMOIN d'une
 * connexion dont les donnees sont acquittees.
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openPassive, PEER_ADDRESS, PEER_ISN, lettersOf, type ScriptedPeer,
} from '../../support/tcpScriptedPeer';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { TCP_INITIAL_RTO_MS } from '@/network/tcp/RttEstimator';

interface Reported { source: string; icmpType?: string; code?: number; from?: string; attempts?: number }

function reportsOf(socket: TcpSocket): Reported[] {
  const reports: Reported[] = [];
  socket.onErrorReport((report) => reports.push(report as Reported));
  return reports;
}

function established(): { peer: ScriptedPeer; socket: TcpSocket } {
  const peer = scriptedPeer();
  const connection = openPassive(peer);
  return { peer, socket: connection.socket };
}

function withUnackedData(): { peer: ScriptedPeer; socket: TcpSocket } {
  const lab = established();
  lab.socket.send('hello');
  return lab;
}

function lastDataSegment(peer: ScriptedPeer) {
  return [...peer.replies].reverse().find((segment) => segment.payload !== undefined)!;
}

describe('an ICMP error reaches a connection by what it says (RFC 9293 §3.9.2.4, RFC 1122 §4.2.3.9)', () => {
  it('WITNESS: port unreachable is a hard error and closes an established connection', () => {
    const { peer, socket } = withUnackedData();
    peer.sendIcmpError('destination-unreachable', 3, lastDataSegment(peer));
    expect(socket.closed).toBe(true);
  });

  it('protocol unreachable is a hard error as well (codes 2 to 4)', () => {
    const { peer, socket } = withUnackedData();
    peer.sendIcmpError('destination-unreachable', 2, lastDataSegment(peer));
    expect(socket.closed).toBe(true);
  });

  it('NON-REGRESSION: host unreachable is a soft error and leaves the connection alone (MUST-56)', () => {
    const { peer, socket } = withUnackedData();
    peer.sendIcmpError('destination-unreachable', 1, lastDataSegment(peer));
    expect(socket.state).toBe('established');
  });

  it('a soft error is reported to the application (MUST-47, SHLD-25)', () => {
    const { peer, socket } = withUnackedData();
    const reports = reportsOf(socket);
    peer.sendIcmpError('destination-unreachable', 1, lastDataSegment(peer));
    expect(reports).toEqual([{
      source: 'icmp', icmpType: 'destination-unreachable', code: 1, from: PEER_ADDRESS,
    }]);
    expect(socket.state).toBe('established');
  });

  it('time exceeded is soft too, and reported', () => {
    const { peer, socket } = withUnackedData();
    const reports = reportsOf(socket);
    peer.sendIcmpError('time-exceeded', 0, lastDataSegment(peer));
    expect(reports.map((r) => r.icmpType)).toEqual(['time-exceeded']);
    expect(socket.state).toBe('established');
  });
});

describe('retransmission gives up on thresholds measured in time (RFC 9293 §3.8.3)', () => {
  it('data: the connection survives 99 seconds of silence and is gone after 100 (R2, SHLD-11)', () => {
    const { peer, socket } = withUnackedData();
    peer.advance(99_000);
    expect(socket.state).toBe('established');
    peer.advance(2_000);
    expect(socket.closed).toBe(true);
    expect(socket.closeReason).toBe('timeout');
  });

  it('SYN: an unanswered connection attempt lasts at least three minutes (MUST-23)', () => {
    const peer = scriptedPeer();
    const socket = peer.dut.getTcpStack().connect(PEER_ADDRESS, peer.ports.peer)!;
    peer.advance(179_000);
    expect(socket.state).toBe('syn-sent');
    peer.advance(3_000);
    expect(socket.closed).toBe(true);
  });

  it('the application sets R2 for one connection (MUST-21)', () => {
    const { peer, socket } = withUnackedData();
    socket.setUserTimeout(20_000);
    peer.advance(19_000);
    expect(socket.state).toBe('established');
    peer.advance(1_500);
    expect(socket.closed).toBe(true);
  });

  it('an R2 of infinity never gives up (MUST-21, the interactive-application example)', () => {
    const { peer, socket } = withUnackedData();
    socket.setUserTimeout(Infinity);
    peer.advance(1_000_000);
    expect(socket.state).toBe('established');
  });

  it('R1: the application hears of the delivery problem after three retransmissions, once (SHLD-9, SHLD-10)', () => {
    const { peer, socket } = withUnackedData();
    const reports = reportsOf(socket);
    peer.advance(6_000);
    expect(reports.filter((r) => r.source === 'retransmission').length).toBe(0);
    peer.advance(2_000);
    expect(reports.filter((r) => r.source === 'retransmission').length).toBe(1);
    peer.advance(30_000);
    expect(reports.filter((r) => r.source === 'retransmission').length).toBe(1);
  });

  it('a peer that keeps acknowledging zero-window probes never makes the connection give up (MUST-37, SHLD-17)', () => {
    const { peer, socket } = established();
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: socket.sendNext, window: 0 });
    peer.respond((segment) => {
      if (segment.payload === undefined) return;
      peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: segment.sequence, window: 0 });
    });
    socket.send('queued behind a closed window');
    for (let second = 0; second < 600; second++) peer.advance(1_000);
    expect(socket.state).toBe('established');
  });

  it('WITNESS: a connection whose data is acknowledged stays up and sends nothing more', () => {
    const { peer, socket } = withUnackedData();
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: socket.sendNext });
    peer.clear();
    peer.advance(120_000);
    expect(socket.state).toBe('established');
    expect(peer.replies.length).toBe(0);
  });

  it('acknowledged traffic raises no report', () => {
    const { peer, socket } = withUnackedData();
    const reports = reportsOf(socket);
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: socket.sendNext });
    peer.advance(120_000);
    expect(reports).toEqual([]);
  });
});

describe('RFC 6298 §5.7: after a retransmitted SYN, data starts on a three-second timer', () => {
  it('the RTO is 3 s once the handshake that needed a SYN retransmission completes', () => {
    const peer = scriptedPeer();
    const socket = peer.dut.getTcpStack().connect(PEER_ADDRESS, peer.ports.peer)!;
    peer.advance(TCP_INITIAL_RTO_MS + 10);
    const retransmitted = peer.last()!;
    expect(lettersOf(retransmitted.flags)).toBe('S');
    peer.ports.dut = retransmitted.sourcePort;
    peer.send({ flags: 'SA', sequence: PEER_ISN, acknowledgement: retransmitted.sequence + 1 });
    expect(socket.state).toBe('established');
    expect(socket.rtt.currentRto()).toBe(3_000);
  });
});
