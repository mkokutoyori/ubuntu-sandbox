/**
 * Scénario 1 — Établissement et clôture propre d'une connexion TCP.
 *
 * Objectif : valider que le simulateur reproduit fidèlement le cycle de
 * vie complet d'une connexion TCP, du SYN initial au FIN/ACK final.
 *
 * Déroulé : un LinuxPC initie une connexion TCP vers un service écoutant
 * sur un port custom (8080) d'un LinuxServer, échange quelques octets de
 * données applicatives, puis ferme proprement la connexion.
 *
 * Points de contrôle :
 *  - tcpdump montre la séquence SYN → SYN-ACK → ACK puis ACK des données
 *    puis FIN-ACK → ACK → FIN-ACK → ACK.
 *  - numéros de séquence et d'acquittement cohérents
 *    (client_isn+1 == server_ack, server_isn+1 == client_ack).
 *  - ss -tan reflète successivement ESTAB / FIN-WAIT-2 / TIME-WAIT
 *    selon l'état de la machine RFC 9293.
 *  - après 2×MSL la connexion est libérée et n'apparaît plus dans ss.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  VirtualTimeScheduler,
  __setDefaultScheduler,
} from '@/events/Scheduler';
import { TCP_TIME_WAIT_MS } from '@/network/tcp/types';

let scheduler: VirtualTimeScheduler;

beforeEach(() => {
  scheduler = new VirtualTimeScheduler();
  __setDefaultScheduler(scheduler);
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

afterEach(() => {
  __setDefaultScheduler(null);
});

interface MinimalSocket {
  state: string;
  send(data: string): void;
  close(): void;
  localPort: number;
}

interface TestLan {
  pc: LinuxPC;
  srv: LinuxServer;
  /** The accepted server-side socket, populated once the handshake completes. */
  getServerSocket(): MinimalSocket | null;
}

function buildPair(): TestLan {
  const pc  = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'),  new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  let savedSrv: MinimalSocket | null = null;
  (srv as unknown as { getTcpStack(): {
    listen(p: number, h: { onAccept: (s: MinimalSocket) => void }): void;
  } }).getTcpStack().listen(8080, {
    onAccept: (s) => { savedSrv = s; },
  });
  return { pc, srv, getServerSocket: () => savedSrv };
}

function tcpStack(host: LinuxPC | LinuxServer) {
  return (host as unknown as {
    getTcpStack(): {
      connect(ip: string, port: number): MinimalSocket | null;
    };
  }).getTcpStack();
}

function socketTableEntries(host: LinuxPC | LinuxServer) {
  return (host as unknown as {
    socketTable: { getAll: () => Array<{
      protocol: string; localPort: number; remoteAddress: string; remotePort: number; state: string;
    }> };
  }).socketTable.getAll();
}

/** Parse one tcpdump line into its parts (seq may be negative — ISN is 32-bit signed-printed). */
function parseTcpdumpLine(line: string): { flags: string; seq: number; ack: number; length: number } {
  const flags  = /Flags \[([^\]]+)\]/.exec(line)?.[1] ?? '';
  const seq    = parseInt(/seq (-?\d+)/.exec(line)?.[1] ?? '0', 10);
  const ack    = parseInt(/ack (-?\d+)/.exec(line)?.[1] ?? '0', 10);
  const length = parseInt(/length (\d+)/.exec(line)?.[1] ?? '0', 10);
  return { flags, seq, ack, length };
}

