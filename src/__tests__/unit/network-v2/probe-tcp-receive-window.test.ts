/**
 * La fenetre qu'un recepteur annonce est l'espace qui lui reste, elle ne
 * s'elargit pas par petits pas, et un emetteur ne decoupe pas ce qu'il
 * envoie en miettes parce que la fenetre s'est refermee.
 *
 * Mesure de depart (commit precedent), pair SCRIPTE :
 *
 *   - la fenetre annoncee valait `windowSize`, toujours : 65 535 apres 60 000
 *     octets recus et non lus. Le pair continuait d'envoyer ; au-dela de
 *     65 535 octets en attente, `_fireData` jetait l'excedent EN SILENCE,
 *     apres l'avoir acquitte : l'emetteur croyait ses octets livres ;
 *   - un octet de plus que la fenetre annoncee etait accepte et acquitte ;
 *   - donner un gestionnaire a une prise qui retenait des octets ne
 *     relancait aucun ACK : une fenetre refermee par un lecteur lent ne
 *     rouvrait que sur une sonde de fenetre nulle ;
 *   - rien ne permettait de suspendre la lecture (`pause`/`resume`) ;
 *   - une fenetre qui s'ouvrait de 100 octets etait annoncee telle quelle ;
 *   - un emetteur dont le pair annonce 100 octets de fenetre apres en avoir
 *     annonce 65 535 envoyait un segment de 100 octets, puis un autre a
 *     chaque ACK : le syndrome de la fenetre stupide.
 *
 * Autorite : RFC 9293 §3.8.6.2.1 (« A TCP implementation MUST include a SWS
 * avoidance algorithm in the sender » MUST-38 ; envoi si min(D,U) >= MSS
 * effectif, ou si min(D,U) >= Fs x Max(SND.WND) avec Fs = 1/2, ou au delai
 * de forçage de 0,1 a 1 s) ; §3.8.6.2.2 (« A TCP implementation MUST include
 * a SWS avoidance algorithm in the receiver » MUST-39 ; « avoid advancing
 * the right window edge RCV.NXT+RCV.WND in small increments » : la fenetre
 * n'avance que si la reduction vaut au moins min(Fr x RCV.BUFF, Eff.snd.MSS),
 * Fr = 1/2) ; §3.8.6 (la fenetre est l'espace libre, RCV.WND = RCV.BUFF -
 * RCV.USER) et SHLD-14 (ne pas la reduire) ; MUST-34 et SHLD-15 a SHLD-17
 * (un emetteur tolere une fenetre qui se reduit : plus de donnees neuves, les
 * anciennes retransmises normalement) ; §3.8.6.1 (une fenetre nulle est
 * sondee, MUST-36). Linux, de memoire du code du noyau (`tcp_cleanup_rbuf`),
 * annonce de meme la reouverture quand elle s'agrandit d'au moins le double.
 *
 * Ce qui est construit : une file de reception sur la prise
 * (`unreadBytes`, `pause`, `resume`) qui remplace la reserve de
 * `earlyData` ; la fenetre annoncee est `windowSize - unreadBytes`, le bord
 * droit RCV.NXT+RCV.WND ne recule jamais sous l'effet de l'arrivee de
 * donnees, et une augmentation de moins de min(MSS, windowSize / 2) est tue
 * tant que de l'espace reste occupe ; `windowSize` devient une propriete qui
 * annonce l'espace gagne ; l'acceptation d'un segment se juge contre le bord
 * droit annonce ; la lecture (gestionnaire donne, `resume`) annonce la
 * fenetre rouverte par un ACK immediat ; l'emetteur compare la place laissee
 * par la FENETRE a celle que laisse la congestion, retient un segment
 * inferieur a min(MSS, Max(SND.WND) / 2) tant que la file en contient plus
 * qu'il n'en passe, et le force au bout de 500 ms par le temporisateur de
 * sonde.
 *
 * Discrimination (fichier copie sur le commit precedent, avec l'aide
 * `tcpScriptedPeer.ts`) : DIX cas sur quatorze tombent. Les QUATRE autres
 * passent des deux cotes : le TEMOIN d'un lecteur attache (fenetre pleine),
 * la NON-REGRESSION d'un emetteur devant une fenetre reduite (plus de donnees
 * neuves, les anciennes retransmises), celle d'une fenetre nulle sondee dont
 * la reponse revele la reouverture, et le TEMOIN d'une fenetre qui a toujours
 * ete petite (utilisee, non attendue).
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openPassive, openActive, lettersOf, type ScriptedPeer, type OpenConnection,
} from '../../support/tcpScriptedPeer';
import { TCP_DELAYED_ACK_MS } from '@/network/tcp/TcpStack';
import { payloadBytes } from '@/network/layers/transport/L4Checksum';

const FULL_WINDOW = 65535;
const MSS = 1460;
const PERSIST_FIRST_PROBE_MS = 1000;
const OVERRIDE_MS = 500;

function dataSegment(peer: ScriptedPeer, connection: OpenConnection, offset: number, length: number): void {
  peer.send({
    flags: 'PA', sequence: connection.peerIsn + 1 + offset,
    acknowledgement: connection.dutIsn + 1, payload: 'x'.repeat(length),
  });
}

function lastWindow(peer: ScriptedPeer): number {
  peer.advance(TCP_DELAYED_ACK_MS);
  return peer.last()!.window;
}

describe('the window offered is the space left (RFC 9293 §3.8.6)', () => {
  it('WITNESS: with a reader attached the window stays full', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    connection.socket.onData(() => undefined);
    dataSegment(peer, connection, 0, 20000);
    expect(lastWindow(peer)).toBe(FULL_WINDOW);
  });

  it.each([[20000, 45535], [40000, 25535], [60000, 5535]])(
    'after %s bytes nobody read, the window is %s', (received, expected) => {
      const peer = scriptedPeer();
      const connection = openPassive(peer);
      dataSegment(peer, connection, 0, received);
      expect(lastWindow(peer)).toBe(expected);
      expect(connection.socket.unreadBytes).toBe(received);
    });

  it('a full buffer offers a zero window and the acknowledgement does not move past it', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    dataSegment(peer, connection, 0, FULL_WINDOW);
    expect(lastWindow(peer)).toBe(0);
    peer.clear();
    dataSegment(peer, connection, FULL_WINDOW, 10);
    expect(peer.last()!.window).toBe(0);
    expect(peer.last()!.acknowledgement).toBe(connection.peerIsn + 1 + FULL_WINDOW);
    expect(connection.socket.unreadBytes).toBe(FULL_WINDOW);
  });

  it('a reader that arrives gets every byte and the window is announced again at once', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    dataSegment(peer, connection, 0, FULL_WINDOW);
    peer.advance(TCP_DELAYED_ACK_MS);
    peer.clear();
    let delivered = 0;
    connection.socket.onData((data) => { delivered += payloadBytes(data).length; });
    expect(delivered).toBe(FULL_WINDOW);
    expect(lettersOf(peer.last()!.flags)).toBe('A');
    expect(peer.last()!.window).toBe(FULL_WINDOW);
  });

  it('a paused socket keeps what arrives, and resume delivers it and reopens the window', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    let delivered = 0;
    connection.socket.onData((data) => { delivered += payloadBytes(data).length; });
    connection.socket.pause();
    dataSegment(peer, connection, 0, 10000);
    expect(delivered).toBe(0);
    expect(lastWindow(peer)).toBe(FULL_WINDOW - 10000);
    peer.clear();
    connection.socket.resume();
    expect(delivered).toBe(10000);
    expect(peer.last()!.window).toBe(FULL_WINDOW);
  });
});

describe('the right edge does not advance in small steps (RFC 9293 §3.8.6.2.2, MUST-39)', () => {
  function closedWindow(): { peer: ScriptedPeer; connection: OpenConnection } {
    const peer = scriptedPeer();
    const connection = openPassive(peer, [{ kind: 'mss', value: MSS }]);
    dataSegment(peer, connection, 0, FULL_WINDOW);
    peer.advance(TCP_DELAYED_ACK_MS);
    peer.clear();
    return { peer, connection };
  }

  it('a window that gains 100 bytes is still announced as closed', () => {
    const { peer, connection } = closedWindow();
    connection.socket.windowSize = FULL_WINDOW + 100;
    expect(peer.replies).toHaveLength(0);
    dataSegment(peer, connection, FULL_WINDOW, 1);
    expect(peer.last()!.window).toBe(0);
  });

  it('a window that gains a full segment is announced at once', () => {
    const { peer, connection } = closedWindow();
    connection.socket.windowSize = FULL_WINDOW + 2000;
    expect(peer.last()!.window).toBe(2000);
  });
});

describe('a sender survives a window that shrinks (RFC 9293 §3.8.6, MUST-34, SHLD-15 to SHLD-17)', () => {
  it('WITNESS: a window cut below what is in flight stops new data and the old data is retransmitted', () => {
    const peer = scriptedPeer();
    const connection = openActive(peer, [{ kind: 'mss', value: MSS }]);
    connection.socket.setNoDelay(true);
    connection.socket.write('a'.repeat(4000));
    const first = peer.take().filter((s) => s.payload !== undefined);
    expect(first.length).toBeGreaterThan(0);
    const dataStart = connection.dutIsn + 1;
    peer.send({
      flags: 'A', sequence: connection.peerIsn + 1, acknowledgement: dataStart + MSS, window: 50,
    });
    connection.socket.write('b'.repeat(500));
    expect(peer.take().filter((s) => s.payload !== undefined)).toHaveLength(0);
    peer.advance(1500);
    const retransmitted = peer.take().filter((s) => s.payload !== undefined);
    expect(retransmitted.length).toBeGreaterThan(0);
    expect(retransmitted[0].sequence).toBe(dataStart + MSS);
  });

  it('WITNESS: a zero window is probed, and the answer to the probe reveals the reopening', () => {
    const peer = scriptedPeer();
    const connection = openActive(peer, [{ kind: 'mss', value: MSS }]);
    peer.send({
      flags: 'A', sequence: connection.peerIsn + 1, acknowledgement: connection.dutIsn + 1, window: 0,
    });
    connection.socket.write('hello');
    expect(peer.take().filter((s) => s.payload !== undefined)).toHaveLength(0);
    peer.advance(PERSIST_FIRST_PROBE_MS + 10);
    const probe = peer.take().filter((s) => s.payload !== undefined);
    expect(probe).toHaveLength(1);
    expect(payloadBytes(probe[0].payload)).toHaveLength(1);
    peer.send({
      flags: 'A', sequence: connection.peerIsn + 1, acknowledgement: probe[0].sequence + 1, window: FULL_WINDOW,
    });
    expect(peer.take().filter((s) => s.payload !== undefined).map((s) => payloadBytes(s.payload).length))
      .toEqual([4]);
  });
});

describe('a sender does not send crumbs because the window closed (RFC 9293 §3.8.6.2.1, MUST-38)', () => {
  function saturated(): { peer: ScriptedPeer; connection: OpenConnection } {
    const peer = scriptedPeer();
    const connection = openActive(peer, [{ kind: 'mss', value: MSS }]);
    connection.socket.setNoDelay(true);
    peer.send({
      flags: 'A', sequence: connection.peerIsn + 1, acknowledgement: connection.dutIsn + 1, window: FULL_WINDOW,
    });
    connection.socket.write('a'.repeat(100000));
    const flight = peer.take().filter((s) => s.payload !== undefined);
    const last = flight[flight.length - 1];
    peer.send({
      flags: 'A', sequence: connection.peerIsn + 1,
      acknowledgement: last.sequence + payloadBytes(last.payload).length, window: 100,
    });
    return { peer, connection };
  }

  it('a window of 100 after one of 65 535 earns no 100-byte segment', () => {
    const { peer } = saturated();
    expect(peer.take().filter((s) => s.payload !== undefined)).toHaveLength(0);
  });

  it('the override timer forces the segment out after 500 ms', () => {
    const { peer } = saturated();
    peer.take();
    peer.advance(OVERRIDE_MS + 10);
    const forced = peer.take().filter((s) => s.payload !== undefined);
    expect(forced.map((s) => payloadBytes(s.payload).length)).toEqual([100]);
  });

  it('WITNESS: a window that has always been small is used, not waited out', () => {
    const peer = scriptedPeer();
    const connection = openActive(peer, [{ kind: 'mss', value: MSS }], undefined, 100);
    connection.socket.setNoDelay(true);
    peer.send({
      flags: 'A', sequence: connection.peerIsn + 1, acknowledgement: connection.dutIsn + 1, window: 100,
    });
    connection.socket.write('a'.repeat(1000));
    expect(peer.take().filter((s) => s.payload !== undefined).map((s) => payloadBytes(s.payload).length))
      .toEqual([100]);
  });
});
