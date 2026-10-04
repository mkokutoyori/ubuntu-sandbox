/**
 * Les etats de fermeture ne sont quittes que par le segment qui les quitte.
 *
 * Mesure de depart (9883a6d5b), pair SCRIPTE, le DUT ayant appele
 * `close()` :
 *
 *   - FIN-WAIT-1 passait en FIN-WAIT-2 sur N'IMPORTE QUEL ACK (`else if
 *     (seg.flags.ack)`), y compris un ACK qui ne couvre pas notre FIN ;
 *   - un FIN portant un ACK allait droit a TIME-WAIT meme quand cet ACK ne
 *     couvrait pas notre FIN : c'est une fermeture simultanee, donc
 *     CLOSING ;
 *   - FIN-WAIT-1 ignorait les donnees du pair ; or le pair peut encore
 *     parler tant que notre FIN n'est pas acquittee ;
 *   - CLOSING entrait en TIME-WAIT, et LAST-ACK fermait, sur n'importe quel
 *     ACK ;
 *   - un FIN retransmis en TIME-WAIT etait acquitte mais ne relancait pas
 *     l'attente de 2 MSL.
 *
 * Autorite : RFC 9293 §3.10.7.4, cinquieme controle (« FIN-WAIT-1 : if the
 * FIN segment is now acknowledged, then enter FIN-WAIT-2 » ; « CLOSING :
 * if the ACK acknowledges our FIN, then enter the TIME-WAIT state;
 * otherwise, ignore the segment » ; « LAST-ACK : ... If our FIN is now
 * acknowledged, delete the TCB » ; « TIME-WAIT : ... Acknowledge it, and
 * restart the 2 MSL timeout »), septieme controle (le texte est livre en
 * ESTABLISHED, FIN-WAIT-1 et FIN-WAIT-2) et huitieme (« FIN-WAIT-1 : If our
 * FIN has been ACKed (perhaps in this segment), then enter TIME-WAIT ...
 * otherwise, enter the CLOSING state »).
 *
 * Discrimination (fichier copie sur 9883a6d5b) : SIX cas sur dix tombent.
 * Les QUATRE autres sont des TEMOINS qui passent des deux cotes : l'ACK qui
 * couvre le FIN mene a FIN-WAIT-2, le FIN dont l'ACK couvre le notre mene a
 * TIME-WAIT, CLOSING quitte sur l'ACK de notre FIN, LAST-ACK ferme sur
 * l'ACK de notre FIN — sans eux, une pile qui ne bougerait plus jamais
 * passerait les six autres.
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openPassive, PEER_ISN, type ScriptedPeer, type OpenConnection,
} from '../../support/tcpScriptedPeer';
import { TCP_TIME_WAIT_MS } from '@/network/tcp/types';
import { TCP_DELAYED_ACK_MS } from '@/network/tcp/TcpStack';

function closing(): { peer: ScriptedPeer; connection: OpenConnection; finSequence: number; received: string[] } {
  const peer = scriptedPeer();
  const connection = openPassive(peer);
  const received: string[] = [];
  connection.socket.onData((data) => received.push(String(data)));
  connection.socket.close();
  expect(connection.socket.state).toBe('fin-wait-1');
  const finSequence = peer.last()!.sequence;
  return { peer, connection, finSequence, received };
}

describe('FIN-WAIT-1 leaves only when its FIN is acknowledged (RFC 9293 §3.10.7.4, fifth and eighth checks)', () => {
  it('an ACK that does not cover the FIN keeps FIN-WAIT-1', () => {
    const { peer, connection, finSequence } = closing();
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: finSequence });
    expect(connection.socket.state).toBe('fin-wait-1');
  });

  it('WITNESS: an ACK covering the FIN moves to FIN-WAIT-2', () => {
    const { peer, connection, finSequence } = closing();
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: finSequence + 1 });
    expect(connection.socket.state).toBe('fin-wait-2');
  });

  it('a FIN whose ACK does not cover ours is a simultaneous close: CLOSING', () => {
    const { peer, connection, finSequence } = closing();
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1, acknowledgement: finSequence });
    expect(connection.socket.state).toBe('closing');
  });

  it('WITNESS: a FIN whose ACK covers ours goes straight to TIME-WAIT', () => {
    const { peer, connection, finSequence } = closing();
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1, acknowledgement: finSequence + 1 });
    expect(connection.socket.state).toBe('time-wait');
  });

  it('data from the peer is still accepted and acknowledged', () => {
    const { peer, connection, finSequence, received } = closing();
    peer.clear();
    peer.send({ flags: 'PA', sequence: PEER_ISN + 1, acknowledgement: finSequence, payload: 'late' });
    peer.advance(TCP_DELAYED_ACK_MS);
    expect(received.join('')).toBe('late');
    expect(connection.socket.recvNext).toBe(PEER_ISN + 1 + 4);
    expect(peer.last()!.acknowledgement).toBe(PEER_ISN + 1 + 4);
  });
});

describe('CLOSING, LAST-ACK and TIME-WAIT leave only on the right segment', () => {
  it('CLOSING ignores an ACK that does not cover our FIN', () => {
    const { peer, connection, finSequence } = closing();
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1, acknowledgement: finSequence });
    peer.send({ flags: 'A', sequence: PEER_ISN + 2, acknowledgement: finSequence });
    expect(connection.socket.state).toBe('closing');
  });

  it('WITNESS: CLOSING enters TIME-WAIT when our FIN is acknowledged', () => {
    const { peer, connection, finSequence } = closing();
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1, acknowledgement: finSequence });
    peer.send({ flags: 'A', sequence: PEER_ISN + 2, acknowledgement: finSequence + 1 });
    expect(connection.socket.state).toBe('time-wait');
  });

  it('LAST-ACK ignores an ACK that does not cover our FIN', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendNext });
    expect(connection.socket.state).toBe('last-ack');
    const finSequence = peer.last()!.sequence;
    peer.send({ flags: 'A', sequence: PEER_ISN + 2, acknowledgement: finSequence });
    expect(connection.socket.state).toBe('last-ack');
  });

  it('WITNESS: LAST-ACK closes when our FIN is acknowledged', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendNext });
    const finSequence = peer.last()!.sequence;
    peer.send({ flags: 'A', sequence: PEER_ISN + 2, acknowledgement: finSequence + 1 });
    expect(connection.socket.state).toBe('closed');
  });

  it('a retransmitted FIN in TIME-WAIT is acknowledged and restarts the 2MSL wait', () => {
    const { peer, connection, finSequence } = closing();
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1, acknowledgement: finSequence + 1 });
    expect(connection.socket.state).toBe('time-wait');
    peer.advance(TCP_TIME_WAIT_MS - 1_000);
    peer.clear();
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1, acknowledgement: finSequence + 1 });
    expect(peer.last()).toBeDefined();
    expect(peer.last()!.acknowledgement).toBe(PEER_ISN + 2);
    peer.advance(TCP_TIME_WAIT_MS - 1_000);
    expect(connection.socket.state).toBe('time-wait');
    peer.advance(2_000);
    expect(connection.socket.state).toBe('closed');
  });
});
