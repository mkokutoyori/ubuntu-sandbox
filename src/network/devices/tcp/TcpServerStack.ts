/**
 * TcpServerStack — vendor-neutral server-side TCP state machine (RFC 793
 * subset matching this simulator's semantics).
 *
 * Why this exists: SSH listeners need to live on routers (Cisco, Huawei)
 * as well as end-hosts (Linux PC, Linux Server, Windows). Until now the
 * server side of TCP was inlined in {@link EndHost.handleTCP} and Router
 * had no notion of it — so SSH between a Linux client and a router could
 * only travel through the synchronous bypass bridge, never the wire.
 * This class extracts the server state machine behind a tiny binding
 * surface so any device with an IP plane can host TCP services.
 *
 * Responsibilities:
 *   - listenTcp(port, handler) / unlistenTcp(port)
 *   - handle inbound TCP segments addressed to one of the host's IPs:
 *       SYN              → allocate server-side TcpConnection, SYN-ACK,
 *                          invoke handler (so it can register onData
 *                          before any data arrives)
 *       PSH/ACK + data   → forward the payload to the connection
 *       FIN              → ACK back and drop the connection
 *
 * Outside the scope of this class on purpose:
 *   - Active-open / SYN-ACK as a client (handled by EndHost.tcpConnect).
 *     Routers in this simulator never initiate TCP — they're always the
 *     passive side of the handshake.
 *   - Re-transmission, windowing, sliding window. The simulator network
 *     never drops frames, so the RFC retry machinery would be dead code.
 *
 * Future extensions (documented for the reader, not implemented today):
 *   - SO_REUSEADDR semantics around listener replacement
 *   - per-listener accept queue length (sshd MaxStartups gate already
 *     lives in CrossVendorSshHost, not here)
 *   - TLS termination wrapper for an https handler — would slot in as a
 *     decorator over the connection handler with no changes to the stack
 *   - IPv6 server sockets — add a parallel handleSegment(IPv6Packet)
 */

import type { IPAddress } from '@/network/core/types';
import type { IPv4Packet, TCPPacket } from '@/network/core/types';
import { TcpConnection } from '@/network/core/TcpConnection';

/** Caller-supplied bindings — keeps the stack decoupled from EndHost / Router. */
export interface TcpServerStackBindings {
  /** Return the IPv4 address configured on the named port, or null. */
  getPortIp(portName: string): IPAddress | null;
  /** Look up the egress port + next-hop for replies addressed to `dst`. */
  resolveRoute(dst: IPAddress): TcpRoute | null;
  /** Hand a fully built TCP segment to the IP plane for transmission. */
  sendTcpFrame(srcIp: IPAddress, dstIp: IPAddress, route: TcpRoute, seg: TCPPacket): void;
  /** Optional reactive hooks — used by EndHost to emit host signals. */
  onListenerStarted?(localIp: string, port: number): void;
  onListenerStopped?(port: number): void;
  onConnectionEstablished?(info: TcpConnectionEvent): void;
  onConnectionClosed?(info: TcpConnectionEvent): void;
}

export interface TcpRoute {
  iface: string;
  nextHopIP: IPAddress;
  port?: unknown;
}

export interface TcpConnectionEvent {
  localIp: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  side: 'server' | 'client';
}

export class TcpServerStack {
  private readonly listeners = new Map<number, (conn: TcpConnection) => void>();
  private readonly connections = new Map<string, TcpConnection>();

  constructor(private readonly bindings: TcpServerStackBindings) {}

  // ── Public listener API ─────────────────────────────────────────────

  listen(port: number, handler: (conn: TcpConnection) => void): void {
    this.listeners.set(port, handler);
    this.bindings.onListenerStarted?.('0.0.0.0', port);
  }

  unlisten(port: number): boolean {
    const removed = this.listeners.delete(port);
    if (removed) this.bindings.onListenerStopped?.(port);
    return removed;
  }

  hasListener(port: number): boolean { return this.listeners.has(port); }
  listenedPorts(): ReadonlyArray<number> { return [...this.listeners.keys()]; }

  /** Drop every active connection (used at shutdown). */
  dropAll(): void {
    this.connections.clear();
  }

  /** Per-connection lookup for tests / inspection. */
  connectionsView(): ReadonlyMap<string, TcpConnection> {
    return this.connections;
  }

  // ── Segment dispatch ───────────────────────────────────────────────

