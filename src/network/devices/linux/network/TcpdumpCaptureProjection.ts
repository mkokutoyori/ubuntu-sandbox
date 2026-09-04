/**
 * TcpdumpCaptureProjection — record the TCP segments no port tap can
 * ever see, so `tcpdump -i lo` shows them the way a real one does.
 *
 * `TcpStack.shipSegment` delivers a segment in process when the
 * destination is local — 127.0.0.1, ::1, or one of the machine's own
 * addresses — so no frame is built and no cable carries it. Everything
 * else leaves by a real port, where the tap already records the frame
 * with its window and options; recording it here as well would put the
 * same segment in the capture twice, the second copy poorer than the
 * first.
 *
 * Only `tcp.segment.sent` is read: a loopback segment is sent and
 * received by the same machine, and a real capture shows one packet.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { TcpSegmentSentPayload } from '@/network/tcp/events';
import type { PacketCaptureLog } from './PacketCaptureLog';

export const LOOPBACK_IFACE = 'lo';

export class TcpdumpCaptureProjection {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(
    bus: IEventBus,
    private readonly captureLog: PacketCaptureLog,
    private readonly deviceId: string,
  ) {
    this.subscriptions.push(
      bus.subscribe('tcp.segment.sent', (e) => this.onSegment(e.payload)),
    );
  }

  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  private onSegment(p: TcpSegmentSentPayload): void {
    if (p.deviceId !== this.deviceId) return;
    if (p.iface !== LOOPBACK_IFACE) return;
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
      iface: LOOPBACK_IFACE,
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
