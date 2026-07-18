/**
 * Scénario 1 — Analyse complète du cycle de vie TCP par dissection
 * protocolaire tcpdump : handshake, transfert, contrôle de flux, fermeture.
 * Volume réduit vs. le 1 Mo du scénario (segmentation MSS/contrôle de
 * flux sont invariants d'échelle) pour garder le test rapide.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { TCP_TIME_WAIT_MS, TCP_DEFAULT_MSS } from '@/network/tcp/types';
import type { TcpSocket } from '@/network/tcp/TcpStack';

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

const CLIENT_IP = '192.168.10.10';
const SERVER_IP = '192.168.10.101';
const HTTP_PORT = 80;

interface HttpLan {
  pc: LinuxPC;
  srv: LinuxServer;
  cable: Cable;
  getServerSocket(): TcpSocket | null;
}

function buildHttpLan(): HttpLan {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  const cable = new Cable('c');
  cable.connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress(CLIENT_IP), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress(SERVER_IP), new SubnetMask('255.255.255.0'));
  let savedSrv: TcpSocket | null = null;
  srv.getTcpStack().listen(HTTP_PORT, { onAccept: (s) => { savedSrv = s; } });
  return { pc, srv, cable, getServerSocket: () => savedSrv };
}

interface ParsedSegment {
  raw: string;
  srcIp: string;
  flags: string;
  seq: number;
  ack: number;
  win: number;
  length: number;
  options: string;
  isAck: boolean;
}

// At -v+ tcpdump splits each packet across two lines (IP header, then an
// indented "src > dst: Flags [...]" line with no "IP " prefix); without
// -v both are on one line. srcIp handles both shapes.
function parseSegments(dump: string): ParsedSegment[] {
  return dump.split('\n')
    .filter((l) => l.includes('Flags ['))
    .map((line) => {
      const flags = /Flags \[([^\]]+)\]/.exec(line)?.[1] ?? '';
      const srcIp = /^\s*(?:IP\s+)?(\d+\.\d+\.\d+\.\d+)\.\d+\s+>/.exec(line)?.[1] ?? '';
      return {
        raw: line,
        srcIp,
        flags,
        seq: parseInt(/seq (-?\d+)/.exec(line)?.[1] ?? '0', 10),
        ack: parseInt(/ack (-?\d+)/.exec(line)?.[1] ?? '0', 10),
        win: parseInt(/win (\d+)/.exec(line)?.[1] ?? '0', 10),
        length: parseInt(/length (\d+)/.exec(line)?.[1] ?? '0', 10),
        options: /options \[([^\]]*)\]/.exec(line)?.[1] ?? '',
        isAck: flags.includes('.'),
      };
    });
}

async function captureFullSession(
  lan: HttpLan, drive: (sock: TcpSocket) => Promise<void> | void,
): Promise<string> {
  const pending = lan.pc.executeCommand(`tcpdump -c 100 -nn -vvv -S "tcp and host ${SERVER_IP} and port ${HTTP_PORT}"`);
  await new Promise((r) => setTimeout(r, 20));
  const sock = lan.pc.getTcpStack().connect(SERVER_IP, HTTP_PORT)!;
  await drive(sock);
  return pending;
}

describe('Scénario 1 — Analyse complète du cycle de vie TCP par dissection protocolaire tcpdump', () => {
  it('la commande de capture -nn -S -vvv -XX avec écriture pcap réussit sans erreur', async () => {
    const lan = buildHttpLan();
    const output = await lan.pc.executeCommand(
      `tcpdump -i eth0 -nn -S -vvv -XX 'tcp and host ${SERVER_IP} and port 80' -w /tmp/tcp-session.pcap`,
    );
    expect(output).not.toMatch(/tcpdump: error/);
    expect(output).toContain('packets captured');
  });

  describe('phase handshake', () => {
    it('le SYN client expose MSS, SACK_PERM, TS val/ecr 0 et WS', async () => {
      const lan = buildHttpLan();
      const pending = lan.pc.executeCommand(`tcpdump -c 3 -nn -vvv tcp and port ${HTTP_PORT}`);
      await new Promise((r) => setTimeout(r, 20));
      lan.pc.getTcpStack().connect(SERVER_IP, HTTP_PORT);
      await new Promise((r) => setTimeout(r, 20));
      const segs = parseSegments(await pending);

      const syn = segs.find((s) => s.flags === 'S');
      expect(syn).toBeDefined();
      expect(syn!.options).toMatch(/mss \d+/);
      expect(syn!.options).toContain('sackOK');
      expect(syn!.options).toMatch(/TS val \d+ ecr 0/);
      expect(syn!.options).toMatch(/wscale \d+/);
    });

    it('le SYN-ACK expose ses propres options et acquitte client_isn+1', async () => {
      const lan = buildHttpLan();
      const pending = lan.pc.executeCommand(`tcpdump -c 3 -nn -vvv tcp and port ${HTTP_PORT}`);
      await new Promise((r) => setTimeout(r, 20));
      lan.pc.getTcpStack().connect(SERVER_IP, HTTP_PORT);
      await new Promise((r) => setTimeout(r, 20));
      const segs = parseSegments(await pending);

      const syn = segs.find((s) => s.flags === 'S')!;
      const synAck = segs.find((s) => s.flags === 'S.');
      expect(synAck).toBeDefined();
      expect(synAck!.options).toMatch(/mss \d+/);
      expect((synAck!.ack >>> 0)).toBe((syn.seq + 1) >>> 0);
    });

    it('le troisième paquet ACK finalise le handshake avec ack = server_isn+1', async () => {
      const lan = buildHttpLan();
      const pending = lan.pc.executeCommand(`tcpdump -c 3 -nn -vvv tcp and port ${HTTP_PORT}`);
      await new Promise((r) => setTimeout(r, 20));
      lan.pc.getTcpStack().connect(SERVER_IP, HTTP_PORT);
      await new Promise((r) => setTimeout(r, 20));
      const segs = parseSegments(await pending);

      const synAck = segs.find((s) => s.flags === 'S.')!;
      const finalAck = segs.find((s) => s.flags === '.');
      expect(finalAck).toBeDefined();
      expect((finalAck!.ack >>> 0)).toBe((synAck.seq + 1) >>> 0);
    });
  });

  describe('phase transfert', () => {
    it('les blocs applicatifs se terminent par PSH et la progression des numéros de séquence est cohérente avec les octets transmis', async () => {
      const lan = buildHttpLan();
      const payload = 'D'.repeat(20_000);
      const dump = await captureFullSession(lan, (sock) => { sock.send(payload); });
      const segs = parseSegments(dump);

      const dataSegs = segs.filter((s) => s.length > 0 && s.srcIp === CLIENT_IP);
      expect(dataSegs.length).toBeGreaterThan(1);

      const totalBytes = dataSegs.reduce((n, s) => n + s.length, 0);
      expect(totalBytes).toBe(payload.length);

      expect(segs.some((s) => s.flags.includes('P'))).toBe(true);
      for (const s of dataSegs) expect(s.length).toBeLessThanOrEqual(TCP_DEFAULT_MSS);
    });

    it('le contrôle de flux fait apparaître une fenêtre (win) qui décroît puis croît sur les ACK du récepteur', async () => {
      const lan = buildHttpLan();
      const pending = lan.pc.executeCommand(`tcpdump -c 100 -nn -vvv -S "tcp and host ${SERVER_IP} and port ${HTTP_PORT}"`);
      await new Promise((r) => setTimeout(r, 20));

      // Deux connexions distinctes (récepteur saturé, puis fenêtre par
      // défaut) plutôt qu'une bascule en cours de flux, qui resterait
      // liée à l'ancienne fenêtre tant qu'aucun nouvel ACK ne la relit.
      const sockLow = lan.pc.getTcpStack().connect(SERVER_IP, HTTP_PORT)!;
      lan.getServerSocket()!.windowSize = 512;
      sockLow.send('A'.repeat(4000));

      const sockHigh = lan.pc.getTcpStack().connect(SERVER_IP, HTTP_PORT)!;
      sockHigh.send('B'.repeat(4000));

      const dump = await pending;
      const segs = parseSegments(dump);

      const serverAcks = segs.filter((s) => s.srcIp === SERVER_IP && s.win > 0);
      expect(serverAcks.length).toBeGreaterThan(2);

      const wins = serverAcks.map((s) => s.win);
      const minIdx = wins.indexOf(Math.min(...wins));
      expect(minIdx).toBeGreaterThan(0);
      expect(minIdx).toBeLessThan(wins.length - 1);
      expect(wins[0]).toBeGreaterThan(wins[minIdx]);
      expect(wins[wins.length - 1]).toBeGreaterThan(wins[minIdx]);
    });

    it('une perte ponctuelle déclenche une retransmission et SACK est utilisé', async () => {
      const lan = buildHttpLan();
      // Cable call 6 is the client's 2nd data segment (5 total, MSS=1460/
      // 6000 octets), after the 3-way handshake (calls 1-3).
      let calls = 0;
      lan.cable.setPacketLossRate(0.999);
      lan.cable.setRng(() => (++calls === 6 ? 0 : 1));

      const received: string[] = [];
      const dump = await captureFullSession(lan, async (sock) => {
        lan.getServerSocket()!.onData((d) => received.push(d as string));
        sock.send('D'.repeat(6000));
        await new Promise((r) => setTimeout(r, 50));
      });
      const segs = parseSegments(dump);

      expect(received.join('')).toBe('D'.repeat(6000));
      expect(segs.some((s) => /sack \d+ \{/.test(s.options))).toBe(true);
      for (const s of segs) if (s.length > 0) expect(s.length).toBeLessThanOrEqual(TCP_DEFAULT_MSS);
    });
  });

  describe('phase fermeture', () => {
    it('séquence FIN-ACK / FIN-ACK en quatre temps, cohérente avec le dernier octet transmis', async () => {
      const lan = buildHttpLan();
      const payload = 'X'.repeat(3000);
      let lastDataEnd = 0;
      const dump = await captureFullSession(lan, async (sock) => {
        sock.send(payload);
        await new Promise((r) => setTimeout(r, 10));
        sock.close();
        lan.getServerSocket()!.close();
        await new Promise((r) => setTimeout(r, 10));
      });
      const segs = parseSegments(dump);

      const clientDataSegs = segs.filter((s) => s.length > 0 && s.srcIp === CLIENT_IP);
      for (const s of clientDataSegs) lastDataEnd = Math.max(lastDataEnd, (s.seq + s.length) >>> 0);

      const clientFin = segs.find((s) => s.flags.includes('F') && s.srcIp === CLIENT_IP);
      expect(clientFin).toBeDefined();
      expect((clientFin!.seq >>> 0)).toBe(lastDataEnd);

      const finAcks = segs.filter((s) => s.flags.includes('F'));
      expect(finAcks.length).toBeGreaterThanOrEqual(2);
    });

    it('TIME_WAIT visible côté initiateur puis libération après 2×MSL', async () => {
      const lan = buildHttpLan();
      const sock = lan.pc.getTcpStack().connect(SERVER_IP, HTTP_PORT)!;
      sock.close();
      lan.getServerSocket()!.close();

      const ss = await lan.pc.executeCommand('ss -tan');
      expect(ss).toMatch(new RegExp(`TIME-WAIT .*${CLIENT_IP.replace(/\./g, '\\.')}:\\d+ +${SERVER_IP.replace(/\./g, '\\.')}:${HTTP_PORT}`));

      scheduler.advance(TCP_TIME_WAIT_MS + 1);
      const ssAfter = await lan.pc.executeCommand('ss -tan');
      expect(ssAfter).not.toContain('TIME-WAIT');
    });
  });

  describe('critère de réussite', () => {
    it('reconstitution manuelle : octets capturés == taille du transfert, options négociées respectées sur toute la session', async () => {
      const lan = buildHttpLan();
      const payload = 'F'.repeat(30_000);
      const dump = await captureFullSession(lan, async (sock) => {
        sock.send(payload);
        await new Promise((r) => setTimeout(r, 20));
      });
      const segs = parseSegments(dump);

      const dataSegs = segs.filter((s) => s.length > 0 && s.srcIp === CLIENT_IP);
      const totalBytes = dataSegs.reduce((n, s) => n + s.length, 0);
      expect(totalBytes).toBe(payload.length);

      for (const s of segs) if (s.length > 0) expect(s.length).toBeLessThanOrEqual(TCP_DEFAULT_MSS);

      const syn = segs.find((s) => s.flags === 'S')!;
      expect(syn.options).toMatch(/mss \d+/);
      for (const s of dataSegs) expect(s.options).not.toMatch(/mss \d+/);
    });
  });
});
