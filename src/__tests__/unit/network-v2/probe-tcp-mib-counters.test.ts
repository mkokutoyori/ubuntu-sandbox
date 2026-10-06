/**
 * Le groupe TCP de /proc/net/snmp et `netstat -s` (Linux et Windows) disent ce
 * que la pile a fait : elle seule sait quand une connexion s'ouvre, echoue, est
 * remise a zero, quand un segment part, est recu, est retransmis.
 *
 * Mesure de depart (commit precedent), un hote face a un pair SCRIPTE :
 *
 *   - ActiveOpens, PassiveOpens, AttemptFails, EstabResets, RetransSegs, InErrs
 *     et OutRsts ne bougeaient jamais : zero apres une ouverture, un RST recu,
 *     une retransmission, un segment au checksum faux ; InCsumErrors etait un
 *     zero ecrit en dur dans la ligne ;
 *   - CurrEstab venait de la table des prises (ESTABLISHED seulement, sans
 *     CLOSE-WAIT, et rien dans un laboratoire dont la machine n'est pas branchee
 *     au bus) ;
 *   - InSegs et OutSegs etaient comptes par la couche IP de l'hote, pour l'IPv4
 *     seul : ni une connexion qui ne quitte pas la machine (sa propre adresse),
 *     ni l'IPv6 ne s'y voyaient.
 *
 * Autorite : RFC 4022 (docs lues) : tcpActiveOpens (CLOSED -> SYN-SENT),
 * tcpPassiveOpens (LISTEN -> SYN-RCVD), tcpAttemptFails (SYN-SENT ou SYN-RCVD ->
 * CLOSED, ou SYN-RCVD -> LISTEN), tcpEstabResets (ESTABLISHED ou CLOSE-WAIT ->
 * CLOSED), tcpCurrEstab (ESTABLISHED ou CLOSE-WAIT), tcpInSegs « including those
 * received in error », tcpOutSegs « excluding those containing only retransmitted
 * octets », tcpRetransSegs, tcpInErrs (« e.g., bad TCP checksums »), tcpOutRsts.
 * Noyau 5.15 : `tcp_transmit_skb` ne compte OutSegs que si le segment porte du
 * neuf ou ne porte rien (`after(end_seq, snd_nxt) || seq == end_seq`),
 * `__tcp_retransmit_skb` compte RetransSegs, `tcp_v4_rcv` compte InSegs « even if
 * it's bad » et un mauvais checksum fait InErrs ET InCsumErrors, `tcp_v4_send_reset`
 * compte OutSegs et OutRsts. Windows (`MIB_TCPSTATS_LH`) : dwOutSegs « does not
 * include retransmitted segments ».
 *
 * Ce qui est construit : `TcpMibSink`, que la pile appelle sur ses propres
 * evenements (une transition d'etat, une retransmission, un segment envoye ou recu,
 * un RST envoye, un checksum faux) et que `EndHost` branche sur les compteurs de la
 * machine ; `tcpCurrEstab` est une jauge tenue par ces transitions et `snmpSnapshot`
 * la lit ; les deux increments de la couche IP de l'hote disparaissent.
 *
 * Discrimination (fichier copie sur le commit precedent) : DIX cas sur douze
 * tombent. Les deux autres passent des deux cotes : une NON-REGRESSION (les segments
 * de la poignee de main, deux envoyes et un recu, etaient deja comptes) et un TEMOIN
 * (une fermeture normale n'est pas une remise a zero).
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openActive, openPassive, flagsFrom, PEER_ISN, PEER_ADDRESS, DUT_ADDRESS, type ScriptedPeer,
} from '../../support/tcpScriptedPeer';
import { IPAddress, createIPv4Packet, IP_PROTO_TCP } from '@/network/core/types';
import { type TcpSegment } from '@/network/tcp/types';
import { optionsDataOffset } from '@/network/tcp/TcpOptionsCodec';

async function tcpMib(peer: ScriptedPeer): Promise<Record<string, number>> {
  const snmp = await peer.dut.executeCommand('cat /proc/net/snmp');
  const lines = snmp.split('\n').filter((line) => line.startsWith('Tcp:'));
  const names = lines[0].split(' ').slice(1);
  const values = lines[1].split(' ').slice(1).map(Number);
  return Object.fromEntries(names.map((name, index) => [name, values[index]]));
}

function windowsLine(output: string, label: string): number {
  const line = output.split('\n').find((candidate) => candidate.includes(label));
  return Number(line!.split('=')[1].trim());
}

describe('the TCP group of /proc/net/snmp counts what the stack does (RFC 1213 tcp group, RFC 4022)', () => {
  it('an active open counts ActiveOpens and one established connection', async () => {
    const peer = scriptedPeer();
    openActive(peer);
    const mib = await tcpMib(peer);
    expect(mib.ActiveOpens).toBe(1);
    expect(mib.CurrEstab).toBe(1);
    expect(mib.PassiveOpens).toBe(0);
  });

  it('a passive open counts PassiveOpens', async () => {
    const peer = scriptedPeer();
    openPassive(peer);
    const mib = await tcpMib(peer);
    expect(mib.PassiveOpens).toBe(1);
    expect(mib.CurrEstab).toBe(1);
    expect(mib.ActiveOpens).toBe(0);
  });

  it('the segments of the handshake are counted in both directions: SYN and ACK out, SYN-ACK in', async () => {
    const peer = scriptedPeer();
    openActive(peer);
    const mib = await tcpMib(peer);
    expect(mib.OutSegs).toBe(2);
    expect(mib.InSegs).toBe(1);
  });

  it('a SYN nobody answers is one failed attempt, after tcp_syn_retries retransmissions', async () => {
    const peer = scriptedPeer();
    await peer.dut.executeCommand('sudo sysctl -w net.ipv4.tcp_syn_retries=1');
    peer.dut.getTcpStack().connect(PEER_ADDRESS, peer.ports.peer);
    peer.advance(3_000);
    const mib = await tcpMib(peer);
    expect(mib.ActiveOpens).toBe(1);
    expect(mib.AttemptFails).toBe(1);
    expect(mib.RetransSegs).toBe(1);
    expect(mib.CurrEstab).toBe(0);
  });

  it('a RST received on an established connection counts EstabResets and empties CurrEstab', async () => {
    const peer = scriptedPeer();
    const connection = openActive(peer);
    peer.send({ flags: 'RA', sequence: connection.peerIsn + 1, acknowledgement: connection.dutIsn + 1 });
    const mib = await tcpMib(peer);
    expect(mib.EstabResets).toBe(1);
    expect(mib.CurrEstab).toBe(0);
  });

  it('a normal close is not a reset: CurrEstab falls, EstabResets stays at zero', async () => {
    const peer = scriptedPeer();
    const connection = openActive(peer);
    connection.socket.close();
    const fin = peer.last()!;
    peer.send({ flags: 'FA', sequence: connection.peerIsn + 1, acknowledgement: fin.sequence + 1 });
    peer.advance(1);
    const mib = await tcpMib(peer);
    expect(mib.EstabResets).toBe(0);
    expect(mib.CurrEstab).toBe(0);
  });

  it('a segment for a port nobody listens on is answered with a RST, counted in OutRsts', async () => {
    const peer = scriptedPeer();
    peer.send({ flags: 'S', sequence: PEER_ISN, destinationPort: 9 });
    const mib = await tcpMib(peer);
    expect(mib.OutRsts).toBe(1);
    expect(mib.InSegs).toBe(1);
    expect(mib.OutSegs).toBe(1);
  });

  it('a segment retransmitted by the timer is counted in RetransSegs', async () => {
    const peer = scriptedPeer();
    const connection = openActive(peer);
    connection.socket.setNoDelay(true);
    connection.socket.send('x');
    peer.advance(600);
    const mib = await tcpMib(peer);
    expect(mib.RetransSegs).toBe(2);
    expect(mib.OutSegs).toBe(3);
  });

  it('a segment with a bad checksum is an error and a checksum error, and was still received', async () => {
    const peer = scriptedPeer();
    const segment: TcpSegment = {
      type: 'tcp', sourcePort: peer.ports.peer, destinationPort: peer.ports.dut, sequence: PEER_ISN, acknowledgement: 0,
      dataOffset: optionsDataOffset([]), flags: flagsFrom('S'), window: 65535, checksum: 0xdead,
      urgentPointer: 0, options: [], payload: undefined,
    };
    peer.sendIpv4(createIPv4Packet(
      new IPAddress(PEER_ADDRESS), new IPAddress(DUT_ADDRESS), IP_PROTO_TCP, 64, segment, segment.dataOffset * 4));
    const mib = await tcpMib(peer);
    expect(mib.InErrs).toBe(1);
    expect(mib.InCsumErrors).toBe(1);
    expect(mib.InSegs).toBe(1);
  });

  it('a connection that never leaves the machine is counted as sent and as received', async () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().listen(8080, { onAccept: () => {} });
    peer.dut.getTcpStack().connect(DUT_ADDRESS, 8080);
    const mib = await tcpMib(peer);
    expect(mib.ActiveOpens).toBe(1);
    expect(mib.PassiveOpens).toBe(1);
    expect(mib.CurrEstab).toBe(2);
    expect(mib.OutSegs).toBe(3);
    expect(mib.InSegs).toBe(3);
  });
});

describe('every view of the counters says the same: /proc/net/snmp, netstat -s on Linux, netstat -s on Windows', () => {
  it('Linux: netstat -s agrees with /proc/net/snmp', async () => {
    const peer = scriptedPeer();
    const connection = openActive(peer);
    connection.socket.setNoDelay(true);
    connection.socket.send('x');
    peer.advance(250);
    const mib = await tcpMib(peer);
    const statistics = await peer.dut.executeCommand('netstat -s');
    expect(statistics).toContain(`${mib.ActiveOpens} active connection openings`);
    expect(statistics).toContain(`${mib.CurrEstab} connections established`);
    expect(statistics).toContain(`${mib.RetransSegs} segments retransmitted`);
    expect(mib.RetransSegs).toBeGreaterThan(0);
  });

  it('Windows: netstat -s counts the same events', async () => {
    const peer = scriptedPeer('windows');
    const connection = openActive(peer);
    connection.socket.setNoDelay(true);
    connection.socket.send('x');
    peer.advance(1_100);
    const statistics = await peer.dut.executeCommand('netstat -s -p tcp');
    expect(windowsLine(statistics, 'Active Opens')).toBe(1);
    expect(windowsLine(statistics, 'Current Connections')).toBe(1);
    expect(windowsLine(statistics, 'Segments Retransmitted')).toBe(1);
    expect(windowsLine(statistics, 'Segments Sent')).toBe(3);
  });
});
