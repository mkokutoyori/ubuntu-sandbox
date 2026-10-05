/**
 * Plusieurs segments perdus dans une meme fenetre se rattrapent sans attendre
 * un temporisateur par trou : reprise SACK (RFC 6675), reprise NewReno pour
 * un pair sans SACK (RFC 6582), reprise apres une expiration du RTO.
 *
 * Mesure de depart (commit precedent), deux machines reelles, 60 000 octets
 * dont des segments de la meme fenetre sont jetes a l'arrivee :
 *
 *   - une perte : retransmise au troisieme doublon, 0 ms ;
 *   - deux pertes : la premiere au troisieme doublon, la seconde UNE RTO plus
 *     tard (1 000 ms) ; trois pertes : 2 150 ms ; cinq pertes : cinq
 *     retransmissions a 0, 1 000, 2 125, 2 125 et 2 125 ms ;
 *   - la pile ne retransmettait que la TETE de la file (a l'expiration comme
 *     au troisieme doublon) ; un ACK partiel mettait fin a la reprise et
 *     chaque trou suivant coutait un aller-retour de temporisateur, avec
 *     les blocs SACK recus sans effet sur ce qu'on renvoie ;
 *   - les trois ACK de fenetre nulle qu'un recepteur plein rend a une sonde
 *     de persistance comptaient pour trois doublons : retransmission rapide
 *     de la sonde, ssthresh a 2 920 et fenetre gonflee a 29 200 octets apres
 *     six sondes, sans qu'aucune donnee ne soit perdue ;
 *   - un transfert de 200 000 octets avec 10 % de pertes mettait de 8 a 19
 *     secondes virtuelles (84 a 142 s a 20 %), que la connexion negocie SACK
 *     ou non (la meme trace dans les deux cas).
 *
 * Autorite (RFC lues sur rfc-editor.org ; RFC 2018 est dans docs/rfc/tcp) :
 * RFC 2018 §5 (l'emetteur retient les blocs SACK, saute ce qui est acquitte
 * selectivement a la retransmission, retransmet ce qui est en dessous du
 * plus haut segment acquitte, efface les blocs a l'expiration et retransmet
 * le bord gauche de la fenetre, §5.1 la prudence de congestion est
 * conservee) ; RFC 6675 §2 (un doublon est un ACK porteur d'un bloc nouveau,
 * meme s'il avance l'ACK cumulatif), §4 (`IsLost` : trois blocs disjoints ou
 * plus de deux SMSS acquittes au-dessus ; `SetPipe` ; `NextSeg` et ses quatre
 * regles), §5 (entree en reprise au troisieme doublon ou des que la tete est
 * declaree perdue, ssthresh = cwnd = FlightSize / 2, point de reprise, boucle
 * (A) a (C), sortie sur l'ACK du point de reprise), §5.1 (apres une
 * expiration : point de reprise = HighData, pas de nouvelle reprise avant son
 * acquittement, les trous reportes sont remplis) ; RFC 6582 §3.2 (ACK
 * partiel : retransmettre le premier segment non acquitte, degonfler la
 * fenetre de ce qui est acquitte et rendre un SMSS si l'ACK en couvre au
 * moins un, rester en reprise ; ACK complet : fenetre ramenee a ssthresh) ;
 * RFC 5681 §3.1 et §3.2. Choix assumes, ecrits plutot que tus : la regle (4)
 * de NextSeg (copie de secours, un SHOULD) ne renvoie pas un segment deja
 * retransmis pendant la reprise, ce que la RFC autorise mais ne sert pas
 * (entretenir l'horloge d'ACK quand la perte est en queue de fenetre) ;
 * apres une expiration chaque segment qui etait en vol est presume perdu et
 * renvoye dans l'ordre sous la fenetre de depart lente, en sautant ce que le
 * recepteur a rapporte depuis (RFC 5681 §3.1, RFC 6675 §5.1 : « fill in »).
 *
 * Ce qui est construit : `TcpLossRecovery` (point de reprise, HighRxt,
 * RescueRxt, `pipe`, `nextHole`, `takeLastResort`), `SackScoreboard.isLost`,
 * `isSacked` et `highestEnd`, la reprise par ACK partiel, la boucle (C) de la
 * RFC 6675 avant l'envoi des donnees neuves (qui se mesurent contre
 * cwnd - pipe), l'entree en reprise apres une expiration, le champ `reason`
 * de `tcp.retransmit` (timeout, fast-retransmit, sack-hole, partial-ack,
 * rescue, timeout-recovery) ; `TcpCongestionControl` separe l'entree, le
 * doublon, l'ACK partiel et la sortie de la reprise.
 *
 * Ce qui n'est PAS construit : RACK et la sonde de queue (RFC 8985), la
 * reduction proportionnelle (RFC 6937), D-SACK (RFC 2883), F-RTO (RFC 5682),
 * la detection d'un recepteur qui renie ses blocs, et le re-armement du RTO a
 * chaque retransmission de reprise (RFC 6675 §6, facultatif) : une perte en
 * queue de fenetre, avec trop peu de segments au-dessus pour la prouver, se
 * rattrape encore par un RTO (une seule fois pour tous les trous restants).
 *
 * Laboratoire : un pair SCRIPTE forge chaque ACK dans l'ordre ou un vrai
 * recepteur le produirait ; la fenetre de congestion est posee a douze
 * segments avant l'ecriture pour que les douze partent d'un coup.
 *
 * Discrimination (fichier copie sur le commit precedent) : QUATORZE cas sur
 * dix-huit tombent. Les QUATRE autres passent des deux cotes : trois TEMOINS (deux
 * doublons qui ne prouvent aucune perte n'ouvrent pas de reprise ; une perte
 * isolee est renvoyee une fois au troisieme doublon ; une perte isolee a
 * l'expiration est renvoyee une fois et son acquittement clot l'episode) et
 * une NON-REGRESSION (un segment que le recepteur a rapporte n'est jamais
 * renvoye : la base ne renvoyait que la tete, donc jamais un segment acquitte
 * selectivement).
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openActive, type ScriptedPeer, type OpenConnection,
} from '../../support/tcpScriptedPeer';
import type { TcpOption, TcpSegment } from '@/network/tcp/types';
import { payloadBytes } from '@/network/layers/transport/L4Checksum';
import { initialCongestionWindow } from '@/network/tcp/TcpCongestionControl';

const MSS = 1460;
const WINDOW_SEGMENTS = 12;
const SACK_OFFER: TcpOption[] = [{ kind: 'mss', value: MSS }, { kind: 'sack-permitted' }];
const PLAIN_OFFER: TcpOption[] = [{ kind: 'mss', value: MSS }];

interface Lab {
  readonly peer: ScriptedPeer;
  readonly connection: OpenConnection;
  readonly start: number;
  readonly reasons: string[];
}

function lab(options: TcpOption[], segments = WINDOW_SEGMENTS): Lab {
  const peer = scriptedPeer();
  const connection = openActive(peer, options);
  const reasons: string[] = [];
  peer.bus.subscribe('tcp.retransmit', (event) => reasons.push(String((event.payload as { reason?: string }).reason)));
  connection.socket.setNoDelay(true);
  connection.socket.cc.cwnd = segments * MSS;
  connection.socket.write('a'.repeat(segments * MSS));
  const flight = dataOf(peer.take());
  expect(flight).toHaveLength(segments);
  return { peer, connection, start: connection.dutIsn + 1, reasons };
}

function dataOf(segments: TcpSegment[]): TcpSegment[] {
  return segments.filter((s) => s.payload !== undefined && payloadBytes(s.payload).length > 0);
}

function sequenceOf(lab: Lab, index: number): number {
  return (lab.start + (index - 1) * MSS) >>> 0;
}

function endOf(lab: Lab, index: number): number {
  return (sequenceOf(lab, index) + MSS) >>> 0;
}

function receive(lab: Lab, cumulative: number, blocks: Array<[number, number]> = []): void {
  const options: TcpOption[] = blocks.length === 0
    ? []
    : [{ kind: 'sack', blocks: blocks.map(([from, to]) => ({ start: sequenceOf(lab, from), end: endOf(lab, to) })) }];
  lab.peer.send({
    flags: 'A', sequence: lab.connection.peerIsn + 1, acknowledgement: cumulative, window: 65535, options,
  });
}

function resent(lab: Lab): number[] {
  return dataOf(lab.peer.take()).map((s) => ((s.sequence - lab.start) >>> 0) / MSS + 1);
}

describe('SACK-based loss recovery (RFC 6675): every hole is resent, none of them waits for a timer', () => {
  it('a hole that the first retransmission does not cover is resent as soon as the SACK blocks prove it lost', () => {
    const l = lab(SACK_OFFER);
    receive(l, sequenceOf(l, 2));
    receive(l, sequenceOf(l, 2), [[3, 3]]);
    receive(l, sequenceOf(l, 2), [[3, 4]]);
    expect(resent(l)).toEqual([]);
    receive(l, sequenceOf(l, 2), [[6, 6], [3, 4]]);
    expect(resent(l)).toEqual([2]);
    receive(l, sequenceOf(l, 2), [[6, 7], [3, 4]]);
    receive(l, sequenceOf(l, 2), [[6, 8], [3, 4]]);
    receive(l, sequenceOf(l, 2), [[6, 9], [3, 4]]);
    expect(resent(l)).toEqual([5]);
  });

  it('the virtual clock never moved: no retransmission came from the retransmission timer', () => {
    const l = lab(SACK_OFFER);
    receive(l, sequenceOf(l, 2));
    receive(l, sequenceOf(l, 2), [[3, 3]]);
    receive(l, sequenceOf(l, 2), [[3, 4]]);
    receive(l, sequenceOf(l, 2), [[6, 6], [3, 4]]);
    receive(l, sequenceOf(l, 2), [[6, 9], [3, 4]]);
    expect(l.reasons).toEqual(['fast-retransmit', 'sack-hole']);
  });

  it('a segment the receiver reported is never resent', () => {
    const l = lab(SACK_OFFER);
    receive(l, sequenceOf(l, 2));
    receive(l, sequenceOf(l, 2), [[3, 3]]);
    receive(l, sequenceOf(l, 2), [[3, 4]]);
    receive(l, sequenceOf(l, 2), [[6, 6], [3, 4]]);
    receive(l, sequenceOf(l, 2), [[6, 9], [3, 4]]);
    receive(l, sequenceOf(l, 2), [[6, 10], [3, 4]]);
    receive(l, sequenceOf(l, 2), [[6, 11], [3, 4]]);
    receive(l, sequenceOf(l, 2), [[6, 12], [3, 4]]);
    receive(l, sequenceOf(l, 5), [[6, 12]]);
    expect(resent(l).filter((index) => index !== 2 && index !== 5)).toEqual([]);
  });

  it('the congestion window stays at the halved value during recovery, with no inflation by duplicates', () => {
    const l = lab(SACK_OFFER);
    receive(l, sequenceOf(l, 2));
    const flight = (WINDOW_SEGMENTS - 1) * MSS;
    receive(l, sequenceOf(l, 2), [[3, 3]]);
    receive(l, sequenceOf(l, 2), [[3, 4]]);
    receive(l, sequenceOf(l, 2), [[6, 6], [3, 4]]);
    expect(l.connection.socket.cc.cwnd).toBe(Math.floor(flight / 2));
    receive(l, sequenceOf(l, 2), [[6, 9], [3, 4]]);
    expect(l.connection.socket.cc.cwnd).toBe(Math.floor(flight / 2));
    expect(l.connection.socket.cc.ssthresh).toBe(Math.floor(flight / 2));
  });

  it('a cumulative ACK of the whole window ends recovery at exactly the halved window', () => {
    const l = lab(SACK_OFFER);
    receive(l, sequenceOf(l, 2));
    receive(l, sequenceOf(l, 2), [[3, 3]]);
    receive(l, sequenceOf(l, 2), [[3, 4]]);
    receive(l, sequenceOf(l, 2), [[6, 6], [3, 4]]);
    receive(l, sequenceOf(l, 2), [[6, 9], [3, 4]]);
    receive(l, sequenceOf(l, 13));
    expect(l.connection.socket.cc.phase).not.toBe('fast-recovery');
    expect(l.connection.socket.sendUnacked).toBe(sequenceOf(l, 13));
    expect(l.connection.socket.cc.cwnd).toBe(l.connection.socket.cc.ssthresh);
  });

  it('one ACK whose block proves the head lost enters recovery without waiting for three duplicates', () => {
    const l = lab(SACK_OFFER);
    receive(l, sequenceOf(l, 1), [[2, 4]]);
    expect(resent(l)).toEqual([1]);
    expect(l.connection.socket.cc.phase).toBe('fast-recovery');
  });

  it('WITNESS: two duplicates that prove nothing lost send no retransmission', () => {
    const l = lab(SACK_OFFER);
    receive(l, sequenceOf(l, 1), [[2, 2]]);
    receive(l, sequenceOf(l, 1), [[2, 3]]);
    expect(resent(l).filter((index) => index === 1)).toEqual([]);
    expect(l.connection.socket.cc.phase).not.toBe('fast-recovery');
  });

  it('a hole near the end of the window, with too little above it to be proven lost, is resent as a last resort', () => {
    const l = lab(SACK_OFFER, 6);
    receive(l, sequenceOf(l, 2));
    receive(l, sequenceOf(l, 2), [[3, 3]]);
    receive(l, sequenceOf(l, 2), [[3, 4]]);
    receive(l, sequenceOf(l, 2), [[3, 5]]);
    expect(resent(l)).toEqual([2]);
    receive(l, sequenceOf(l, 2), [[3, 6]]);
    receive(l, sequenceOf(l, 6), [[3, 6]]);
    expect(l.connection.socket.cc.phase).toBe('fast-recovery');
  });
});

describe('NewReno recovery (RFC 6582) for a peer without SACK: a partial acknowledgment resends the next hole', () => {
  it('the first hole is resent at the third duplicate, the second at the partial ACK that follows', () => {
    const l = lab(PLAIN_OFFER);
    receive(l, sequenceOf(l, 2));
    for (let i = 0; i < 3; i++) receive(l, sequenceOf(l, 2));
    expect(resent(l)).toEqual([2]);
    for (let i = 0; i < 4; i++) receive(l, sequenceOf(l, 2));
    expect(resent(l)).toEqual([]);
    receive(l, sequenceOf(l, 5));
    expect(resent(l)).toEqual([5]);
    expect(l.reasons).toEqual(['fast-retransmit', 'partial-ack']);
  });

  it('the partial ACK deflates the window by what it acknowledged and adds one segment back', () => {
    const l = lab(PLAIN_OFFER);
    receive(l, sequenceOf(l, 2));
    const flight = (WINDOW_SEGMENTS - 1) * MSS;
    const ssthresh = Math.floor(flight / 2);
    for (let i = 0; i < 3; i++) receive(l, sequenceOf(l, 2));
    expect(l.connection.socket.cc.cwnd).toBe(ssthresh + 3 * MSS);
    for (let i = 0; i < 4; i++) receive(l, sequenceOf(l, 2));
    expect(l.connection.socket.cc.cwnd).toBe(ssthresh + 7 * MSS);
    receive(l, sequenceOf(l, 5));
    expect(l.connection.socket.cc.cwnd).toBe(ssthresh + 7 * MSS - 3 * MSS + MSS);
    expect(l.connection.socket.cc.phase).toBe('fast-recovery');
  });

  it('the full acknowledgment of the window ends recovery at the halved window', () => {
    const l = lab(PLAIN_OFFER);
    receive(l, sequenceOf(l, 2));
    const ssthresh = Math.floor(((WINDOW_SEGMENTS - 1) * MSS) / 2);
    for (let i = 0; i < 7; i++) receive(l, sequenceOf(l, 2));
    receive(l, sequenceOf(l, 5));
    receive(l, sequenceOf(l, 13));
    expect(l.connection.socket.cc.cwnd).toBe(ssthresh);
    expect(l.connection.socket.cc.phase).not.toBe('fast-recovery');
  });

  it('WITNESS: one lost segment is resent once, at the third duplicate', () => {
    const l = lab(PLAIN_OFFER);
    receive(l, sequenceOf(l, 2));
    for (let i = 0; i < 3; i++) receive(l, sequenceOf(l, 2));
    expect(resent(l)).toEqual([2]);
    receive(l, sequenceOf(l, 13));
    expect(resent(l)).toEqual([]);
  });
});

describe('after a retransmission timeout every segment that was outstanding is resent, as the window opens', () => {
  it.each([['with SACK', SACK_OFFER], ['without SACK', PLAIN_OFFER]])(
    'six segments lost: the timer resends the first, the acknowledgment of it releases the next ones (%s)',
    (_name, options) => {
      const l = lab(options, 6);
      l.peer.advance(1100);
      expect(resent(l)).toEqual([1]);
      receive(l, sequenceOf(l, 2));
      expect(resent(l)).toEqual([2, 3]);
      receive(l, sequenceOf(l, 4));
      expect(resent(l)).toEqual([4, 5, 6]);
      expect(l.reasons).toEqual(['timeout', 'timeout-recovery', 'timeout-recovery', 'timeout-recovery', 'timeout-recovery', 'timeout-recovery']);
    });

  it('a segment the receiver reports after the timeout is skipped: the holes are filled, the reported ones are not resent', () => {
    const l = lab(SACK_OFFER, 6);
    l.peer.advance(1100);
    l.peer.take();
    receive(l, sequenceOf(l, 2), [[3, 4]]);
    expect(resent(l)).toEqual([2, 5]);
  });

  it('WITNESS: a single lost segment is resent once by the timer and its acknowledgment ends the episode', () => {
    const l = lab(SACK_OFFER, 1);
    l.peer.advance(1100);
    expect(resent(l)).toEqual([1]);
    receive(l, sequenceOf(l, 2));
    expect(resent(l)).toEqual([]);
  });

  it('duplicate acknowledgments during the timeout recovery do not open a new fast retransmit', () => {
    const l = lab(PLAIN_OFFER, 6);
    l.peer.advance(1100);
    l.peer.take();
    receive(l, sequenceOf(l, 2));
    l.peer.take();
    for (let i = 0; i < 4; i++) receive(l, sequenceOf(l, 2));
    expect(resent(l)).toEqual([]);
  });
});

describe('a closed window is not a loss', () => {
  it('the three zero-window answers to a persist probe are not duplicate acknowledgments', () => {
    const peer = scriptedPeer();
    const connection = openActive(peer, PLAIN_OFFER, 7_000_000, 0);
    connection.socket.setNoDelay(true);
    connection.socket.write('a'.repeat(5000));
    for (let round = 0; round < 3; round++) {
      peer.advance(1100 * 2 ** round);
      for (let answer = 0; answer < 3; answer++) {
        peer.send({
          flags: 'A', sequence: connection.peerIsn + 1, acknowledgement: connection.dutIsn + 1, window: 0,
        });
      }
    }
    expect(connection.socket.cc.ssthresh).toBe(Number.MAX_SAFE_INTEGER);
    expect(connection.socket.cc.cwnd).toBe(initialCongestionWindow(MSS));
    expect(connection.socket.cc.phase).not.toBe('fast-recovery');
  });
});
