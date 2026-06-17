/**
 * PacketCaptureLog — a per-device ring buffer of captured TCP packets.
 *
 * Real packet-sniffers (`tcpdump`, `wireshark`) read frames straight off
 * an interface. The simulator has no live SSH wire format, so traffic of
 * interest — TCP handshakes — is synthesized into this log at the moment
 * a connection is made, and `tcpdump` renders from it. The log is bounded
 * so a long-lived host does not grow without limit.
 */

/** One captured TCP segment, in the shape `tcpdump` prints. */
export interface CapturedPacket {
  readonly at: Date;
  readonly srcIp: string;
  readonly srcPort: number;
  readonly dstIp: string;
  readonly dstPort: number;
  /** tcpdump-style flag token: `S`, `S.`, `.`, `P.`, `F.`, `R`. */
  readonly flags: string;
  readonly seq: number;
  readonly ack: number;
  readonly length: number;
}

export class PacketCaptureLog {
  private readonly packets: CapturedPacket[] = [];
  private readonly listeners = new Set<(pkt: CapturedPacket) => void>();

  constructor(private readonly capacity = 256) {}

  /** Subscribe to live captures (tcpdump follow). Returns an unsubscribe. */
  subscribe(listener: (pkt: CapturedPacket) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Append one packet, evicting the oldest once capacity is exceeded. */
  capture(pkt: CapturedPacket): void {
    this.packets.push(pkt);
    if (this.packets.length > this.capacity) this.packets.shift();
    for (const listener of this.listeners) listener(pkt);
  }

  /**
   * Synthesize and record the three segments of a TCP three-way
   * handshake (SYN, SYN-ACK, ACK) between `src` and `dst`.
   */
  captureTcpHandshake(
    src: { ip: string; port: number },
    dst: { ip: string; port: number },
  ): void {
    const t = Date.now();
    this.capture({ at: new Date(t),     srcIp: src.ip, srcPort: src.port, dstIp: dst.ip, dstPort: dst.port, flags: 'S',  seq: 0, ack: 0, length: 0 });
    this.capture({ at: new Date(t + 1), srcIp: dst.ip, srcPort: dst.port, dstIp: src.ip, dstPort: src.port, flags: 'S.', seq: 0, ack: 1, length: 0 });
    this.capture({ at: new Date(t + 2), srcIp: src.ip, srcPort: src.port, dstIp: dst.ip, dstPort: dst.port, flags: '.',  seq: 1, ack: 1, length: 0 });
  }

  /** Every packet captured so far, oldest first. */
  all(): readonly CapturedPacket[] {
    return [...this.packets];
  }

  /** Packets whose source or destination port matches `port`. */
  onPort(port: number): CapturedPacket[] {
    return this.packets.filter((p) => p.srcPort === port || p.dstPort === port);
  }

  /** Drop every captured packet (e.g. on host power-off). */
  clear(): void {
    this.packets.length = 0;
  }
}
