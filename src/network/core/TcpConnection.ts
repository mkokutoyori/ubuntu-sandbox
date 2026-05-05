/**
 * TcpConnection — bidirectional TCP stream (RFC 793 simplified).
 *
 * A lightweight value-object representing one side of an established TCP
 * connection.  It carries sequence/acknowledgement counters and delegates
 * actual frame delivery to a caller-supplied `sendFn` so the transport can
 * be either a real IPv4 path through the network stack (EndHost) or an
 * in-memory pipe (unit tests).
 *
 * Data handlers are registered with `onData()` and fire synchronously when
 * `receiveData()` is called — which happens inside `EndHost.handleTCP()` as
 * the TCP segment traverses the (synchronous) cable/switch/router delivery
 * chain.  This means `write()` → network traversal → remote `onData()` is
 * entirely synchronous once the initial ARP has been resolved.
 */

import type { TCPPacket } from './types';

/** Callback type that creates a TcpConnection to a remote host:port. */
export type TcpConnector = (host: string, port: number) => Promise<TcpConnection | null>;

export class TcpConnection {
  private readonly dataHandlers: Array<(data: string) => void> = [];
  private seqNum: number;
  private ackNum = 0;

  constructor(
    readonly localIp: string,
    readonly localPort: number,
    readonly remoteIp: string,
    readonly remotePort: number,
    initialSeq: number,
    private readonly sendFn: (seg: TCPPacket) => void,
  ) {
    this.seqNum = initialSeq;
  }

  // ─── Sending ──────────────────────────────────────────────────────────

  write(data: string): void {
    const seg: TCPPacket = {
      type: 'tcp',
      sourcePort: this.localPort,
      destinationPort: this.remotePort,
      sequenceNumber: this.seqNum,
      acknowledgementNumber: this.ackNum,
      flags: { syn: false, ack: true, fin: false, rst: false, psh: true, urg: false },
      windowSize: 65535,
      checksum: 0,
      payload: data,
    };
    this.seqNum += data.length;
    this.sendFn(seg);
  }

  close(): void {
    const seg: TCPPacket = {
      type: 'tcp',
      sourcePort: this.localPort,
      destinationPort: this.remotePort,
      sequenceNumber: this.seqNum,
      acknowledgementNumber: this.ackNum,
      flags: { syn: false, ack: true, fin: true, rst: false, psh: false, urg: false },
      windowSize: 65535,
      checksum: 0,
      payload: null,
    };
    this.sendFn(seg);
  }

  // ─── Receiving ────────────────────────────────────────────────────────

  /**
   * Register a persistent data handler.
   * Returns an unsubscribe function.
   */
  onData(handler: (data: string) => void): () => void {
    this.dataHandlers.push(handler);
    return () => {
      const idx = this.dataHandlers.indexOf(handler);
      if (idx !== -1) this.dataHandlers.splice(idx, 1);
    };
  }

  /** Called by the network stack when a data segment arrives. */
  receiveData(data: string, remoteSeq?: number): void {
    if (remoteSeq !== undefined) {
      this.ackNum = remoteSeq + data.length;
    }
    for (const h of [...this.dataHandlers]) h(data);
  }

  /** Update acknowledgement number after receiving a control segment (SYN/FIN). */
  updateAck(remoteSeq: number, dataLen: number): void {
    this.ackNum = remoteSeq + dataLen;
  }
}
