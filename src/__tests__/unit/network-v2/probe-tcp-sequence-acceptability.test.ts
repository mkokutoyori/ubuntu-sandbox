/**
 * Un segment est juge contre la fenetre de reception avant tout traitement,
 * ses octets anciens sont rognes, les octets en avance sont conserves sans
 * recouvrement, et un FIN n'est traite qu'une fois tout ce qui le precede
 * arrive.
 *
 * Mesure de depart (9883a6d5b), pair SCRIPTE :
 *
 *   - un segment chevauchant RCV.NXT (`abc` deja recu, puis `abcdefgh`)
 *     n'etait pas traite : `acceptInOrder` exigeait `seq === recvNext`, et
 *     les cinq octets neufs etaient perdus ;
 *   - un segment commencant a 70 000 octets de RCV.NXT, pour une fenetre de
 *     65 535, etait conserve des qu'un SACK etait negocie ; la mise en
 *     file ne regardait pas la fenetre ;
 *   - deux segments hors sequence qui se chevauchent etaient gardes
 *     separement : les blocs SACK rendus se recouvraient (la RFC 2018 les
 *     veut disjoints) et le second ne se videait jamais, faute de
 *     commencer a RCV.NXT ;
 *   - sans SACK negocie, rien n'etait conserve du tout ;
 *   - un FIN place derriere un trou (`seq = RCV.NXT + 10`) faisait entrer en
 *     CLOSE-WAIT immediatement : `if (seg.flags.fin) handleIncomingFin()`
 *     etait inconditionnel, et les dix octets manquants, arrives ensuite,
 *     etaient ignores par un etat qui ne lit plus le texte ;
 *   - un FIN suivant des octets sans PSH ne les livrait pas : le FIN
 *     « implique PUSH » ;
 *   - un ACK nu dont la sequence est a 200 000 octets de la fenetre ne
 *     recevait aucune reponse ; un segment sans bit ACK etait traite.
 *
 * Autorite : RFC 9293 §3.10.7.4, premier controle et tableau 6 (quatre cas
 * d'acceptabilite ; « If an incoming segment is not acceptable, an
 * acknowledgment should be sent in reply » ; « If a segment's contents
 * straddle the boundary between old and new, only the new parts are
 * processed » ; « Segments with higher beginning sequence numbers SHOULD
 * be held for later processing », SHLD-31), cinquieme controle (« if the
 * ACK bit is off, drop the segment ») et huitieme controle (« advance
 * RCV.NXT over the FIN ... FIN implies PUSH for any segment text not yet
 * delivered to the user ») ; RFC 2018 §4 (blocs SACK disjoints).
 *
 * Discrimination (fichier copie sur 9883a6d5b) : ONZE cas sur quinze
 * tombent. Les QUATRE autres passent des deux cotes : le TEMOIN (des
 * donnees a RCV.NXT sont livrees), la NON-REGRESSION du doublon ancien
 * (ACK, jamais livre deux fois), le TEMOIN de l'ACK nu a RCV.NXT (aucune
 * reponse) et le TEMOIN des donnees accompagnees d'un FIN en sequence.
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openPassive, lettersOf, sackBlocksOf, PEER_ISN, type ScriptedPeer, type OpenConnection,
} from '../../support/tcpScriptedPeer';
import type { TcpOption } from '@/network/tcp/types';

const SACK_OFFER: TcpOption[] = [{ kind: 'mss', value: 1460 }, { kind: 'sack-permitted' }];

function established(options: TcpOption[] = []): {
  peer: ScriptedPeer; connection: OpenConnection; received: string[]; sendAt: (offset: number, text: string, flags?: string) => void;
} {
  const peer = scriptedPeer();
  const connection = openPassive(peer, options);
  const received: string[] = [];
  connection.socket.onData((data) => received.push(String(data)));
  const sendAt = (offset: number, text: string, flags = 'PA'): void => {
    peer.send({
      flags, sequence: PEER_ISN + 1 + offset, acknowledgement: connection.socket.sendNext, payload: text,
    });
  };
  return { peer, connection, received, sendAt };
}

describe('a segment is judged against the receive window before anything else (RFC 9293 Table 6)', () => {
  it('WITNESS: data at RCV.NXT is delivered and RCV.NXT moves', () => {
    const { connection, received, sendAt } = established();
    sendAt(0, 'hello');
    expect(received).toEqual(['hello']);
    expect(connection.socket.recvNext).toBe(PEER_ISN + 1 + 5);
  });

  it('NON-REGRESSION: an old duplicate is answered with an ACK and not delivered twice', () => {
    const { peer, connection, received, sendAt } = established();
    sendAt(0, 'hello');
    peer.clear();
    sendAt(0, 'hello');
    expect(received).toEqual(['hello']);
    expect(peer.last()).toBeDefined();
    expect(peer.last()!.acknowledgement).toBe(connection.socket.recvNext);
  });

  it('a segment straddling RCV.NXT delivers only its new part', () => {
    const { connection, received, sendAt } = established();
    sendAt(0, 'abc');
    sendAt(0, 'abcdefgh');
    expect(received.join('')).toBe('abcdefgh');
    expect(connection.socket.recvNext).toBe(PEER_ISN + 1 + 8);
  });

  it('a segment starting beyond the window is not held', () => {
    const { peer, connection, sendAt } = established(SACK_OFFER);
    peer.clear();
    sendAt(70_000, 'far');
    expect(connection.socket.reassemblyBuffer.length).toBe(0);
    expect(peer.last()).toBeDefined();
    expect(peer.last()!.acknowledgement).toBe(connection.socket.recvNext);
  });

  it('a segment straddling the right edge keeps only the bytes inside the window', () => {
    const { peer, connection, sendAt } = established(SACK_OFFER);
    peer.clear();
    sendAt(65_530, 'ABCDEFGHIJ');
    const blocks = sackBlocksOf(peer.last()!);
    expect(blocks.length).toBe(1);
    expect(blocks[0].start).toBe(PEER_ISN + 1 + 65_530);
    expect(blocks[0].end).toBe(connection.socket.recvNext + 65_535);
  });

  it('a pure ACK whose sequence number is far outside the window is answered with an ACK', () => {
    const { peer, connection } = established();
    peer.clear();
    peer.send({ flags: 'A', sequence: PEER_ISN + 1 + 200_000, acknowledgement: connection.socket.sendNext });
    expect(peer.last()).toBeDefined();
    expect(lettersOf(peer.last()!.flags)).toBe('A');
    expect(peer.last()!.acknowledgement).toBe(connection.socket.recvNext);
  });

  it('WITNESS: a pure ACK at RCV.NXT is acceptable and earns no reply', () => {
    const { peer, connection } = established();
    peer.clear();
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendNext });
    expect(peer.replies.length).toBe(0);
  });

  it('a segment without the ACK bit is dropped whole', () => {
    const { connection, received, sendAt } = established();
    sendAt(0, 'sneaky', 'P');
    expect(received).toEqual([]);
    expect(connection.socket.recvNext).toBe(PEER_ISN + 1);
  });
});

describe('out-of-order data is held without overlap and delivered in sequence (RFC 9293 SHLD-31, RFC 2018 §4)', () => {
  it('two overlapping out-of-order segments are reported as one disjoint SACK block', () => {
    const { peer, sendAt } = established(SACK_OFFER);
    sendAt(10, 'AAAAAAAAAA');
    peer.clear();
    sendAt(15, 'BBBBBBBBBB');
    expect(sackBlocksOf(peer.last()!)).toEqual([{ start: PEER_ISN + 1 + 10, end: PEER_ISN + 1 + 25 }]);
  });

  it('filling the hole delivers every held byte exactly once, in order', () => {
    const { connection, received, sendAt } = established(SACK_OFFER);
    sendAt(10, 'KLMNOPQRST');
    sendAt(15, 'PQRSTUVWXY');
    sendAt(0, 'ABCDEFGHIJ');
    expect(received.join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXY');
    expect(connection.socket.recvNext).toBe(PEER_ISN + 1 + 25);
  });

  it('out-of-order data is held even when SACK was not negotiated', () => {
    const { connection, received, sendAt } = established();
    sendAt(5, 'FGHIJ');
    expect(connection.socket.reassemblyBuffer.length).toBe(1);
    sendAt(0, 'ABCDE');
    expect(received.join('')).toBe('ABCDEFGHIJ');
  });
});

describe('a FIN is processed only once everything before it has arrived (RFC 9293 §3.10.7.4, eighth check)', () => {
  it('a FIN beyond a hole does not close the receive side', () => {
    const { peer, connection } = established();
    peer.clear();
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1 + 10, acknowledgement: connection.socket.sendNext });
    expect(connection.socket.state).toBe('established');
    expect(peer.last()).toBeDefined();
    expect(peer.last()!.acknowledgement).toBe(PEER_ISN + 1);
  });

  it('the held FIN takes effect when the hole fills, after the missing data is delivered', () => {
    const { peer, connection, received, sendAt } = established();
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1 + 10, acknowledgement: connection.socket.sendNext });
    sendAt(0, 'ABCDEFGHIJ');
    expect(received.join('')).toBe('ABCDEFGHIJ');
    expect(connection.socket.recvNext).toBe(PEER_ISN + 1 + 11);
    expect(['close-wait', 'last-ack']).toContain(connection.socket.state);
  });

  it('WITNESS: data and FIN in order deliver the data and consume the FIN', () => {
    const { connection, received, sendAt } = established();
    sendAt(0, 'bye', 'FPA');
    expect(received.join('')).toBe('bye');
    expect(connection.socket.recvNext).toBe(PEER_ISN + 1 + 4);
  });

  it('a FIN implies PUSH for text not yet delivered', () => {
    const { peer, connection, received, sendAt } = established();
    sendAt(0, 'tail', 'A');
    expect(received).toEqual([]);
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1 + 4, acknowledgement: connection.socket.sendNext });
    expect(received.join('')).toBe('tail');
  });
});
