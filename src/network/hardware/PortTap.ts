import type { EthernetFrame } from '../core/types';
import { lineageOf, orderedDelivery } from './FrameLineage';

export type FrameDirection = 'in' | 'out';

export interface TappedFrame {
  readonly iface: string;
  readonly direction: FrameDirection;
  readonly frame: EthernetFrame;
  readonly seq: number;
  readonly at: Date;
  readonly atMicros: number;
}

export type FrameTap = (tapped: TappedFrame) => void;

export type DetachTap = () => void;

export class TapPoint {
  private readonly taps = new Set<FrameTap>();

  attach(tap: FrameTap): DetachTap {
    this.taps.add(tap);
    return () => { this.taps.delete(tap); };
  }

  get size(): number { return this.taps.size; }

  emit(iface: string, direction: FrameDirection, frame: EthernetFrame, observedAtMicros?: () => number): void {
    if (this.taps.size === 0) return;
    const { seq, at } = lineageOf(frame);
    const atMicros = observedAtMicros?.() ?? at.getTime() * 1000;
    const tapped: TappedFrame = { iface, direction, frame, seq, at: new Date(Math.floor(atMicros / 1000)), atMicros };
    for (const tap of [...this.taps]) tap(tapped);
  }
}

export interface FrameSource {
  attachCapture(tap: FrameTap, iface?: string): DetachTap;
}

export function attachOrderedCapture(source: FrameSource, tap: FrameTap, iface?: string): DetachTap {
  const delivery = orderedDelivery(tap);
  const detach = source.attachCapture(delivery.push, iface);
  return () => { delivery.flush(); detach(); };
}
