/**
 * TcpdumpCaptureProjection — feed the per-device {@link PacketCaptureLog}
 * from live TcpStack events so `tcpdump` shows real SYN / SYN-ACK / ACK /
 * FIN / RST segments produced by actual handshakes and closes.
 *
 * Before this projection, the capture log only held synthetic packets
 * appended by the ssh/telnet command wrappers — anything driven through
 * the real TcpStack (nc, tcpProbeSync, direct getTcpStack().connect()) was
 * invisible to `tcpdump`. The projection bridges the gap by subscribing to
 * both `tcp.segment.sent` and `tcp.segment.received` and recording each
 * segment in tcpdump's one-line form, with the bus's verbose flagsText
 * (`SYN|ACK`, `FIN|ACK`, …) collapsed into tcpdump's tokens (`S`, `S.`,
 * `.`, `F.`, `P.`, `R`).
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type {
  TcpSegmentSentPayload,
  TcpSegmentReceivedPayload,
} from '@/network/tcp/events';
import type { PacketCaptureLog } from './PacketCaptureLog';

export class TcpdumpCaptureProjection {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(
    bus: IEventBus,
    private readonly captureLog: PacketCaptureLog,
    private readonly deviceId: string,
  ) {
    this.subscriptions.push(
      bus.subscribe('tcp.segment.sent', (e) => this.onSegment(e.payload)),
      bus.subscribe('tcp.segment.received', (e) => this.onSegment(e.payload)),
    );
  }

  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  private onSegment(p: TcpSegmentSentPayload | TcpSegmentReceivedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.captureLog.capture({
      at: new Date(),
      srcIp: p.sourceIp,
      srcPort: p.sourcePort,
      dstIp: p.destinationIp,
      dstPort: p.destinationPort,
      flags: tcpdumpFlagToken(p.flagsText),
      seq: p.sequence,
      ack: p.acknowledgement,
      length: p.payloadSize,
    });
  }
}

/**
 * Collapse the bus's verbose flag string (`SYN|ACK`, `FIN|ACK`, `ACK`, …)
 * into the compact tcpdump token (`S.`, `F.`, `.`, …). The dot stands for
 * ACK; an empty token would print "Flags []" which tcpdump never emits.
 */
function tcpdumpFlagToken(flagsText: string): string {
  const set = new Set(flagsText.split('|'));
  const ackOn = set.has('ACK');
  if (set.has('SYN')) return ackOn ? 'S.' : 'S';
  if (set.has('FIN')) return ackOn ? 'F.' : 'F';
  if (set.has('RST')) return ackOn ? 'R.' : 'R';
  if (set.has('PSH')) return ackOn ? 'P.' : 'P';
  if (ackOn) return '.';
  return '(none)';
}
