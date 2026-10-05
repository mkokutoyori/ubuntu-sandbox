/**
 * Une pile TCP n'ouvre pas de connexion avec une adresse qui ne designe pas
 * UNE machine, rouvre une connexion depuis TIME-WAIT quand un SYN neuf
 * arrive, et laisse l'application fixer le TTL et le champ Differentiated
 * Services de ses segments.
 *
 * Mesure de depart (commit precedent), pair SCRIPTE :
 *
 *   - un SYN adresse a 10.0.0.255 (diffusion dirigee du reseau connecte), a
 *     255.255.255.255, a 224.0.0.1 ou a 239.1.1.1, avec un ecouteur sur le
 *     port, recevait un SYN-ACK emis DEPUIS cette adresse de diffusion ou de
 *     groupe, et laissait un socket en SYN-RECEIVED. Un seul SYN vers
 *     l'adresse de diffusion d'un reseau faisait repondre toutes les
 *     machines qui ecoutent le port : un amplificateur ;
 *   - un ACK errant adresse a une diffusion recevait un RST ;
 *   - un SYN dont la source est 0.0.0.0, 255.255.255.255, 224.0.0.1,
 *     10.0.0.255 (diffusion dirigee) ou 240.0.0.1 creait un socket, et le
 *     SYN-ACK partait vers une adresse qui ne designe personne ;
 *   - un SYN-ACK de WindowsPC portait TTL 64 : `TCP_DEFAULT_TTL` etait
 *     ecrit en dur alors que `WindowsPC.defaultTTL` vaut 128 et que ses
 *     echos ICMP partent deja avec 128 — deux reponses a « quel est le TTL
 *     de cette machine ? » ;
 *   - ni le TTL ni le champ Diffserv n'etaient reglables, pour une
 *     connexion ni pour un ecouteur ;
 *   - un SYN neuf (sequence au-dela de RCV.NXT) arrivant sur un socket en
 *     TIME-WAIT recevait un ACK de defi : le client rebondissait sur son
 *     propre numero de port pendant 2 MSL.
 *
 * Autorite : RFC 9293 §3.9.2.3 (« A TCP implementation MUST silently discard
 * an incoming SYN segment that is addressed to a broadcast or multicast
 * address » MUST-57 ; « An incoming SYN with an invalid source address MUST
 * be ignored either by TCP or by the IP layer » MUST-63) ; §3.9.1.9 (« The
 * application layer MUST be able to specify the Differentiated Services
 * field for segments that are sent on a connection » MUST-48 ; « The
 * Differentiated Services field includes the 6-bit Differentiated Services
 * Codepoint (DSCP) value » ; « The TTL value used to send TCP segments MUST
 * be configurable » MUST-49 ; SHLD-21 : le champ peut changer en cours de
 * connexion) ; §3.6.1 (« it MAY accept a new SYN from the remote TCP
 * endpoint to reopen the connection directly from TIME-WAIT state (MAY-2),
 * if it: (1) assigns its initial sequence number for the new connection to
 * be larger than the largest sequence number it used on the previous
 * connection incarnation, and (2) returns to TIME-WAIT state if the SYN
 * turns out to be an old duplicate »).
 *
 * Ce qui est construit : `TimeToLive` et `DiffServField`
 * (`core/IpHeaderFields.ts`, valeurs typees comme `PortNumber`) ; `setTtl`
 * et `setDiffServ` sur la prise, `ttl` et `diffServ` aux options de
 * `connect` et `listen` (la prise acceptee herite de l'ecouteur, SYN-ACK
 * compris) ; `TcpHost.defaultTtl` — EndHost y repond par son `defaultTTL`,
 * Router par le sien — au lieu d'un 64 en dur ; `handleIp`/`handleIp6`
 * refusent un segment adresse a une diffusion ou a un groupe, et un segment
 * dont la source est martienne, nulle, de groupe, de diffusion dirigee ou
 * (IPv6) de bouclage, par les memes `isUnicastDestination` et
 * `martianSource` que le reste de la couche Internet ; la reouverture
 * depuis TIME-WAIT choisit un numero de sequence initial au moins egal au
 * `sendNext` de l'incarnation precedente.
 *
 * Ce qui n'est PAS construit : l'algorithme de RFC 6191 (SHLD-4,
 * reouverture par horodatage) — le texte n'est pas fourni et la regle de
 * RFC 9293 §3.6.1 est la seule dont la source soit lisible ici ; la route
 * source des RFC 9293 MUST-51 a MUST-53 (option IP LSRR/SSRR a l'ouverture
 * active, memorisation de la route de retour), qu'un hote qui laisse
 * `accept_source_route` a zero n'honore pas.
 *
 * Discrimination (fichier copie sur le commit precedent, avec `IpHeaderFields.ts` et
 * l'aide `tcpScriptedPeer.ts`, pour que le module charge et que
 * `scriptedPeer('windows')` existe) : DIX-NEUF cas sur trente-sept tombent.
 * Les DIX-HUIT autres passent des deux cotes : les TEMOINS du laboratoire
 * (SYN unicast repondu, ACK errant unicast repondu par un RST, SYN du pair
 * valide, TTL 64 d'un Linux, champ Diffserv nul par defaut, TIME-WAIT qui
 * dure 2 MSL), les NON-REGRESSIONS (source 127.0.0.1 et notre propre adresse
 * deja ecartees, vieux SYN dupliques et SYN sans ecouteur qui laissent
 * TIME-WAIT intact) et douze cas STRUCTURELS — les valeurs `TimeToLive` et
 * `DiffServField` refusent l'invalide a la construction, ce que le fichier
 * copie sur la base porte deja puisque le module y est copie.
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openPassive, lettersOf, PEER_ISN, PEER_ADDRESS, DUT_ADDRESS,
  type ScriptedPeer,
} from '../../support/tcpScriptedPeer';
import { ETHERTYPE_IPV4, IP_PROTO_TCP, type IPv4Packet } from '@/network/core/types';
import { TimeToLive, DiffServField } from '@/network/core/IpHeaderFields';
import { TCP_TIME_WAIT_MS } from '@/network/tcp/types';

function listenOnDut(peer: ScriptedPeer, options: Parameters<ReturnType<ScriptedPeer['dut']['getTcpStack']>['listen']>[1] = { onAccept: () => {} }): void {
  peer.dut.getTcpStack().listen(peer.ports.dut, options);
}

function tcpPackets(peer: ScriptedPeer): IPv4Packet[] {
  return peer.frames
    .filter((frame) => frame.etherType === ETHERTYPE_IPV4)
    .map((frame) => frame.payload as IPv4Packet)
    .filter((packet) => packet.protocol === IP_PROTO_TCP);
}

function lastPacket(peer: ScriptedPeer): IPv4Packet {
  const packets = tcpPackets(peer);
  return packets[packets.length - 1];
}

function socketCount(peer: ScriptedPeer): number {
  return peer.dut.getTcpStack().listSockets().length;
}

describe('a SYN addressed to a broadcast or a group is silently discarded (RFC 9293 MUST-57)', () => {
  it.each(['10.0.0.255', '255.255.255.255', '224.0.0.1', '239.1.1.1'])(
    'a SYN to %s earns no reply and no socket', (destination) => {
      const peer = scriptedPeer();
      listenOnDut(peer);
      peer.send({ flags: 'S', sequence: PEER_ISN, destinationAddress: destination });
      expect(peer.replies).toHaveLength(0);
      expect(socketCount(peer)).toBe(0);
    });

  it('WITNESS: a SYN to the unicast address is answered with a SYN-ACK and a socket', () => {
    const peer = scriptedPeer();
    listenOnDut(peer);
    peer.send({ flags: 'S', sequence: PEER_ISN });
    expect(peer.replies.map((s) => lettersOf(s.flags))).toEqual(['SA']);
    expect(socketCount(peer)).toBe(1);
  });

  it('a stray ACK to a directed broadcast earns no RST', () => {
    const peer = scriptedPeer();
    peer.send({ flags: 'A', sequence: 5, acknowledgement: 9, destinationAddress: '10.0.0.255' });
    expect(peer.replies).toHaveLength(0);
  });

  it('WITNESS: the same stray ACK to the unicast address earns a RST', () => {
    const peer = scriptedPeer();
    peer.send({ flags: 'A', sequence: 5, acknowledgement: 9 });
    expect(peer.replies.map((s) => lettersOf(s.flags))).toEqual(['R']);
  });
});

describe('a SYN with an invalid source address is ignored (RFC 9293 MUST-63)', () => {
  it.each(['0.0.0.0', '255.255.255.255', '224.0.0.1', '10.0.0.255', '240.0.0.1'])(
    'a SYN from %s creates no socket', (source) => {
      const peer = scriptedPeer();
      listenOnDut(peer);
      peer.send({ flags: 'S', sequence: PEER_ISN, sourceAddress: source });
      expect(socketCount(peer)).toBe(0);
    });

  it.each(['127.0.0.1', DUT_ADDRESS])(
    'NON-REGRESSION: a SYN from %s, a loopback or our own address, creates no socket', (source) => {
      const peer = scriptedPeer();
      listenOnDut(peer);
      peer.send({ flags: 'S', sequence: PEER_ISN, sourceAddress: source });
      expect(socketCount(peer)).toBe(0);
    });

  it('WITNESS: a SYN from the valid peer creates a socket in the same lab', () => {
    const peer = scriptedPeer();
    listenOnDut(peer);
    peer.send({ flags: 'S', sequence: PEER_ISN, sourceAddress: PEER_ADDRESS });
    expect(socketCount(peer)).toBe(1);
  });
});

describe('the TTL of a segment is the machine\'s unless the application sets one (RFC 9293 MUST-49)', () => {
  it('WITNESS: a Linux host answers with TTL 64', () => {
    const peer = scriptedPeer();
    listenOnDut(peer);
    peer.send({ flags: 'S', sequence: PEER_ISN });
    expect(lastPacket(peer).ttl).toBe(64);
  });

  it('a Windows host answers with TTL 128', () => {
    const peer = scriptedPeer('windows');
    listenOnDut(peer);
    peer.send({ flags: 'S', sequence: PEER_ISN });
    expect(lastPacket(peer).ttl).toBe(128);
  });

  it('a socket whose TTL was set sends its next segment with that TTL', () => {
    const peer = scriptedPeer();
    const { socket } = openPassive(peer);
    socket.setTtl(TimeToLive.of(7));
    socket.setNoDelay(true);
    socket.write('hello');
    expect(lastPacket(peer).ttl).toBe(7);
  });

  it('a listener\'s TTL is on the SYN-ACK and is inherited by the accepted socket', () => {
    const peer = scriptedPeer();
    const accepted: unknown[] = [];
    listenOnDut(peer, { onAccept: (socket) => { accepted.push(socket); }, ttl: TimeToLive.of(9) });
    peer.send({ flags: 'S', sequence: PEER_ISN });
    expect(lastPacket(peer).ttl).toBe(9);
    const synAck = peer.last()!;
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: synAck.sequence + 1 });
    expect(accepted).toHaveLength(1);
    expect(peer.dut.getTcpStack().listSockets()[0].ttl?.value).toBe(9);
  });

  it('an active open with a TTL puts it on the SYN', () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().connect(PEER_ADDRESS, peer.ports.peer, { ttl: TimeToLive.of(3) });
    expect(lastPacket(peer).ttl).toBe(3);
  });

  it.each([0, 256, 1.5, -1])('a TTL of %s is refused when the value is built', (value) => {
    expect(() => TimeToLive.of(value)).toThrow(RangeError);
  });
});

describe('the Differentiated Services field is the application\'s to set (RFC 9293 MUST-48, SHLD-21)', () => {
  it('WITNESS: a segment carries a zero field by default', () => {
    const peer = scriptedPeer();
    openPassive(peer);
    expect(lastPacket(peer).tos).toBe(0);
  });

  it('a socket whose field was set sends it, and it can change during the connection', () => {
    const peer = scriptedPeer();
    const { socket } = openPassive(peer);
    socket.setNoDelay(true);
    socket.setDiffServ(DiffServField.fromDscp(46));
    socket.write('one');
    expect(lastPacket(peer).tos).toBe(0xb8);
    socket.setDiffServ(DiffServField.fromDscp(10));
    socket.write('two');
    expect(lastPacket(peer).tos).toBe(0x28);
  });

  it('a listener\'s field is on the SYN-ACK', () => {
    const peer = scriptedPeer();
    listenOnDut(peer, { onAccept: () => {}, diffServ: DiffServField.fromDscp(26) });
    peer.send({ flags: 'S', sequence: PEER_ISN });
    expect(lastPacket(peer).tos).toBe(26 << 2);
  });

  it('an active open with a field puts it on the SYN', () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().connect(PEER_ADDRESS, peer.ports.peer, { diffServ: DiffServField.fromDscp(34) });
    expect(lastPacket(peer).tos).toBe(34 << 2);
  });

  it.each([-1, 256, 2.5])('a field of %s is refused when the value is built', (value) => {
    expect(() => DiffServField.of(value)).toThrow(RangeError);
  });

  it('a DSCP of 63 fills the six high bits', () => {
    expect(DiffServField.fromDscp(63).value).toBe(0xfc);
    expect(DiffServField.of(0xb8).dscp).toBe(46);
  });
});

function intoTimeWait(peer: ScriptedPeer) {
  const connection = openPassive(peer);
  connection.socket.close();
  const fin = peer.last()!;
  peer.send({
    flags: 'FA', sequence: connection.peerIsn + 1, acknowledgement: fin.sequence + 1,
  });
  peer.clear();
  return { connection, finSequence: fin.sequence };
}

describe('a new SYN reopens a connection lingering in TIME-WAIT (RFC 9293 §3.6.1, MAY-2)', () => {
  it('WITNESS: the actively closed connection lingers in TIME-WAIT for 2 MSL', () => {
    const peer = scriptedPeer();
    const { connection } = intoTimeWait(peer);
    expect(connection.socket.state).toBe('time-wait');
    peer.advance(TCP_TIME_WAIT_MS - 1);
    expect(connection.socket.state).toBe('time-wait');
  });

  it('a SYN beyond RCV.NXT is answered with a SYN-ACK whose number is above everything the old incarnation used', () => {
    const peer = scriptedPeer();
    const { connection, finSequence } = intoTimeWait(peer);
    peer.send({ flags: 'S', sequence: connection.peerIsn + 1 + 1 + 5000 });
    const reply = peer.last()!;
    expect(lettersOf(reply.flags)).toBe('SA');
    expect(((reply.sequence - finSequence) >>> 0) < 2 ** 31).toBe(true);
    expect(((reply.sequence - finSequence) >>> 0) > 0).toBe(true);
    expect(connection.socket.state).toBe('closed');
  });

  it('the reopened connection completes its handshake', () => {
    const peer = scriptedPeer();
    const { connection } = intoTimeWait(peer);
    peer.dut.getTcpStack().closeListener(peer.ports.dut);
    const accepted: unknown[] = [];
    listenOnDut(peer, { onAccept: (socket) => { accepted.push(socket); } });
    const newIsn = connection.peerIsn + 1 + 1 + 5000;
    peer.send({ flags: 'S', sequence: newIsn });
    const synAck = peer.last()!;
    peer.send({ flags: 'A', sequence: newIsn + 1, acknowledgement: synAck.sequence + 1 });
    expect(accepted).toHaveLength(1);
    expect(peer.dut.getTcpStack().listSockets().map((s) => s.state)).toEqual(['established']);
  });

  it('an old duplicate SYN, at or below RCV.NXT, leaves the connection in TIME-WAIT', () => {
    const peer = scriptedPeer();
    const { connection } = intoTimeWait(peer);
    peer.send({ flags: 'S', sequence: connection.peerIsn });
    expect(peer.replies.map((s) => lettersOf(s.flags))).not.toContain('SA');
    expect(connection.socket.state).toBe('time-wait');
  });

  it('without a listener on the port a new SYN does not reopen it', () => {
    const peer = scriptedPeer();
    const { connection } = intoTimeWait(peer);
    peer.dut.getTcpStack().closeListener(peer.ports.dut);
    peer.send({ flags: 'S', sequence: connection.peerIsn + 1 + 1 + 5000 });
    expect(peer.replies.map((s) => lettersOf(s.flags))).not.toContain('SA');
    expect(connection.socket.state).toBe('time-wait');
  });
});
