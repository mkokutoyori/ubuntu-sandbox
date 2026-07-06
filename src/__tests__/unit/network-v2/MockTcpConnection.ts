/**
 * MockTcpConnection — in-memory `TcpStream` test double.
 *
 * Replaces the `core/TcpConnection.ts` ghost class removed in PRD-TCP.md
 * P9 (it was never instantiated in production — real traffic goes through
 * `TcpSocket` in `tcp/TcpStack.ts`). A handful of SSH/SFTP suites still
 * want a lightweight bidirectional pipe that bypasses the real network
 * stack entirely, so this keeps that one legitimate use alive as a plain
 * test fixture instead of production source.
 */
import type { TCPPacket } from '@/network/core/types';

export class MockTcpConnection {
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

  onData(handler: (data: string) => void): () => void {
    this.dataHandlers.push(handler);
    return () => {
      const idx = this.dataHandlers.indexOf(handler);
      if (idx !== -1) this.dataHandlers.splice(idx, 1);
    };
  }

  /** Called by the test harness's own in-memory wiring when the "peer" sends data. */
  receiveData(data: string, remoteSeq?: number): void {
    if (remoteSeq !== undefined) {
      this.ackNum = remoteSeq + data.length;
    }
    for (const h of [...this.dataHandlers]) h(data);
  }
}
