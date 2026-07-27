import type { CapturedPacket } from './PacketCaptureLog';

export interface WireSegment {
  readonly srcIp: string;
  readonly srcPort: number;
  readonly dstIp: string;
  readonly dstPort: number;
  readonly flags: string;
  readonly seq: number;
  readonly ack: number;
  readonly payload: Uint8Array;
  /**
   * The machine that put this segment on the wire. Lets the capture
   * router deliver it by walking the topology from there instead of
   * scanning every device for a matching address
   * (docs/PRD-Frame-Only-Refactor.md P8).
   */
  readonly srcDevice?: object | null;
}

type Listener = (seg: WireSegment) => void;

class Bus {
  private readonly listeners = new Set<Listener>();
  publish(seg: WireSegment): void {
    for (const l of this.listeners) l(seg);
  }
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }
  reset(): void { this.listeners.clear(); }
}

const bus = new Bus();

export function publishWireSegment(seg: WireSegment): void { bus.publish(seg); }
export function subscribeWireSegments(l: Listener): () => void { return bus.subscribe(l); }
export function resetWireBus(): void { bus.reset(); }

export function wireSegmentToCapturedPacket(seg: WireSegment): CapturedPacket {
  return {
    at: new Date(),
    srcIp: seg.srcIp,
    srcPort: seg.srcPort,
    dstIp: seg.dstIp,
    dstPort: seg.dstPort,
    flags: seg.flags,
    seq: seg.seq,
    ack: seg.ack,
    length: seg.payload.length,
    payload: seg.payload,
  };
}
