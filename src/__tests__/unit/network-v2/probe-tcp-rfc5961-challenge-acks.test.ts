/**
 * Un SYN en etat synchronise appelle un ACK de defi, un ACK hors de
 * l'intervalle admissible est ecarte, les ACK de defi sont limites, et un
 * segment ancien ne deplace pas la fenetre d'emission.
 *
 * Mesure de depart (9883a6d5b), pair SCRIPTE, connexion ETABLIE :
 *
 *   - un SYN, dans la fenetre ou tres au-dela, n'obtenait AUCUNE reponse ;
 *   - un segment de donnees dont l'ACK acquitte ce que nous n'avons jamais
 *     envoye (`SND.NXT + 5000`), ou un ACK anterieur a SND.UNA de plus
 *     qu'une fenetre maximale, etait livre a l'application ;
 *   - le seul ACK de defi existant, celui d'un RST dans la fenetre, n'etait
 *     pas limite ;
 *   - `peerWindow` suivait N'IMPORTE QUEL segment : un ACK ancien portant
 *     une grande fenetre rouvrait la fenetre d'emission.
 *
 * Autorite : RFC 5961 §4.2 (« If the SYN bit is set, irrespective of the
 * sequence number, TCP MUST send an ACK (challenge ACK) ...
 * <SEQ=SND.NXT><ACK=RCV.NXT><CTL=ACK> ... and drop the unacceptable
 * segment »), §5.2 (« The ACK value is considered acceptable only if it is
 * in the range of ((SND.UNA - MAX.SND.WND) <= SEG.ACK <= SND.NXT) ... MUST
 * be discarded and an ACK sent back ») et §7 (« in any 5 second window, no
 * more than 10 challenge ACKs should be sent »), repris par RFC 9293
 * §3.10.7.4 (quatrieme et cinquieme controles, MAY-12) ; la regle
 * SND.WL1/SND.WL2 est celle du cinquieme controle de RFC 9293 §3.10.7.4,
 * ESTABLISHED.
 *
 * Discrimination (fichier copie sur 9883a6d5b) : SIX cas sur neuf tombent.
 * Les TROIS autres passent des deux cotes : le TEMOIN (des donnees a ACK
 * courant sont livrees), la NON-REGRESSION d'un ACK en double legerement
 * ancien, toujours accepte et ignore, et le TEMOIN d'un segment recent qui
 * deplace bien la fenetre.
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openPassive, lettersOf, PEER_ISN,
} from '../../support/tcpScriptedPeer';

function established() {
  const peer = scriptedPeer();
  const connection = openPassive(peer);
  const received: string[] = [];
  connection.socket.onData((data) => received.push(String(data)));
  return { peer, connection, received };
}

describe('a SYN in a synchronized state earns a challenge ACK, never a reset (RFC 5961 §4.2)', () => {
  it('an in-window SYN is answered <SEQ=SND.NXT><ACK=RCV.NXT><CTL=ACK> and the connection survives', () => {
    const { peer, connection } = established();
    peer.clear();
    peer.send({ flags: 'S', sequence: PEER_ISN + 1 + 100 });
    expect(connection.socket.state).toBe('established');
    expect(peer.last()).toBeDefined();
    expect(lettersOf(peer.last()!.flags)).toBe('A');
    expect(peer.last()!.sequence).toBe(connection.socket.sendNext);
    expect(peer.last()!.acknowledgement).toBe(PEER_ISN + 1);
  });

  it('a SYN far outside the window is challenged just the same', () => {
    const { peer, connection } = established();
    peer.clear();
    peer.send({ flags: 'S', sequence: PEER_ISN + 1 + 1_000_000 });
    expect(connection.socket.state).toBe('established');
    expect(peer.last()).toBeDefined();
    expect(lettersOf(peer.last()!.flags)).toBe('A');
  });

  it('challenge ACKs are throttled: ten in a five-second window, then again after it', () => {
    const { peer } = established();
    peer.clear();
    for (let i = 0; i < 15; i++) peer.send({ flags: 'S', sequence: PEER_ISN + 1 + 100 + i });
    expect(peer.take().length).toBe(10);
    peer.advance(5_000);
    peer.send({ flags: 'S', sequence: PEER_ISN + 1 + 200 });
    expect(peer.take().length).toBe(1);
  });
});

describe('an ACK outside ((SND.UNA - MAX.SND.WND) =< SEG.ACK =< SND.NXT) is discarded and answered (RFC 5961 §5.2)', () => {
  it('data acknowledging something never sent is not delivered', () => {
    const { peer, connection, received } = established();
    peer.clear();
    peer.send({
      flags: 'PA', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendNext + 5_000, payload: 'forged',
    });
    expect(received).toEqual([]);
    expect(connection.socket.recvNext).toBe(PEER_ISN + 1);
    expect(peer.last()).toBeDefined();
  });

  it('data whose ACK is older than one maximum window below SND.UNA is not delivered', () => {
    const { peer, connection, received } = established();
    connection.socket.write('x'.repeat(10));
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendNext });
    peer.clear();
    peer.send({
      flags: 'PA', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendUnacked - 70_000, payload: 'forged',
    });
    expect(received).toEqual([]);
    expect(peer.last()).toBeDefined();
  });

  it('WITNESS: data with a current ACK is delivered', () => {
    const { peer, connection, received } = established();
    peer.send({ flags: 'PA', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendNext, payload: 'genuine' });
    expect(received).toEqual(['genuine']);
  });

  it('NON-REGRESSION: a slightly old duplicate ACK inside the window is still accepted and ignored', () => {
    const { peer, connection, received } = established();
    connection.socket.write('x'.repeat(10));
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendNext });
    peer.send({
      flags: 'PA', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendUnacked - 5, payload: 'ok',
    });
    expect(received).toEqual(['ok']);
  });
});

describe('an old segment cannot move the send window (RFC 9293 §3.10.7.4, SND.WL1 and SND.WL2)', () => {
  it('a stale ACK carrying a larger window leaves SND.WND alone', () => {
    const { peer, connection } = established();
    peer.send({ flags: 'A', sequence: PEER_ISN + 1 + 10, acknowledgement: connection.socket.sendNext, window: 1_000 });
    expect(connection.socket.peerWindow).toBeGreaterThan(0);
    const settled = connection.socket.peerWindow;
    peer.send({ flags: 'A', sequence: PEER_ISN + 1 + 5, acknowledgement: connection.socket.sendNext, window: 60_000 });
    expect(connection.socket.peerWindow).toBe(settled);
  });

  it('WITNESS: a newer segment does move it', () => {
    const { peer, connection } = established();
    peer.send({ flags: 'A', sequence: PEER_ISN + 1 + 10, acknowledgement: connection.socket.sendNext, window: 1_000 });
    const settled = connection.socket.peerWindow;
    peer.send({ flags: 'A', sequence: PEER_ISN + 1 + 20, acknowledgement: connection.socket.sendNext, window: 60_000 });
    expect(connection.socket.peerWindow).not.toBe(settled);
  });
});
