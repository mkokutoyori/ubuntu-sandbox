/**
 * Sur une machine Linux, TCP renonce quand le noyau 5.15 renoncerait, et cela
 * se regle comme chez lui : tcp_syn_retries, tcp_synack_retries, tcp_retries1
 * et tcp_retries2.
 *
 * Mesure de depart (commit precedent), pair SCRIPTE muet :
 *
 *   - `sysctl net.ipv4.tcp_syn_retries`, `tcp_synack_retries`, `tcp_retries1`
 *     et `tcp_retries2` : « cannot stat /proc/sys/net/ipv4/… » ;
 *   - une ouverture active vers un pair muet envoyait des SYN a 0, 1, 3, 7,
 *     15, 31, 63 et 123 s (le dernier intervalle plafonne a 60 s) et
 *     renoncait a 180 s ; un noyau envoie sept SYN, le dernier a 63 s, et
 *     renonce a 127 s ;
 *   - des donnees sans reponse faisaient renoncer a 100 s ; le noyau attend
 *     924,6 s ;
 *   - un SYN-ACK sans reponse etait traite comme un SYN, 180 s ; le noyau
 *     abandonne l'embryon a 63 s ;
 *   - R1 (l'application est avertie, le prochain saut est remis en cause) tombait a
 *     la troisieme retransmission, 7 s ; le noyau le mesure en temps, 3 s ;
 *   - le plafond du RTO etait de 60 s, celui du noyau (TCP_RTO_MAX) de 120 s.
 *
 * Autorite : noyau 5.15, `Documentation/networking/ip-sysctl.rst` (« Default
 * value is 6, which corresponds to 63 seconds till the last retransmission ...
 * the final timeout for an active TCP connection attempt will happen after 127
 * seconds » ; synack_retries 5, 63 s ; retries2 15, « a hypothetical timeout of
 * 924.6 seconds » ; retries2 8 pour « at least 100 seconds » de la RFC 1122 ;
 * retries1 3), `net/ipv4/tcp_timer.c` (`tcp_write_timeout` : un SYN renonce,
 * quand le RTO se declenche, si `icsk_retransmits >= tcp_syn_retries`, des
 * donnees quand `retransmits_timed_out(tcp_retries2, icsk_user_timeout)` ;
 * `tcp_model_timeout` : `((2 << n) - 1) * TCP_RTO_MIN` jusqu'a ilog2(TCP_RTO_MAX / TCP_RTO_MIN) = 9,
 * puis TCP_RTO_MAX par retransmission de plus), `net/ipv4/inet_connection_sock.c`
 * (`reqsk_timer_handler` : le SYN-ACK suit `tcp_synack_retries`, delais
 * TCP_TIMEOUT_INIT << n plafonnes a TCP_RTO_MAX), `sysctl_net_ipv4.c`
 * (tcp_syn_retries de 1 a 127, les trois autres un octet), lus. RFC 9293
 * §3.8.3 (R1, R2 ; MUST-21 : l'application regle R2 ; MUST-23 : au moins
 * trois minutes pour un SYN) : le reglage par defaut du noyau (6, soit 127 s)
 * ne s'y conforme pas, il faut tcp_syn_retries >= 7 (247 s). Sur une machine
 * Linux la mesure du noyau gouverne : c'est elle que compare la transcription
 * d'un cours ; un hote qui ne declare rien garde les seuils de la RFC.
 *
 * Ce qui est construit : `TcpRetryPolicy` (valeur initiale et plafond du RTO ;
 * pour une ouverture active, passive, une connexion etablie et R1 : un nombre
 * de retransmissions ou une duree), lue par la pile a chaque declenchement
 * du RTO ; `TcpHost.retryPolicy`, que `LinuxMachine` remplit depuis les quatre
 * reglages de `LinuxIpv4Settings` (la duree de tcp_retries1 et tcp_retries2
 * est le modele du noyau, `modelledRetransmitTimeoutMs`) ; la minuterie de
 * persistance plafonne au meme RTO maximal. Le seuil par connexion
 * (`setUserTimeout`) passe toujours avant, comme icsk_user_timeout.
 *
 * Ce qui n'est PAS construit : tcp_orphan_retries (la pile n'a pas de notion de
 * socket orphelin : `close()` n'y est que l'envoi du FIN) et tcp_fin_timeout (idem :
 * FIN-WAIT-2 n'a pas de minuterie), tcp_keepalive_time/intvl/probes (aucune
 * application du depot n'active SO_KEEPALIVE), la reduction de
 * tcp_synack_retries quand la file des embryons se remplit, le plancher de RTO de
 * 200 ms de Linux (la pile garde la seconde de la RFC 6298 §2.4) ; Windows
 * garde les seuils de la RFC faute de pouvoir sourcer les siens.
 *
 * Discrimination (fichier copie sur le commit precedent, avec le seul fichier
 * `TcpRetryPolicy.ts` que le cas de modele importe) : VINGT cas sur vingt-quatre
 * tombent. Les quatre autres passent des deux cotes : deux TEMOINS (un hote
 * sans seuils propres garde trois minutes pour un SYN et cent secondes pour
 * des donnees), une NON-REGRESSION (le seuil par connexion passe avant le
 * reglage) et un cas STRUCTUREL (la fonction du modele du noyau, qui n'a pas
 * d'etat).
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openPassive, PEER_ISN, PEER_ADDRESS, type ScriptedPeer,
} from '../../support/tcpScriptedPeer';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { modelledRetransmitTimeoutMs } from '@/network/tcp/TcpRetryPolicy';

const PROC = '/proc/sys/net/ipv4';

async function write(peer: ScriptedPeer, key: string, value: number | string): Promise<string> {
  return peer.dut.executeCommand(`sudo sysctl -w net.ipv4.${key}=${value}`);
}

function connectToSilence(peer: ScriptedPeer): TcpSocket {
  const socket = peer.dut.getTcpStack().connect(PEER_ADDRESS, peer.ports.peer)!;
  peer.take();
  return socket;
}

function synsOverTime(peer: ScriptedPeer, socket: TcpSocket, untilMs: number): { sent: number[]; closedAtMs: number | null } {
  const sent = [0];
  let closedAtMs: number | null = null;
  for (let elapsed = 100; elapsed <= untilMs; elapsed += 100) {
    peer.advance(100);
    for (const segment of peer.take()) if (segment.flags.syn) sent.push(elapsed);
    if (socket.closed && closedAtMs === null) closedAtMs = elapsed;
    if (closedAtMs !== null) break;
  }
  return { sent, closedAtMs };
}

function listenAndSendSyn(peer: ScriptedPeer): TcpSocket[] {
  const accepted: TcpSocket[] = [];
  peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: (socket) => { accepted.push(socket); } });
  peer.send({ flags: 'S', sequence: PEER_ISN, window: 65535 });
  return accepted;
}

function embryonicCount(peer: ScriptedPeer): number {
  return peer.dut.getTcpStack().listSockets().filter((socket) => socket.state === 'syn-received').length;
}

describe('the Linux retransmission knobs read and write like the kernel 5.15 (ip-sysctl.rst, sysctl_net_ipv4.c)', () => {
  it.each([
    ['tcp_syn_retries', 6], ['tcp_synack_retries', 5], ['tcp_retries1', 3], ['tcp_retries2', 15],
  ])('net.ipv4.%s reads %s by default, through sysctl and through /proc', async (key, expected) => {
    const peer = scriptedPeer();
    expect((await peer.dut.executeCommand(`sysctl net.ipv4.${key}`)).trim()).toBe(`net.ipv4.${key} = ${expected}`);
    expect((await peer.dut.executeCommand(`cat ${PROC}/${key}`)).trim()).toBe(String(expected));
  });

  it('tcp_syn_retries is 1 to 127, as the kernel table bounds it', async () => {
    const peer = scriptedPeer();
    expect((await write(peer, 'tcp_syn_retries', 127)).trim()).toBe('net.ipv4.tcp_syn_retries = 127');
    expect((await write(peer, 'tcp_syn_retries', 1)).trim()).toBe('net.ipv4.tcp_syn_retries = 1');
    expect(await write(peer, 'tcp_syn_retries', 0)).toContain('Invalid argument');
    expect(await write(peer, 'tcp_syn_retries', 128)).toContain('Invalid argument');
    expect((await peer.dut.executeCommand('sysctl -n net.ipv4.tcp_syn_retries')).trim()).toBe('1');
  });

  it.each(['tcp_synack_retries', 'tcp_retries1', 'tcp_retries2'])('%s is one byte: 0 and 255, not 256', async (key) => {
    const peer = scriptedPeer();
    expect((await write(peer, key, 0)).trim()).toBe(`net.ipv4.${key} = 0`);
    expect((await write(peer, key, 255)).trim()).toBe(`net.ipv4.${key} = 255`);
    expect(await write(peer, key, 256)).toContain('Invalid argument');
    expect(await write(peer, key, -1)).toContain('Invalid argument');
  });

  it('written through /proc as well: the attempt that follows dies at 3 s', async () => {
    const peer = scriptedPeer();
    await peer.dut.executeCommand(`sudo sh -c 'echo 1 > ${PROC}/tcp_syn_retries'`);
    const socket = connectToSilence(peer);
    expect(synsOverTime(peer, socket, 20_000).closedAtMs).toBe(3_000);
  });
});

describe('an active open gives up after tcp_syn_retries retransmissions, at the next timeout (RTO 1 s, doubling)', () => {
  it('default 6: SYNs at 0, 1, 3, 7, 15, 31 and 63 s, the attempt dies at 127 s', () => {
    const peer = scriptedPeer();
    const socket = connectToSilence(peer);
    const { sent, closedAtMs } = synsOverTime(peer, socket, 200_000);
    expect(sent).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 63_000]);
    expect(closedAtMs).toBe(127_000);
    expect(socket.closeReason).toBe('timeout');
  });

  it('tcp_syn_retries=2: SYNs at 0, 1 and 3 s, dead at 7 s', async () => {
    const peer = scriptedPeer();
    await write(peer, 'tcp_syn_retries', 2);
    const socket = connectToSilence(peer);
    const { sent, closedAtMs } = synsOverTime(peer, socket, 20_000);
    expect(sent).toEqual([0, 1_000, 3_000]);
    expect(closedAtMs).toBe(7_000);
  });

  it('tcp_syn_retries=1: SYNs at 0 and 1 s, dead at 3 s', async () => {
    const peer = scriptedPeer();
    await write(peer, 'tcp_syn_retries', 1);
    const socket = connectToSilence(peer);
    const { sent, closedAtMs } = synsOverTime(peer, socket, 20_000);
    expect(sent).toEqual([0, 1_000]);
    expect(closedAtMs).toBe(3_000);
  });

  it('tcp_syn_retries=7 meets the three minutes of RFC 9293 MUST-23: the timeout is capped at 120 s, dead at 247 s', async () => {
    const peer = scriptedPeer();
    await write(peer, 'tcp_syn_retries', 7);
    const socket = connectToSilence(peer);
    const { sent, closedAtMs } = synsOverTime(peer, socket, 400_000);
    expect(sent).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 63_000, 127_000]);
    expect(closedAtMs).toBe(247_000);
  });

  it('the knob is read at each timeout: lowering it while the attempt runs shortens it', async () => {
    const peer = scriptedPeer();
    const socket = connectToSilence(peer);
    peer.advance(500);
    await write(peer, 'tcp_syn_retries', 1);
    const { closedAtMs } = synsOverTime(peer, socket, 20_000);
    expect(closedAtMs).toBe(2_500);
  });

  it('WITNESS: a host that declares no policy keeps the RFC 9293 minimum of three minutes', () => {
    const peer = scriptedPeer('windows');
    const socket = connectToSilence(peer);
    peer.advance(179_000);
    expect(socket.state).toBe('syn-sent');
    peer.advance(3_000);
    expect(socket.closed).toBe(true);
  });
});

describe('a passive open gives up after tcp_synack_retries retransmissions of the SYN-ACK', () => {
  it('default 5: SYN-ACKs at 0, 1, 3, 7, 15 and 31 s, the half-open connection is dropped at 63 s', () => {
    const peer = scriptedPeer();
    listenAndSendSyn(peer);
    const synAcks = peer.take().filter((segment) => segment.flags.syn && segment.flags.ack).length;
    let total = synAcks;
    peer.advance(62_000);
    total += peer.take().filter((segment) => segment.flags.syn && segment.flags.ack).length;
    expect(total).toBe(6);
    expect(embryonicCount(peer)).toBe(1);
    peer.advance(2_000);
    expect(embryonicCount(peer)).toBe(0);
  });

  it('tcp_synack_retries=1: two SYN-ACKs, dropped at 3 s', async () => {
    const peer = scriptedPeer();
    await write(peer, 'tcp_synack_retries', 1);
    listenAndSendSyn(peer);
    let total = peer.take().filter((segment) => segment.flags.syn && segment.flags.ack).length;
    peer.advance(2_900);
    total += peer.take().filter((segment) => segment.flags.syn && segment.flags.ack).length;
    expect(total).toBe(2);
    expect(embryonicCount(peer)).toBe(1);
    peer.advance(200);
    expect(embryonicCount(peer)).toBe(0);
  });
});

describe('an established connection gives up when the retransmissions have lasted long enough (tcp_retries2)', () => {
  function withUnackedData(peer: ScriptedPeer): TcpSocket {
    const connection = openPassive(peer);
    connection.socket.send('hello');
    return connection.socket;
  }

  it('the model of the kernel: 15 gives 924.6 s, 8 gives the 102.2 s that RFC 1122 asks for, 3 gives 3 s', () => {
    expect(modelledRetransmitTimeoutMs(15, 200, 120_000)).toBe(924_600);
    expect(modelledRetransmitTimeoutMs(8, 200, 120_000)).toBe(102_200);
    expect(modelledRetransmitTimeoutMs(3, 200, 120_000)).toBe(3_000);
    expect(modelledRetransmitTimeoutMs(0, 200, 120_000)).toBe(200);
  });

  it('default 15: the connection survives 924 seconds of silence and is gone at 924.6', () => {
    const peer = scriptedPeer();
    const socket = withUnackedData(peer);
    peer.advance(924_000);
    expect(socket.state).toBe('established');
    peer.advance(1_000);
    expect(socket.closed).toBe(true);
    expect(socket.closeReason).toBe('timeout');
  });

  it('tcp_retries2=8: gone at 102.2 seconds, the least RFC 1122 recommends', async () => {
    const peer = scriptedPeer();
    await write(peer, 'tcp_retries2', 8);
    const socket = withUnackedData(peer);
    peer.advance(102_000);
    expect(socket.state).toBe('established');
    peer.advance(500);
    expect(socket.closed).toBe(true);
  });

  it('the application still decides for its own connection: a user timeout beats the knob (MUST-21)', async () => {
    const peer = scriptedPeer();
    await write(peer, 'tcp_retries2', 30);
    const socket = withUnackedData(peer);
    socket.setUserTimeout(20_000);
    peer.advance(19_000);
    expect(socket.state).toBe('established');
    peer.advance(1_500);
    expect(socket.closed).toBe(true);
  });

  it('WITNESS: a host that declares no policy keeps the 100 seconds of RFC 9293 SHLD-11', () => {
    const peer = scriptedPeer('windows');
    const socket = withUnackedData(peer);
    peer.advance(99_000);
    expect(socket.state).toBe('established');
    peer.advance(2_000);
    expect(socket.closed).toBe(true);
  });
});

describe('the delivery problem is reported to the application once tcp_retries1 has elapsed (RFC 9293 SHLD-9)', () => {
  function reportsOf(socket: TcpSocket): number[] {
    const reported: number[] = [];
    socket.onErrorReport((report) => { if (report.source === 'retransmission') reported.push(report.attempts); });
    return reported;
  }

  it('default 3: nothing before 3 seconds of retransmission, one report after', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    const reports = reportsOf(connection.socket);
    connection.socket.send('hello');
    peer.advance(2_900);
    expect(reports.length).toBe(0);
    peer.advance(200);
    expect(reports.length).toBe(1);
    peer.advance(60_000);
    expect(reports.length).toBe(1);
  });

  it('tcp_retries1=5 waits 12.6 seconds: the report comes with the retransmission that follows, at 15 s', async () => {
    const peer = scriptedPeer();
    await write(peer, 'tcp_retries1', 5);
    const connection = openPassive(peer);
    const reports = reportsOf(connection.socket);
    connection.socket.send('hello');
    peer.advance(14_900);
    expect(reports.length).toBe(0);
    peer.advance(200);
    expect(reports.length).toBe(1);
  });
});