  /**
   * Process one inbound TCP segment that was addressed to one of the
   * host's interface IPs (caller is responsible for the "for-us" check).
   */
  handleSegment(portName: string, ipPkt: IPv4Packet): void {
    const seg = ipPkt.payload as TCPPacket;
    if (!seg || seg.type !== 'tcp') return;

    const srcIp = ipPkt.sourceIP.toString();
    const { sourcePort: srcPort, destinationPort: dstPort, flags } = seg;

    if (flags.syn && !flags.ack) {
      this.handleSyn(portName, ipPkt, seg, srcIp, srcPort, dstPort);
      return;
    }

    if (seg.payload != null) {
      const conn = this.connections.get(connKey(dstPort, srcIp, srcPort));
      if (conn && typeof seg.payload === 'string') {
        conn.receiveData(seg.payload, seg.sequenceNumber);
      }
      return;
    }

    if (flags.fin) {
      this.handleFin(portName, ipPkt, seg, srcIp, srcPort, dstPort);
      return;
    }
  }

  // ── State transitions ──────────────────────────────────────────────

  private handleSyn(
    portName: string,
    ipPkt: IPv4Packet,
    seg: TCPPacket,
    srcIp: string,
    srcPort: number,
    dstPort: number,
  ): void {
    const handler = this.listeners.get(dstPort);
    if (!handler) return;

    const serverIP = this.bindings.getPortIp(portName);
    if (!serverIP) return;

    const route = this.bindings.resolveRoute(ipPkt.sourceIP);
    if (!route) return;

    const serverSeq = Math.floor(Math.random() * 0xFFFF);
    const serverConn = new TcpConnection(
      serverIP.toString(), dstPort,
      srcIp, srcPort,
      serverSeq + 1,
      (respSeg) => {
        const r = this.bindings.resolveRoute(ipPkt.sourceIP);
        if (!r) return;
        this.bindings.sendTcpFrame(serverIP, ipPkt.sourceIP, r, respSeg);
      },
    );
    serverConn.updateAck(seg.sequenceNumber, 1);
    const key = connKey(dstPort, srcIp, srcPort);
    this.connections.set(key, serverConn);
    this.bindings.onConnectionEstablished?.({
      localIp: serverIP.toString(),
      localPort: dstPort,
      remoteIp: srcIp,
      remotePort: srcPort,
      side: 'server',
    });

    const synAck: TCPPacket = {
      type: 'tcp',
      sourcePort: dstPort,
      destinationPort: srcPort,
      sequenceNumber: serverSeq,
      acknowledgementNumber: seg.sequenceNumber + 1,
      flags: { syn: true, ack: true, fin: false, rst: false, psh: false, urg: false },
      windowSize: 65535,
      checksum: 0,
      payload: null,
    };
    this.bindings.sendTcpFrame(serverIP, ipPkt.sourceIP, route, synAck);

    handler(serverConn);
  }

  private handleFin(
    portName: string,
    ipPkt: IPv4Packet,
    seg: TCPPacket,
    srcIp: string,
    srcPort: number,
    dstPort: number,
  ): void {
    const key = connKey(dstPort, srcIp, srcPort);
    const conn = this.connections.get(key);
    this.connections.delete(key);
    if (conn) {
      this.bindings.onConnectionClosed?.({
        localIp: this.bindings.getPortIp(portName)?.toString() ?? '',
        localPort: dstPort,
        remoteIp: srcIp,
        remotePort: srcPort,
        side: 'server',
      });
    }

    const myIp = this.bindings.getPortIp(portName);
    if (!myIp) return;
    const route = this.bindings.resolveRoute(ipPkt.sourceIP);
    if (!route) return;

    const finAck: TCPPacket = {
      type: 'tcp',
      sourcePort: dstPort,
      destinationPort: srcPort,
      sequenceNumber: seg.acknowledgementNumber,
      acknowledgementNumber: seg.sequenceNumber + 1,
      flags: { syn: false, ack: true, fin: false, rst: false, psh: false, urg: false },
      windowSize: 65535,
      checksum: 0,
      payload: null,
    };
    this.bindings.sendTcpFrame(myIp, ipPkt.sourceIP, route, finAck);
  }
}

function connKey(localPort: number, remoteIp: string, remotePort: number): string {
  return `${localPort}:${remoteIp}:${remotePort}`;
}
