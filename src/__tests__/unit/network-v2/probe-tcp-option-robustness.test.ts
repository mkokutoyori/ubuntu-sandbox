/**
 * Une option recue est lue comme la RFC la lit : la liste s'arrete au End of
 * Option List, une echelle de fenetre superieure a 14 vaut 14, un MSS nul
 * n'est pas un MSS, et une option inconnue ne derange rien.
 *
 * Mesure de depart (commit precedent), pair SCRIPTE :
 *
 *   - un SYN portant MSS 0 donnait `socket.mss === 0` ; la premiere ecriture
 *     de l'application entrait alors dans une boucle sans fin (le decoupage
 *     en segments de 0 octet n'avance jamais) : le processus a ete tue apres
 *     60 s. N'importe quel pair, ou un outil de scan, gelait donc l'onglet ;
 *   - un MSS de 1 a 7 octets etait suivi a la lettre, un octet par segment ;
 *   - une echelle de fenetre de 15 etait appliquee telle quelle, et une de
 *     255 donnait une fenetre de 2^31 (`seg.window << 255` decale de 255 mod
 *     32) ; une echelle negative donnait une fenetre de 0 ;
 *   - les options placees apres un End of Option List etaient lues quand
 *     meme : `[end, window-scale 7]` negociait l'echelle.
 *
 * Autorite : RFC 7323 §2.3 (« If a Window Scale option is received with a
 * shift.cnt value larger than 14, the TCP SHOULD log the error but MUST use
 * 14 instead of the specified value ») ; RFC 9293 §3.1 (« End of Option List
 * ... indicates the end of the option list ») et MUST-69 (« The content of
 * the header beyond the End of Option List Option MUST be header padding of
 * zeros ») ; MUST-6 et MUST-68 (une option inconnue est ignoree sans
 * erreur) ; MUST-65 (le MSS n'a de sens que dans un SYN) ; RFC 7323 §3.2
 * (« the TSopt MUST be sent in every non-<RST> segment »). Le texte ne dit
 * rien d'un MSS nul ou minuscule : la regle suit ce que fait Linux
 * (`tcp_parse_options` ignore un MSS nul, `tcp_min_snd_mss` releve les trop
 * petits), de memoire du code du noyau, source non joignable d'ici ; la
 * constante est `TCP_MIN_MSS`, deja celle qui borne `maxSegmentSize`.
 *
 * Ce qui n'est PAS construit, et pourquoi : la regle « un segment sans
 * TSopt est abandonne quand les horodatages sont negocies » (RFC 7323 §3.2,
 * SHOULD) — Linux et FreeBSD divergent (Linux accepte, FreeBSD abandonne
 * sauf `tolerate_missing_ts`), aucune capture ne tranche, et le texte de la
 * pile Linux simulee n'est pas joignable ; MUST-7 (longueur d'option
 * illegale) n'est pas representable : un segment simule porte des options
 * typees, sans champ de longueur qui puisse etre faux.
 *
 * Discrimination (fichier copie sur le commit precedent) : DIX cas sur seize
 * tombent — neuf par assertion, et celui de l'ecriture apres un MSS nul qui
 * ne termine pas (processus tue apres 60 s ; il est exclu de la mesure par
 * `-t`). Les SIX autres passent des deux cotes : les TEMOINS d'un MSS
 * ordinaire, d'une echelle de 14 et des options placees avant le End of
 * Option List, la NON-REGRESSION d'une option inconnue ignoree et d'un MSS ou
 * d'une echelle portes par un segment qui n'est pas un SYN, et le TEMOIN de
 * l'horodatage present sur toute donnee, tout ACK nu et tout FIN.
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openPassive, openActive, lettersOf, type ScriptedPeer, type OpenConnection,
} from '../../support/tcpScriptedPeer';
import type { TcpOption } from '@/network/tcp/types';
import { payloadBytes } from '@/network/layers/transport/L4Checksum';
import { Logger } from '@/network/core/Logger';

const unknownOption = { kind: 'experimental', code: 254 } as unknown as TcpOption;

function dataSizes(peer: ScriptedPeer): number[] {
  return peer.replies.filter((s) => s.payload !== undefined).map((s) => payloadBytes(s.payload).length);
}

function advertiseWindow(peer: ScriptedPeer, connection: OpenConnection, window: number, options: TcpOption[] = []): void {
  peer.send({
    flags: 'A', sequence: connection.peerIsn + 1, acknowledgement: connection.dutIsn + 1, window, options,
  });
}

describe('a received MSS option is usable (RFC 9293 §3.7.1)', () => {
  it('an MSS of 0 offered in a SYN leaves the send MSS at the default 536', () => {
    const peer = scriptedPeer();
    const { socket } = openPassive(peer, [{ kind: 'mss', value: 0 }]);
    expect(socket.mss).toBe(536);
  });

  it('an MSS of 0 offered in a SYN-ACK leaves the send MSS at the default 536', () => {
    const peer = scriptedPeer();
    const { socket } = openActive(peer, [{ kind: 'mss', value: 0 }]);
    expect(socket.mss).toBe(536);
  });

  it('a write after an MSS of 0 is cut into 536-byte segments and terminates', () => {
    const peer = scriptedPeer();
    const { socket } = openPassive(peer, [{ kind: 'mss', value: 0 }]);
    socket.setNoDelay(true);
    socket.write('x'.repeat(1200));
    expect(dataSizes(peer)).toEqual([536, 536, 128]);
  });

  it('an MSS under the minimum is raised to it and the data is cut accordingly', () => {
    const peer = scriptedPeer();
    const { socket } = openPassive(peer, [{ kind: 'mss', value: 3 }]);
    socket.setNoDelay(true);
    socket.write('y'.repeat(20));
    expect(socket.mss).toBe(8);
    expect(dataSizes(peer)).toEqual([8, 8, 4]);
  });

  it('WITNESS: an ordinary MSS is followed as offered', () => {
    const peer = scriptedPeer();
    const { socket } = openPassive(peer, [{ kind: 'mss', value: 1000 }]);
    expect(socket.mss).toBe(1000);
  });
});

describe('a received Window Scale option is bounded (RFC 7323 §2.3)', () => {
  it('a shift.cnt of 15 is used as 14', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, [{ kind: 'window-scale', shift: 15 }]);
    advertiseWindow(peer, connection, 1);
    expect(connection.socket.peerWindowScale).toBe(14);
    expect(connection.socket.peerWindow).toBe(1 << 14);
  });

  it('a shift.cnt of 255 is used as 14', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, [{ kind: 'window-scale', shift: 255 }]);
    advertiseWindow(peer, connection, 1);
    expect(connection.socket.peerWindow).toBe(1 << 14);
  });

  it('WITNESS: a shift.cnt of 14 is used as offered', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, [{ kind: 'window-scale', shift: 14 }]);
    advertiseWindow(peer, connection, 1);
    expect(connection.socket.peerWindow).toBe(1 << 14);
  });

  it('a negative shift.cnt is not an offer', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, [{ kind: 'window-scale', shift: -1 }]);
    advertiseWindow(peer, connection, 100);
    expect(connection.socket.peerWindowScale).toBeNull();
    expect(connection.socket.peerWindow).toBe(100);
  });

  it('a shift.cnt above 14 is logged', () => {
    const peer = scriptedPeer();
    openPassive(peer, [{ kind: 'window-scale', shift: 15 }]);
    const entries = Logger.getLogs().filter((log) => log.event === 'tcp:window-scale' && log.level === 'warn');
    expect(entries).toHaveLength(1);
  });
});

describe('the option list ends where it says (RFC 9293 §3.1, MUST-69)', () => {
  it('a Window Scale placed after End of Option List is not read', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, [{ kind: 'end' }, { kind: 'window-scale', shift: 7 }]);
    advertiseWindow(peer, connection, 100);
    expect(connection.socket.peerWindowScale).toBeNull();
    expect(connection.socket.peerWindow).toBe(100);
  });

  it('an MSS placed after End of Option List is not read', () => {
    const peer = scriptedPeer();
    const { socket } = openPassive(peer, [{ kind: 'end' }, { kind: 'mss', value: 1000 }]);
    expect(socket.mss).toBe(536);
  });

  it('WITNESS: options before End of Option List are read', () => {
    const peer = scriptedPeer();
    const { socket } = openPassive(peer, [{ kind: 'mss', value: 1000 }, { kind: 'nop' }, { kind: 'end' }]);
    expect(socket.mss).toBe(1000);
  });
});

describe('what a receiver is not obliged to understand (MUST-6, MUST-65, MUST-68)', () => {
  it('WITNESS: an unknown option is ignored and the options after it are still read', () => {
    const peer = scriptedPeer();
    const { socket } = openPassive(peer, [unknownOption, { kind: 'mss', value: 1200 }]);
    expect(socket.state).toBe('established');
    expect(socket.mss).toBe(1200);
  });

  it('WITNESS: an MSS and a Window Scale on a segment that is not a SYN change nothing', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, [{ kind: 'mss', value: 1000 }]);
    advertiseWindow(peer, connection, 100, [{ kind: 'mss', value: 100 }, { kind: 'window-scale', shift: 3 }]);
    expect(connection.socket.mss).toBe(1000);
    expect(connection.socket.peerWindowScale).toBeNull();
    expect(connection.socket.peerWindow).toBe(100);
  });
});

describe('a negotiated timestamp rides on every segment that is not a RST (RFC 7323 §3.2)', () => {
  it('WITNESS: data, a pure ACK and a FIN all carry a timestamp', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, [{ kind: 'timestamp', tsVal: 100, tsEcr: 0 }]);
    connection.socket.setNoDelay(true);
    connection.socket.write('ping');
    peer.send({
      flags: 'PA', sequence: connection.peerIsn + 1, acknowledgement: connection.dutIsn + 1, payload: 'pong',
      options: [{ kind: 'timestamp', tsVal: 101, tsEcr: 0 }],
    });
    peer.advance(1000);
    connection.socket.close();
    const carrying = peer.replies.filter((s) => !s.flags.rst);
    expect(carrying.map((s) => lettersOf(s.flags))).toEqual(expect.arrayContaining(['PA', 'A', 'FA']));
    expect(carrying.every((s) => s.options.some((o) => o.kind === 'timestamp'))).toBe(true);
  });
});
