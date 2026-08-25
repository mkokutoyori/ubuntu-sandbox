import type { EthernetFrame } from '../core/types';

export type FrameDirection = 'in' | 'out';

export interface TappedFrame {
  readonly iface: string;
  readonly direction: FrameDirection;
  readonly frame: EthernetFrame;
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

  emit(iface: string, direction: FrameDirection, frame: EthernetFrame): void {
    if (this.taps.size === 0) return;
    const tapped: TappedFrame = { iface, direction, frame };
    for (const tap of [...this.taps]) tap(tapped);
  }
}
