/**
 * L'option MSS annonce ce que l'interface sait recevoir, et la taille de
 * segment effective est la plus petite de celle du pair et de celle de
 * l'interface.
 *
 * Mesure de depart (commit precedent), pair SCRIPTE :
 *
 *   - un SYN annoncait toujours 1460, quelle que soit la MTU de
 *     l'interface (1360 attendus sur 1400, 8960 sur 9000) ;
 *   - sans option MSS dans le SYN du pair, la pile gardait 1460 au lieu de
 *     l'hypothese de 536 octets (IPv4) ou 1220 (IPv6) que la RFC impose ;
 *   - un pair qui annonce 1460 sur une interface de 1400 octets obtenait
 *     des segments de 1460 : la pile les construisait puis les voyait
 *     rebondir au lieu de ne jamais les construire ;
 *   - la fenetre de congestion initiale etait calculee pour 1460 octets
 *     (4380) meme quand la taille negociee etait de 536 : huit segments
 *     partaient dans la premiere volee, la ou la RFC 5681 §3.1 en admet
 *     quatre (2144 octets).
 *
 * Autorite : RFC 9293 §3.7.1 (« If an MSS Option is not received at
 * connection setup, TCP implementations MUST assume a default send MSS of
 * 536 (576 - 40) for IPv4 or 1220 (1280 - 60) for IPv6 » MUST-15 ; « The
 * "effective send MSS" MUST be the smaller (MUST-16) of the send MSS ... and
 * the largest transmission size permitted by the IP layer » ; « The MSS
 * value to be sent in an MSS Option must be less than or equal to MMS_R - 20
 * » MUST-67) et RFC 5681 §3.1 (IW selon SMSS : « If SMSS <= 1095 bytes, then
 * IW = 4 * SMSS bytes and MUST NOT be more than 4 segments »).
 *
 * Ce qui est construit : `TcpSegmentSize` (taille par defaut 536/1220,
 * `mssForMtu` = MTU - en-tete IP - en-tete TCP, ecrite une fois et lue aussi
 * par la decouverte de MTU de chemin, qui la reecrivait) ; la MTU est celle
 * de l'interface de sortie, 65 536 pour la boucle locale ; le SYN-ACK annonce
 * ce que NOUS recevons (et non le minimum avec le pair, qui est ce que NOUS
 * envoyons) ; la fenetre de congestion est reinitialisee des que la taille
 * est negociee, avant toute donnee.
 *
 * Discrimination (fichier copie sur le commit precedent) : SIX cas sur neuf tombent.
 * Les TROIS autres passent des deux cotes : le TEMOIN de la MTU de 1500, la
 * NON-REGRESSION d'un ecouteur plafonne par `maxSegmentSize` (TCP_MAXSEG) et
 * le TEMOIN d'un pair qui annonce 1000. Nagle est coupe (`setNoDelay`) dans
 * les cas qui comptent les segments : sans cela le dernier segment court
 * attend un ACK que le pair scripte ne donne pas, et la mesure porterait sur
 * Nagle et non sur la taille.
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openPassive, openActive, PEER_ADDRESS, PEER_ISN, type ScriptedPeer,
} from '../../support/tcpScriptedPeer';
import type { TcpOption } from '@/network/tcp/types';
import { initialCongestionWindow } from '@/network/tcp/TcpCongestionControl';

function mssOf(options: readonly TcpOption[]): number | undefined {
  const option = options.find((o): o is Extract<TcpOption, { kind: 'mss' }> => o.kind === 'mss');
  return option?.value;
}

function dataSizes(peer: ScriptedPeer): number[] {
  return peer.replies.filter((s) => s.payload !== undefined).map((s) => String(s.payload).length);
}

function attemptedDataSizes(peer: ScriptedPeer): number[] {
  const sizes: number[] = [];
  peer.bus.subscribe('tcp.segment.sent', (event) => {
    if (event.payload.payloadSize > 0) sizes.push(event.payload.payloadSize);
  });
  return sizes;
}

describe('the MSS option announces what the interface can receive (RFC 9293 §3.7.1, MUST-67, SHLD-6)', () => {
  it('WITNESS: on a 1500-byte interface a SYN announces 1460', () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().connect(PEER_ADDRESS, peer.ports.peer);
    expect(mssOf(peer.last()!.options)).toBe(1460);
  });

  it('on a 1400-byte interface a SYN announces 1360', () => {
    const peer = scriptedPeer();
    peer.dut.getPort('eth0')!.setMTU(1400);
    peer.dut.getTcpStack().connect(PEER_ADDRESS, peer.ports.peer);
    expect(mssOf(peer.last()!.options)).toBe(1360);
  });

  it('on a 9000-byte interface a SYN-ACK announces 8960', () => {
    const peer = scriptedPeer();
    peer.dut.getPort('eth0')!.setMTU(9000);
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: () => undefined });
    peer.send({ flags: 'S', sequence: PEER_ISN, options: [{ kind: 'mss', value: 1460 }] });
    expect(mssOf(peer.last()!.options)).toBe(8960);
  });

  it('NON-REGRESSION: a listener capped with TCP_MAXSEG announces the cap', () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: () => undefined, maxSegmentSize: 1000 });
    peer.send({ flags: 'S', sequence: PEER_ISN, options: [{ kind: 'mss', value: 1460 }] });
    expect(mssOf(peer.last()!.options)).toBe(1000);
  });
});

describe('the effective send MSS is the smaller of the peer\'s MSS and the interface (RFC 9293 §3.7.1, MUST-15, MUST-16)', () => {
  it('no MSS option in the peer\'s SYN: the default send MSS of 536 applies (passive open)', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, []);
    connection.socket.setNoDelay(true);
    connection.socket.send('x'.repeat(1500));
    expect(dataSizes(peer)).toEqual([536, 536, 428]);
  });

  it('no MSS option in the peer\'s SYN-ACK: the default send MSS of 536 applies (active open)', () => {
    const peer = scriptedPeer();
    const connection = openActive(peer, []);
    connection.socket.setNoDelay(true);
    connection.socket.send('x'.repeat(1500));
    expect(dataSizes(peer)).toEqual([536, 536, 428]);
  });

  it('WITNESS: a peer offering 1000 is obeyed', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, [{ kind: 'mss', value: 1000 }]);
    connection.socket.setNoDelay(true);
    connection.socket.send('x'.repeat(2500));
    expect(dataSizes(peer)).toEqual([1000, 1000, 500]);
  });

  it('a peer offering 1460 cannot make a 1400-byte interface carry more than 1360', () => {
    const peer = scriptedPeer();
    peer.dut.getPort('eth0')!.setMTU(1400);
    const connection = openPassive(peer, [{ kind: 'mss', value: 1460 }]);
    const attempted = attemptedDataSizes(peer);
    connection.socket.setNoDelay(true);
    connection.socket.send('x'.repeat(3000));
    expect(attempted.length).toBeGreaterThan(0);
    expect(Math.max(...attempted)).toBe(1360);
  });

  it('the initial window counts segments of the negotiated size, not of a size nobody agreed to', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, []);
    expect(connection.socket.cc.cwnd).toBe(initialCongestionWindow(536));
    connection.socket.setNoDelay(true);
    connection.socket.send('x'.repeat(10_000));
    expect(dataSizes(peer).length).toBe(4);
  });
});