describe('Scénario 1 — Cycle de vie complet d\'une connexion TCP', () => {
  it('3-way handshake : tcpdump capture SYN, SYN-ACK, ACK sur port 8080', async () => {
    const lan = buildPair();
    const sock = tcpStack(lan.pc).connect('10.0.0.10', 8080)!;
    expect(sock.state).toBe('established');

    const dump = await lan.pc.executeCommand('tcpdump -nn port 8080');
    const flagged = dump.split('\n').filter(l => l.includes('Flags'));
    expect(flagged.some(l => /Flags \[S\],/.test(l)  && /8080/.test(l))).toBe(true);
    expect(flagged.some(l => /Flags \[S\.\],/.test(l) && /8080/.test(l))).toBe(true);
    expect(flagged.some(l => /Flags \[\.\],/.test(l))).toBe(true);
  });

  it('handshake : seq/ack cohérents (client_isn+1 == server_ack, server_isn+1 == client_ack)', async () => {
    const lan = buildPair();
    tcpStack(lan.pc).connect('10.0.0.10', 8080);

    const dump = await lan.pc.executeCommand('tcpdump -nn port 8080');
    const lines = dump.split('\n').filter(l => l.includes('Flags'));
    const syn    = parseTcpdumpLine(lines.find(l => /Flags \[S\],/.test(l))!);
    const synAck = parseTcpdumpLine(lines.find(l => /Flags \[S\.\],/.test(l))!);
    const ack    = parseTcpdumpLine(lines.find(l => /Flags \[\.\],/.test(l))!);

    expect(synAck.ack >>> 0).toBe(((syn.seq + 1) >>> 0));
    expect(ack.ack    >>> 0).toBe(((synAck.seq + 1) >>> 0));
  });

  it('échange de données : PSH-ACK transporte la charge utile et l\'autre côté l\'acquitte', async () => {
    const lan = buildPair();
    const sock = tcpStack(lan.pc).connect('10.0.0.10', 8080)!;
    sock.send('hello');

    const dump = await lan.pc.executeCommand('tcpdump -nn port 8080');
    expect(dump).toMatch(/Flags \[P\.\],.*length 5/);
    // The server acknowledges the data with a bare ACK in addition to the
    // handshake's final ACK from the client.
    const bareAcks = dump.split('\n').filter(l => /Flags \[\.\]/.test(l));
    expect(bareAcks.length).toBeGreaterThanOrEqual(2);
  });

  it('ss -tan : la connexion apparaît en ESTAB après le handshake (côtés client & serveur)', async () => {
    const lan = buildPair();
    tcpStack(lan.pc).connect('10.0.0.10', 8080);

    const ssPc = await lan.pc.executeCommand('ss -tan');
    expect(ssPc).toMatch(/ESTAB .*10\.0\.0\.1:\d+ +10\.0\.0\.10:8080/);

    const ssSrv = await lan.srv.executeCommand('ss -tan');
    expect(ssSrv).toMatch(/ESTAB .*10\.0\.0\.10:8080 +10\.0\.0\.1:\d+/);
  });

  it('4-way close : tcpdump capture FIN-ACK → ACK → FIN-ACK → ACK', async () => {
    const lan = buildPair();
    const sock = tcpStack(lan.pc).connect('10.0.0.10', 8080)!;
    sock.close();
    // Real applications close on EOF; mimic that on the server side so the
    // close completes through LAST-ACK → CLOSED.
    lan.getServerSocket()!.close();

    const dump = await lan.pc.executeCommand('tcpdump -nn port 8080');
    const finAcks = dump.split('\n').filter(l => /Flags \[F\.\]/.test(l));
    expect(finAcks.length).toBeGreaterThanOrEqual(2);
  });

  it('ss -tan : la connexion passe en TIME-WAIT côté initiateur après le close', async () => {
    const lan = buildPair();
    const sock = tcpStack(lan.pc).connect('10.0.0.10', 8080)!;
    sock.close();
    lan.getServerSocket()!.close();

    const ssPc = await lan.pc.executeCommand('ss -tan');
    expect(ssPc).toMatch(/TIME-WAIT .*10\.0\.0\.1:\d+ +10\.0\.0\.10:8080/);
  });

  it('TIME-WAIT libère la connexion après 2×MSL — elle disparaît de ss', async () => {
    const lan = buildPair();
    const sock = tcpStack(lan.pc).connect('10.0.0.10', 8080)!;
    sock.close();
    lan.getServerSocket()!.close();

    const tcpOf = (host: LinuxPC | LinuxServer) => socketTableEntries(host)
      .filter(s => s.protocol === 'tcp' && s.remoteAddress === '10.0.0.10');
    expect(tcpOf(lan.pc).some(s => s.state === 'TIME_WAIT')).toBe(true);

    scheduler.advance(TCP_TIME_WAIT_MS + 1);

    expect(tcpOf(lan.pc)).toHaveLength(0);
  });

  it('séquence d\'états cohérente : SYN-SENT → ESTAB → FIN-WAIT-1/2 → TIME-WAIT → CLOSED', async () => {
    const lan = buildPair();
    const states: string[] = [];
    const bus = (lan.pc as unknown as { getBus(): {
      subscribe(t: 'tcp.state.changed', cb: (e: { payload: { newState: string; remoteIp: string; remotePort: number } }) => void): () => void;
    } }).getBus();
    bus.subscribe('tcp.state.changed', (e) => {
      if (e.payload.remoteIp === '10.0.0.10' && e.payload.remotePort === 8080) {
        states.push(e.payload.newState);
      }
    });
    const sock = tcpStack(lan.pc).connect('10.0.0.10', 8080)!;
    sock.close();
    lan.getServerSocket()!.close();
    scheduler.advance(TCP_TIME_WAIT_MS + 1);

    expect(states[0]).toBe('syn-sent');
    expect(states).toContain('established');
    expect(states).toContain('fin-wait-1');
    expect(states).toContain('fin-wait-2');
    expect(states).toContain('time-wait');
    expect(states[states.length - 1]).toBe('closed');
  });
});
