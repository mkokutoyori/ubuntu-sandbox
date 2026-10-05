/**
 * Une connexion TCP se ferme dans chaque sens a part, et l'application
 * decide quand elle ferme le sien.
 *
 * Mesure de depart (commit precedent), pair SCRIPTE :
 *
 *   - le FIN du pair etait suivi, dans la meme milliseconde, du FIN du DUT :
 *     `processFin` appelait `_initiateClose` sans demander a personne. Une
 *     application qui veut repondre APRES avoir lu la fin du flux ne le
 *     pouvait pas, et aucun evenement ne lui disait que le pair avait fini ;
 *   - `send()` apres `close()` jetait l'octet en silence, sans rendre
 *     l'« error: connection closing » que la RFC exige, et un `send()` pose
 *     apres un `close()` differe (fenetre fermee) partait QUAND MEME, avant le
 *     FIN ;
 *   - `close()` dans FIN-WAIT-1, FIN-WAIT-2, CLOSING, LAST-ACK et TIME-WAIT
 *     DETRUISAIT le TCB : le FIN en cours n'etait plus retransmis, et un
 *     TIME-WAIT s'evaporait au deuxieme appel — l'attente de 2 MSL, que la
 *     RFC impose a qui ferme activement, ne tenait que si l'application
 *     n'appelait close() qu'une fois.
 *
 * Autorite (docs/rfc/tcp, lue) : RFC 9293 §3.6, cas 1 (« No further SENDs
 * from the user will be accepted ... RECEIVEs are allowed in this state »)
 * et cas 2 (« the receiving TCP endpoint can ACK it and tell the user that
 * the connection is closing. The user will respond with a CLOSE, upon which
 * the TCP endpoint can send a FIN ») ; §3.6.1 (« a host is permitted to
 * continue sending data in the open direction on a half-closed connection » ;
 * MUST-13, 2 MSL en TIME-WAIT ; MUST-12, l'application est informee d'une
 * fermeture normale ou d'un abandon) ; §3.10.2 (SEND en FIN-WAIT-1/2,
 * CLOSING, LAST-ACK, TIME-WAIT : « Return "error: connection closing" and do
 * not service request ») ; §3.10.4 (CLOSE dans ces memes etats : « "ok" would
 * be acceptable, too, as long as a second FIN is not emitted (the first FIN
 * may be retransmitted) »).
 *
 * Choix assume : le FIN reste emis tout seul par defaut (`allowHalfOpen`
 * faux), comme dans `net.Socket` de Node — toutes les applications du depot
 * ecrivent leur reponse AVANT de lire la fin et comptent sur la pile pour
 * fermer. MAY-1 (fermeture « half-duplex » ou close() interdit la lecture) et
 * SHLD-3 (RST quand des donnees non lues sont perdues, qui n'oblige que les
 * hotes ayant choisi MAY-1) ne sont PAS construits : la pile suit la variante
 * full-duplex de §3.6.1, ou close() n'est que l'envoi du FIN.
 *
 * Discrimination (fichier copie sur le commit precedent) : VINGT-TROIS cas sur
 * vingt-neuf tombent. Les SIX autres passent des deux cotes et sont nommes
 * ici plutot que laisses a decouvrir : le TEMOIN du FIN que la pile emet
 * seule par defaut (le comportement historique, conserve), le TEMOIN de la
 * fermeture normale qui finit par `onClose(fin)` apres TIME-WAIT, le TEMOIN
 * du RST qui previent l'application en ESTABLISHED comme en CLOSE-WAIT, le
 * TEMOIN du SEND qui part en ESTABLISHED, le TEMOIN du CLOSE qui envoie le
 * FIN en ESTABLISHED, et la NON-REGRESSION des octets refuses qui
 * n'atteignent jamais le fil (ils n'y atteignaient pas avant non plus : ce
 * qui manquait, c'est la valeur rendue). Le SEND pose apres un CLOSE differe
 * est mesure a part sur le commit precedent : cent octets, FIN differe par la fenetre
 * nulle, puis `send('more')` — les cent quatre octets partent, `more`
 * avant le FIN.
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openPassive, openActive, PEER_ISN,
  type ScriptedPeer, type OpenConnection,
} from '../../support/tcpScriptedPeer';
import { TCP_TIME_WAIT_MS, type TcpSegment } from '@/network/tcp/types';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

const HALF_OPEN = { allowHalfOpen: true } as const;

interface Lab {
  peer: ScriptedPeer;
  connection: OpenConnection;
  log: string[];
}

function lab(options: { halfOpen?: boolean } = {}): Lab {
  const peer = scriptedPeer();
  const connection = openPassive(peer, [], PEER_ISN, 65535, options.halfOpen ? HALF_OPEN : {});
  const log: string[] = [];
  connection.socket.onData((data) => log.push(`data:${String(data)}`));
  connection.socket.onClose((reason) => log.push(`close:${reason}`));
  return { peer, connection, log };
}

function peerFin(peer: ScriptedPeer, connection: OpenConnection, extra = 0): void {
  peer.send({
    flags: 'FA', sequence: PEER_ISN + 1 + extra, acknowledgement: connection.socket.sendNext,
  });
}

function finsOf(segments: ReadonlyArray<TcpSegment>): number {
  return segments.filter((s) => s.flags.fin).length;
}

describe('the peer FIN reaches the application, which decides when to send its own (RFC 9293 §3.6, case 2; §3.6.1)', () => {
  it('WITNESS: by default the stack closes its side by itself, as before', () => {
    const { peer, connection } = lab();
    peerFin(peer, connection);
    const out = peer.take();
    expect(finsOf(out)).toBe(1);
    expect(connection.socket.state).toBe('last-ack');
  });

  it('a socket that allows half-open stays in CLOSE-WAIT and sends no FIN', () => {
    const { peer, connection } = lab({ halfOpen: true });
    peerFin(peer, connection);
    const out = peer.take();
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].acknowledgement).toBe(PEER_ISN + 2);
    expect(finsOf(out)).toBe(0);
    expect(connection.socket.state).toBe('close-wait');
  });

  it('the application keeps sending in CLOSE-WAIT, then closes with its own FIN', () => {
    const { peer, connection, log } = lab({ halfOpen: true });
    peerFin(peer, connection);
    peer.clear();
    expect(connection.socket.send('reply')).toBe('ok');
    const data = peer.take().filter((s) => s.payload !== undefined && String(s.payload).length > 0);
    expect(data.map((s) => String(s.payload)).join('')).toBe('reply');
    expect(data[0].sequence).toBe(connection.dutIsn + 1);
    peer.send({
      flags: 'A', sequence: PEER_ISN + 2, acknowledgement: connection.dutIsn + 1 + 5,
    });
    expect(connection.socket.close()).toBe('ok');
    const fin = peer.take().find((s) => s.flags.fin)!;
    expect(fin.sequence).toBe(connection.dutIsn + 1 + 5);
    expect(connection.socket.state).toBe('last-ack');
    peer.send({
      flags: 'A', sequence: PEER_ISN + 2, acknowledgement: connection.dutIsn + 1 + 5 + 1,
    });
    expect(connection.socket.state).toBe('closed');
    expect(log).toContain('close:fin');
  });

  it('a socket that connects out can allow half-open too', () => {
    const peer = scriptedPeer();
    const { socket } = openActive(peer, [], PEER_ISN, 65535, HALF_OPEN);
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1, acknowledgement: socket.sendNext });
    expect(finsOf(peer.take())).toBe(0);
    expect(socket.state).toBe('close-wait');
  });

  it('the option is carried by the accepted socket', () => {
    expect(lab({ halfOpen: true }).connection.socket.allowHalfOpen).toBe(true);
    expect(lab().connection.socket.allowHalfOpen).toBe(false);
  });
});

describe('the machines report the two halves of a half-closed connection in their own words', () => {
  it('ss reads CLOSE-WAIT where the peer is waiting for us and FIN-WAIT-2 where we closed', async () => {
    const clock = new VirtualTimeScheduler();
    __setDefaultScheduler(clock);
    resetCounters(); MACAddress.resetCounter(); resetDeviceCounters(); Logger.reset();
    EquipmentRegistry.resetInstance();
    const client = new LinuxPC('linux-pc', 'pc', 0, 0);
    const server = new LinuxServer('linux-server', 'srv', 0, 0);
    client.powerOn(); server.powerOn();
    new Cable('c').connect(client.getPorts()[0], server.getPorts()[0]);
    client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    server.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
    const accepted: TcpSocket[] = [];
    server.getTcpStack().listen(8080, { ...HALF_OPEN, onAccept: (socket) => { accepted.push(socket); } });
    const outgoing = client.getTcpStack().connect('10.0.0.10', 8080)!;
    outgoing.close();

    const serverView = await server.executeCommand('ss -tan');
    const clientView = await client.executeCommand('ss -tan');
    expect(serverView).toMatch(/CLOSE-WAIT\s+\d+\s+\d+\s+10\.0\.0\.10:8080\s+10\.0\.0\.1:\d+/);
    expect(clientView).toMatch(/FIN-WAIT-2\s+\d+\s+\d+\s+10\.0\.0\.1:\d+\s+10\.0\.0\.10:8080/);

    accepted[0].close();
    expect(await client.executeCommand('ss -tan')).toMatch(/TIME-WAIT\s+\d+\s+\d+\s+10\.0\.0\.1:/);
    expect(await server.executeCommand('ss -tan')).not.toMatch(/CLOSE-WAIT|LAST-ACK/);
    __setDefaultScheduler(null);
  });
});

describe('the application is told the stream ended, after the data it ends (MUST-12)', () => {
  it('onEnd fires after the data that preceded the FIN', () => {
    const { peer, connection, log } = lab({ halfOpen: true });
    connection.socket.onEnd(() => log.push('end'));
    peer.send({ flags: 'PA', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendNext, payload: 'hello' });
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1 + 5, acknowledgement: connection.socket.sendNext });
    expect(log).toEqual(['data:hello', 'end']);
  });

  it('a FIN beyond a hole is not the end of the stream until the hole is filled', () => {
    const { peer, connection, log } = lab({ halfOpen: true });
    connection.socket.onEnd(() => log.push('end'));
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1 + 5, acknowledgement: connection.socket.sendNext });
    expect(log).toEqual([]);
    expect(connection.socket.state).toBe('established');
    peer.send({ flags: 'PA', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendNext, payload: 'hello' });
    expect(log).toEqual(['data:hello', 'end']);
  });

  it('a handler attached after the FIN is told at once', () => {
    const { peer, connection } = lab({ halfOpen: true });
    peerFin(peer, connection);
    const seen: string[] = [];
    connection.socket.onEnd(() => seen.push('end'));
    expect(seen).toEqual(['end']);
  });

  it('the end waits for data nobody has read yet', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, [], PEER_ISN, 65535, HALF_OPEN);
    const log: string[] = [];
    connection.socket.onEnd(() => log.push('end'));
    peer.send({ flags: 'PA', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendNext, payload: 'queued' });
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1 + 6, acknowledgement: connection.socket.sendNext });
    expect(log).toEqual([]);
    connection.socket.onData((data) => log.push(`data:${String(data)}`));
    expect(log).toEqual(['data:queued', 'end']);
  });

  it('onEnd also fires on a socket that closes itself, before it does', () => {
    const { peer, connection, log } = lab();
    connection.socket.onEnd(() => log.push(`end@${connection.socket.state}`));
    peerFin(peer, connection);
    expect(log).toContain('end@close-wait');
  });

  it('after our own close, the peer FIN still ends the stream we are reading', () => {
    const { peer, connection, log } = lab();
    connection.socket.onEnd(() => log.push('end'));
    connection.socket.close();
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: connection.dutIsn + 2 });
    peer.send({ flags: 'PA', sequence: PEER_ISN + 1, acknowledgement: connection.dutIsn + 2, payload: 'last words' });
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1 + 10, acknowledgement: connection.dutIsn + 2 });
    expect(log).toEqual(['data:last words', 'end']);
    expect(connection.socket.state).toBe('time-wait');
  });

  it('WITNESS: a normal close ends with onClose(fin) once TIME-WAIT is over', () => {
    const { peer, connection, log } = lab();
    connection.socket.close();
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1, acknowledgement: connection.dutIsn + 2 });
    expect(log).not.toContain('close:fin');
    peer.advance(TCP_TIME_WAIT_MS + 1_000);
    expect(log).toContain('close:fin');
  });

  it('WITNESS: a reset tells the application it was aborted, in CLOSE-WAIT as in ESTABLISHED', () => {
    const established = lab();
    established.peer.send({ flags: 'RA', sequence: PEER_ISN + 1, acknowledgement: established.connection.socket.sendNext });
    expect(established.log).toContain('close:rst');
    const halfOpen = lab({ halfOpen: true });
    peerFin(halfOpen.peer, halfOpen.connection);
    halfOpen.peer.send({ flags: 'RA', sequence: PEER_ISN + 2, acknowledgement: halfOpen.connection.socket.sendNext });
    expect(halfOpen.log).toContain('close:rst');
  });
});

describe('SEND after CLOSE is refused, not swallowed (RFC 9293 §3.10.2)', () => {
  it('WITNESS: SEND on an established connection goes out', () => {
    const { peer, connection } = lab();
    connection.socket.send('abc');
    expect(peer.take().some((s) => String(s.payload ?? '') === 'abc')).toBe(true);
  });

  it('SEND on an established connection answers ok', () => {
    const { connection } = lab();
    expect(connection.socket.send('abc')).toBe('ok');
  });

  it('SEND after CLOSE answers "connection closing"', () => {
    const { connection } = lab();
    connection.socket.close();
    expect(connection.socket.send('late')).toBe('closing');
  });

  it('WITNESS: the refused bytes never reach the wire', () => {
    const { peer, connection } = lab();
    connection.socket.close();
    peer.clear();
    connection.socket.send('late');
    expect(peer.take().some((s) => String(s.payload ?? '').includes('late'))).toBe(false);
  });

  it('SEND is refused in every state past ESTABLISHED and CLOSE-WAIT', () => {
    const closing = lab();
    closing.connection.socket.close();
    closing.peer.send({ flags: 'FA', sequence: PEER_ISN + 1, acknowledgement: closing.connection.socket.sendNext - 1 });
    expect(closing.connection.socket.state).toBe('closing');
    expect(closing.connection.socket.send('x')).toBe('closing');

    const timeWait = lab();
    timeWait.connection.socket.close();
    timeWait.peer.send({ flags: 'FA', sequence: PEER_ISN + 1, acknowledgement: timeWait.connection.socket.sendNext });
    expect(timeWait.connection.socket.state).toBe('time-wait');
    expect(timeWait.connection.socket.send('x')).toBe('closing');

    const lastAck = lab();
    peerFin(lastAck.peer, lastAck.connection);
    expect(lastAck.connection.socket.state).toBe('last-ack');
    expect(lastAck.connection.socket.send('x')).toBe('closing');
  });

  it('SEND on a connection that no longer exists says so', () => {
    const { peer, connection } = lab();
    peer.send({ flags: 'RA', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendNext });
    expect(connection.socket.state).toBe('closed');
    expect(connection.socket.send('x')).toBe('no-connection');
  });

  it('a SEND after a CLOSE that waits for the window is refused, and the FIN follows only the data sent before', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer, [], PEER_ISN, 0);
    const first = 'a'.repeat(100);
    expect(connection.socket.send(first)).toBe('ok');
    expect(connection.socket.close()).toBe('ok');
    expect(connection.socket.send('more')).toBe('closing');
    peer.clear();
    peer.send({
      flags: 'A', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendUnacked, window: 65535,
    });
    peer.advance(100);
    const wire = peer.take();
    const text = wire.map((s) => String(s.payload ?? '')).join('');
    expect(text).toBe(first);
    expect(finsOf(wire)).toBe(1);
  });
});

describe('CLOSE in a closing state continues the close, it does not destroy it (RFC 9293 §3.10.4, MUST-13)', () => {
  it('WITNESS: CLOSE on an established connection sends the FIN', () => {
    const { peer, connection } = lab();
    connection.socket.close();
    expect(finsOf(peer.take())).toBe(1);
    expect(connection.socket.state).toBe('fin-wait-1');
  });

  it('CLOSE on an established connection answers ok', () => {
    const { connection } = lab();
    expect(connection.socket.close()).toBe('ok');
  });

  it('a second CLOSE in TIME-WAIT leaves the 2 MSL wait intact', () => {
    const { peer, connection } = lab();
    connection.socket.close();
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1, acknowledgement: connection.dutIsn + 2 });
    expect(connection.socket.state).toBe('time-wait');
    expect(connection.socket.close()).toBe('closing');
    expect(connection.socket.state).toBe('time-wait');
    peer.advance(TCP_TIME_WAIT_MS - 1_000);
    expect(connection.socket.state).toBe('time-wait');
    peer.advance(2_000);
    expect(connection.socket.state).toBe('closed');
  });

  it('a second CLOSE in FIN-WAIT-1 neither emits a second FIN nor stops retransmitting the first', () => {
    const { peer, connection } = lab();
    connection.socket.close();
    const first = peer.take().filter((s) => s.flags.fin);
    expect(first.length).toBe(1);
    expect(connection.socket.close()).toBe('closing');
    expect(finsOf(peer.take())).toBe(0);
    expect(connection.socket.state).toBe('fin-wait-1');
    peer.advance(250);
    const again = peer.take().filter((s) => s.flags.fin);
    expect(again.length).toBe(1);
    expect(again[0].sequence).toBe(first[0].sequence);
  });

  it('a second CLOSE in LAST-ACK keeps retransmitting the FIN', () => {
    const { peer, connection } = lab();
    peerFin(peer, connection);
    const fin = peer.take().find((s) => s.flags.fin)!;
    expect(connection.socket.close()).toBe('closing');
    expect(connection.socket.state).toBe('last-ack');
    peer.advance(250);
    const again = peer.take().filter((s) => s.flags.fin);
    expect(again.length).toBe(1);
    expect(again[0].sequence).toBe(fin.sequence);
  });

  it('a second CLOSE in FIN-WAIT-2 still lets the peer FIN complete the close', () => {
    const { peer, connection } = lab();
    connection.socket.close();
    peer.send({ flags: 'A', sequence: PEER_ISN + 1, acknowledgement: connection.dutIsn + 2 });
    expect(connection.socket.state).toBe('fin-wait-2');
    expect(connection.socket.close()).toBe('closing');
    expect(connection.socket.state).toBe('fin-wait-2');
    peer.clear();
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1, acknowledgement: connection.dutIsn + 2 });
    expect(connection.socket.state).toBe('time-wait');
    expect(peer.last()!.acknowledgement).toBe(PEER_ISN + 2);
  });

  it('a second CLOSE in CLOSING leaves the simultaneous close to finish', () => {
    const { peer, connection } = lab();
    connection.socket.close();
    peer.send({ flags: 'FA', sequence: PEER_ISN + 1, acknowledgement: connection.dutIsn + 1 });
    expect(connection.socket.state).toBe('closing');
    expect(connection.socket.close()).toBe('closing');
    expect(connection.socket.state).toBe('closing');
    peer.send({ flags: 'A', sequence: PEER_ISN + 2, acknowledgement: connection.dutIsn + 2 });
    expect(connection.socket.state).toBe('time-wait');
  });

  it('CLOSE on a connection that no longer exists says so', () => {
    const { peer, connection } = lab();
    peer.send({ flags: 'RA', sequence: PEER_ISN + 1, acknowledgement: connection.socket.sendNext });
    expect(connection.socket.close()).toBe('no-connection');
  });
});
