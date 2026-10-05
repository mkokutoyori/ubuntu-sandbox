/**
 * La poignee de main TCP juge le champ ACK avant de rien accepter, et
 * l'application ne voit une connexion qu'une fois la poignee terminee.
 *
 * Mesure de depart (9883a6d5b), avec un pair SCRIPTE (le test joue le
 * pair a la main, sur un vrai cable, sans pile en face) :
 *
 *   - en SYN-SENT, un SYN-ACK dont l'ACK ne couvre pas notre SYN —
 *     ISS+6, ISS lui-meme — ouvrait la connexion (`seg.flags.syn &&
 *     seg.flags.ack` suffisait) ; aucun RST ne partait ;
 *   - un ACK nu et acceptable (sans SYN) retirait notre SYN de la file de
 *     retransmission avant meme que l'etat soit juge : la socket restait
 *     en SYN-SENT et ne retransmettait plus jamais ;
 *   - en SYN-RECEIVED, N'IMPORTE QUEL ACK etablissait la connexion ;
 *   - la socket etait remise a l'ecouteur (`onAccept`) a l'arrivee du SYN,
 *     donc un SYN jamais acheve — un demi-balayage — atteignait
 *     l'application, qui voyait ensuite le RST de l'ouvreur comme une
 *     fermeture.
 *
 * Autorite : RFC 9293 §3.10.7.3, premier controle (« If SEG.ACK =< ISS or
 * SEG.ACK > SND.NXT, send a reset <SEQ=SEG.ACK><CTL=RST> ... and discard
 * the segment »), cinquieme controle (« if neither of the SYN or RST bits
 * is set, then drop the segment ») ; §3.10.7.4, cinquieme controle,
 * SYN-RECEIVED (« If SND.UNA < SEG.ACK =< SND.NXT, then enter ESTABLISHED
 * ... If the segment acknowledgment is not acceptable, form a reset
 * segment <SEQ=SEG.ACK><CTL=RST> ») et deuxieme controle (RST en
 * SYN-RECEIVED issu d'une ouverture passive : « return this connection to
 * LISTEN state and return. The user need not be informed »). Le texte de
 * la RFC ne dit pas QUAND `accept()` rend la socket ; c'est la file
 * d'acceptation de l'API, qui ne recoit la connexion qu'a l'ACK — la
 * sonde `probe-ssh-une-seule-sonde` l'enonce deja pour `sshd`.
 *
 * Discrimination (fichier copie sur 9883a6d5b) : NEUF cas sur dix-sept
 * tombent. Les HUIT autres passent des deux cotes : quatre TEMOINS (le
 * SYN-ACK exact ouvre ; le SYN nu est une ouverture simultanee ; l'ACK
 * exact etablit ; l'ACK final livre bien la socket a `onAccept`) et
 * quatre NON-REGRESSIONS (un RST porteur d'un ACK inacceptable est jete
 * sans reponse ; un RST hors fenetre est ignore ; les donnees portees
 * par l'ACK final atteignent le gestionnaire pose dans `onAccept` ; la
 * banniere ne part qu'une fois la connexion etablie).
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openPassive, lettersOf, PEER_ISN, PEER_ADDRESS, type ScriptedPeer,
} from '../../support/tcpScriptedPeer';
import type { TcpSocket } from '@/network/tcp/TcpStack';

function synSent(peer: ScriptedPeer): { socket: TcpSocket; iss: number } {
  const socket = peer.dut.getTcpStack().connect(PEER_ADDRESS, peer.ports.peer)!;
  const syn = peer.last()!;
  peer.ports.dut = syn.sourcePort;
  peer.clear();
  return { socket, iss: syn.sequence };
}

function synReceived(peer: ScriptedPeer): { socket: TcpSocket; iss: number } {
  peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: () => undefined });
  peer.send({ flags: 'S', sequence: PEER_ISN });
  const synAck = peer.last()!;
  peer.clear();
  return { socket: peer.dut.getTcpStack().listSockets()[0], iss: synAck.sequence };
}

describe('SYN-SENT judges the ACK before anything else (RFC 9293 §3.10.7.3)', () => {
  it('WITNESS: a SYN-ACK acknowledging exactly ISS+1 opens the connection', () => {
    const peer = scriptedPeer();
    const { socket, iss } = synSent(peer);
    peer.send({ flags: 'SA', sequence: PEER_ISN, acknowledgement: iss + 1 });
    expect(socket.state).toBe('established');
    expect(lettersOf(peer.last()!.flags)).toBe('A');
  });

  it('a SYN-ACK acknowledging beyond SND.NXT is answered <SEQ=SEG.ACK><CTL=RST> and does not open', () => {
    const peer = scriptedPeer();
    const { socket, iss } = synSent(peer);
    peer.send({ flags: 'SA', sequence: PEER_ISN, acknowledgement: iss + 6 });
    expect(socket.state).toBe('syn-sent');
    const reply = peer.last();
    expect(reply).toBeDefined();
    expect(lettersOf(reply!.flags)).toBe('R');
    expect(reply!.sequence).toBe(iss + 6);
  });

  it('a SYN-ACK acknowledging ISS itself acknowledges nothing: RST, no connection', () => {
    const peer = scriptedPeer();
    const { socket, iss } = synSent(peer);
    peer.send({ flags: 'SA', sequence: PEER_ISN, acknowledgement: iss });
    expect(socket.state).toBe('syn-sent');
    expect(lettersOf(peer.last()?.flags ?? ({} as never))).toBe('R');
    expect(peer.last()!.sequence).toBe(iss);
  });

  it('a bare ACK with an unacceptable acknowledgment is answered RST', () => {
    const peer = scriptedPeer();
    const { socket, iss } = synSent(peer);
    peer.send({ flags: 'A', sequence: PEER_ISN, acknowledgement: iss + 77 });
    expect(socket.state).toBe('syn-sent');
    expect(peer.last()).toBeDefined();
    expect(lettersOf(peer.last()!.flags)).toBe('R');
    expect(peer.last()!.sequence).toBe(iss + 77);
  });

  it('a bare ACK that is acceptable is dropped whole: the SYN stays queued and is retransmitted', () => {
    const peer = scriptedPeer();
    const { socket, iss } = synSent(peer);
    peer.send({ flags: 'A', sequence: PEER_ISN, acknowledgement: iss + 1 });
    expect(socket.state).toBe('syn-sent');
    peer.advance(1_100);
    const retransmitted = peer.take().filter((s) => lettersOf(s.flags) === 'S');
    expect(retransmitted.length).toBe(1);
    expect(retransmitted[0].sequence).toBe(iss);
  });

  it('NON-REGRESSION: a RST carrying an unacceptable ACK is dropped without a reply', () => {
    const peer = scriptedPeer();
    const { socket, iss } = synSent(peer);
    peer.send({ flags: 'RA', sequence: 0, acknowledgement: iss + 40 });
    expect(socket.state).toBe('syn-sent');
    expect(peer.replies.length).toBe(0);
  });

  it('WITNESS: a bare SYN is a simultaneous open — SYN-RECEIVED and <SEQ=ISS><ACK=IRS+1><CTL=SYN,ACK>', () => {
    const peer = scriptedPeer();
    const { socket, iss } = synSent(peer);
    peer.send({ flags: 'S', sequence: PEER_ISN });
    expect(socket.state).toBe('syn-received');
    const reply = peer.last()!;
    expect(lettersOf(reply.flags)).toBe('SA');
    expect(reply.sequence).toBe(iss);
    expect(reply.acknowledgement).toBe(PEER_ISN + 1);
  });
});

describe('SYN-RECEIVED judges the ACK before establishing (RFC 9293 §3.10.7.4, fifth check)', () => {
  it('WITNESS: an ACK of ISS+1 establishes the connection', () => {
    const peer = scriptedPeer();
    const { socket, iss } = synReceived(peer);
    expect(socket.state).toBe('syn-received');
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: iss + 1 });
    expect(socket.state).toBe('established');
  });

  it('an ACK that does not cover the SYN-ACK is answered <SEQ=SEG.ACK><CTL=RST> and does not establish', () => {
    const peer = scriptedPeer();
    const { socket, iss } = synReceived(peer);
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: iss });
    expect(socket.state).toBe('syn-received');
    expect(peer.last()).toBeDefined();
    expect(lettersOf(peer.last()!.flags)).toBe('R');
    expect(peer.last()!.sequence).toBe(iss);
  });

  it('an ACK beyond SND.NXT is answered RST and does not establish', () => {
    const peer = scriptedPeer();
    const { socket, iss } = synReceived(peer);
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: iss + 1_000 });
    expect(socket.state).toBe('syn-received');
    expect(peer.last()).toBeDefined();
    expect(lettersOf(peer.last()!.flags)).toBe('R');
    expect(peer.last()!.sequence).toBe(iss + 1_000);
  });

  it('NON-REGRESSION: a RST outside the window is ignored in SYN-RECEIVED', () => {
    const peer = scriptedPeer();
    const { socket } = synReceived(peer);
    peer.send({ flags: 'R', sequence: PEER_ISN + 1 + 500_000 });
    expect(socket.state).toBe('syn-received');
  });
});

describe('the application sees a connection only once the handshake completed', () => {
  it('a SYN that is never completed does not reach onAccept', () => {
    const peer = scriptedPeer();
    const accepted: TcpSocket[] = [];
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: (s) => { accepted.push(s); } });
    peer.send({ flags: 'S', sequence: PEER_ISN });
    expect(lettersOf(peer.last()!.flags)).toBe('SA');
    expect(accepted.length).toBe(0);
  });

  it('WITNESS: the completing ACK delivers the connection to onAccept', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    expect(connection.socket).toBeDefined();
    expect(connection.socket.state).toBe('established');
  });

  it('a RST in SYN-RECEIVED returns to LISTEN: no accept, no close event, and the listener still works', () => {
    const peer = scriptedPeer();
    const accepted: TcpSocket[] = [];
    const closed: unknown[] = [];
    peer.bus.subscribe('tcp.connection.closed', (event) => closed.push(event.payload));
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: (s) => { accepted.push(s); } });
    peer.send({ flags: 'S', sequence: PEER_ISN });
    peer.send({ flags: 'R', sequence: PEER_ISN + 1 });
    expect(peer.dut.getTcpStack().listSockets().length).toBe(0);
    expect(accepted.length).toBe(0);
    expect(closed.length).toBe(0);
    peer.send({ flags: 'S', sequence: PEER_ISN + 5_000 });
    const synAck = peer.last()!;
    peer.send({ flags: 'A', sequence: PEER_ISN + 5_001, acknowledgement: synAck.sequence + 1 });
    expect(accepted.length).toBe(1);
  });

  it('closing the listener drops the half-open connection: the late ACK is answered RST and nothing is accepted', () => {
    const peer = scriptedPeer();
    const accepted: TcpSocket[] = [];
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: (s) => { accepted.push(s); } });
    peer.send({ flags: 'S', sequence: PEER_ISN });
    const synAck = peer.last()!;
    peer.dut.getTcpStack().closeListener(peer.ports.dut);
    peer.clear();
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: synAck.sequence + 1 });
    expect(accepted.length).toBe(0);
    expect(lettersOf(peer.last()!.flags)).toBe('R');
    expect(peer.last()!.sequence).toBe(synAck.sequence + 1);
  });

  it('NON-REGRESSION: data carried by the completing ACK reaches the handler registered in onAccept', () => {
    const peer = scriptedPeer();
    const received: string[] = [];
    peer.dut.getTcpStack().listen(peer.ports.dut, {
      onAccept: (s) => { s.onData((data) => received.push(String(data))); },
    });
    peer.send({ flags: 'S', sequence: PEER_ISN });
    const synAck = peer.last()!;
    peer.send({
      flags: 'PA', sequence: PEER_ISN + 1, acknowledgement: synAck.sequence + 1, payload: 'GET /',
    });
    expect(received).toEqual(['GET /']);
  });

  it('NON-REGRESSION: the greeting banner leaves only once the connection is established', () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().listen(peer.ports.dut, {
      onAccept: () => undefined, identity: { banner: 'HELLO\r\n' },
    });
    peer.send({ flags: 'S', sequence: PEER_ISN });
    const synAck = peer.last()!;
    expect(peer.replies.filter((s) => s.payload !== undefined).length).toBe(0);
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: synAck.sequence + 1 });
    const greeting = peer.replies.find((s) => s.payload !== undefined);
    expect(greeting).toBeDefined();
    expect(String(greeting!.payload)).toBe('HELLO\r\n');
  });
});
