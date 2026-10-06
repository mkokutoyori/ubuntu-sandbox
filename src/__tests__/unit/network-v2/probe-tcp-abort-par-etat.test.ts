/**
 * ABORT n'envoie un RST que dans les etats ou la RFC 9293 en envoie un. L'appel ABORT (section 3.10.5)
 * distingue trois cas : SYN-RECEIVED, ESTABLISHED, FIN-WAIT-1, FIN-WAIT-2 et CLOSE-WAIT envoient
 * `<SEQ=SND.NXT><CTL=RST>` ; SYN-SENT supprime le TCB sans rien emettre ; CLOSING, LAST-ACK et
 * TIME-WAIT repondent "ok" et suppriment le TCB, sans rien emettre non plus. Les segments en file
 * d'emission ou de retransmission sont abandonnes avec la connexion.
 *
 * Mesure de depart (origin/mandeng 75c5280d8), un LinuxPC face a un pair SCRIPTE : `abort()` emettait
 * un RST|ACK dans les neuf etats, y compris SYN-SENT, CLOSING, LAST-ACK et TIME-WAIT, ou la RFC n'en
 * veut aucun. Le seul appelant hors tests est `ss -K` (SOCK_DESTROY) : un `ss -K` sur une connexion
 * en attente de son dernier ACK mettait donc un segment de trop sur le fil, que le noyau n'emet pas
 * (`tcp_abort` n'appelle `tcp_send_active_reset` que si `tcp_need_reset(sk->sk_state)`, le meme
 * ensemble d'etats que la RFC).
 *
 * Autorite : RFC 9293 section 3.10.5, lue dans `docs/rfc/tcp/rfc9293.txt` ; noyau v5.15
 * (`tcp_abort`, `tcp_need_reset`), lu.
 *
 * Discrimination (fichier copie sur origin/mandeng 75c5280d8) : QUATRE cas sur onze tombent, ceux de
 * SYN-SENT, CLOSING, LAST-ACK et TIME-WAIT. Les sept autres passent des deux cotes : un TEMOIN (chaque
 * aide du banc atteint l'etat qu'elle nomme), cinq NON-REGRESSIONS (le RST des cinq etats synchronises
 * etait deja emis) et une STRUCTURELLE (`_teardown` arrete deja les temporisateurs, rien ne suit le
 * RST).
 */
import { describe, it, expect } from 'vitest';
import { scriptedPeer, openActive, PEER_ISN, type ScriptedPeer, type OpenConnection } from '../../support/tcpScriptedPeer';
import type { TcpSocket } from '@/network/tcp/TcpStack';

function resetsSentBy(peer: ScriptedPeer, action: () => void): number {
  peer.clear();
  action();
  return peer.take().filter((segment) => segment.flags.rst).length;
}

function established(peer: ScriptedPeer, allowHalfOpen = false): OpenConnection {
  return openActive(peer, [], PEER_ISN, 65535, { allowHalfOpen });
}

function inFinWait1(peer: ScriptedPeer): OpenConnection {
  const open = established(peer);
  open.socket.close();
  peer.clear();
  return open;
}

function inFinWait2(peer: ScriptedPeer): OpenConnection {
  const open = inFinWait1(peer);
  peer.send({ flags: 'A', sequence: open.peerIsn + 1, acknowledgement: open.dutIsn + 2 });
  peer.clear();
  return open;
}

function inCloseWait(peer: ScriptedPeer): OpenConnection {
  const open = established(peer, true);
  peer.send({ flags: 'FA', sequence: open.peerIsn + 1, acknowledgement: open.dutIsn + 1 });
  peer.clear();
  return open;
}

function inLastAck(peer: ScriptedPeer): OpenConnection {
  const open = inCloseWait(peer);
  open.socket.close();
  peer.clear();
  return open;
}

function inClosing(peer: ScriptedPeer): OpenConnection {
  const open = inFinWait1(peer);
  peer.send({ flags: 'FA', sequence: open.peerIsn + 1, acknowledgement: open.dutIsn + 1 });
  peer.clear();
  return open;
}

function inTimeWait(peer: ScriptedPeer): OpenConnection {
  const open = inFinWait1(peer);
  peer.send({ flags: 'FA', sequence: open.peerIsn + 1, acknowledgement: open.dutIsn + 2 });
  peer.clear();
  return open;
}

function inSynSent(peer: ScriptedPeer): TcpSocket {
  const socket = peer.dut.getTcpStack().connect(peer.addresses.peer, peer.ports.peer)!;
  peer.clear();
  return socket;
}

function inSynReceived(peer: ScriptedPeer): TcpSocket {
  peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: () => undefined });
  peer.send({ flags: 'S', sequence: PEER_ISN });
  peer.clear();
  return peer.dut.getTcpStack().listSockets().find((socket) => socket.state === 'syn-received')!;
}

describe('the bench is sound (witnesses)', () => {
  it('each helper reaches the state it names', () => {
    const states: Array<[string, (peer: ScriptedPeer) => TcpSocket]> = [
      ['established', (peer) => established(peer).socket],
      ['fin-wait-1', (peer) => inFinWait1(peer).socket],
      ['fin-wait-2', (peer) => inFinWait2(peer).socket],
      ['close-wait', (peer) => inCloseWait(peer).socket],
      ['last-ack', (peer) => inLastAck(peer).socket],
      ['closing', (peer) => inClosing(peer).socket],
      ['time-wait', (peer) => inTimeWait(peer).socket],
      ['syn-sent', inSynSent],
      ['syn-received', inSynReceived],
    ];
    for (const [name, reach] of states) {
      expect(reach(scriptedPeer()).state).toBe(name);
    }
  });
});

describe('ABORT sends a reset only where RFC 9293 section 3.10.5 sends one', () => {
  it.each([
    ['syn-received', inSynReceived],
    ['established', (peer: ScriptedPeer) => established(peer).socket],
    ['fin-wait-1', (peer: ScriptedPeer) => inFinWait1(peer).socket],
    ['fin-wait-2', (peer: ScriptedPeer) => inFinWait2(peer).socket],
    ['close-wait', (peer: ScriptedPeer) => inCloseWait(peer).socket],
  ] as const)('in %s the peer receives one reset', (_name, reach) => {
    const peer = scriptedPeer();
    const socket = reach(peer);
    expect(resetsSentBy(peer, () => socket.abort())).toBe(1);
    expect(socket.state).toBe('closed');
  });

  it.each([
    ['syn-sent', inSynSent],
    ['closing', (peer: ScriptedPeer) => inClosing(peer).socket],
    ['last-ack', (peer: ScriptedPeer) => inLastAck(peer).socket],
    ['time-wait', (peer: ScriptedPeer) => inTimeWait(peer).socket],
  ] as const)('in %s the connection is deleted and nothing is sent', (_name, reach) => {
    const peer = scriptedPeer();
    const socket = reach(peer);
    expect(resetsSentBy(peer, () => socket.abort())).toBe(0);
    expect(peer.take()).toEqual([]);
    expect(socket.state).toBe('closed');
  });

  it('segments queued for retransmission are flushed: nothing follows the reset', () => {
    const peer = scriptedPeer();
    const { socket } = established(peer);
    socket.write('unacknowledged');
    peer.clear();
    socket.abort();
    peer.clear();
    peer.advance(120_000);
    expect(peer.take()).toEqual([]);
  });
});
