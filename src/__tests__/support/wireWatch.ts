import type { EthernetFrame } from '@/network/core/types';
import type { Equipment } from '@/network/equipment/Equipment';
import type { FrameDirection } from '@/network/hardware/PortTap';

export interface WatchedFrame {
  readonly device: string;
  readonly iface: string;
  readonly direction: FrameDirection;
  readonly frame: EthernetFrame;
}

export interface WireWatch {
  readonly frames: WatchedFrame[];
  sent(): EthernetFrame[];
  received(): EthernetFrame[];
  clear(): void;
  stop(): void;
}

export function framesReceivedOn(device: Equipment, iface: string): EthernetFrame[] {
  const frames: EthernetFrame[] = [];
  device.attachCapture(({ direction, frame }) => {
    if (direction === 'in') frames.push(frame);
  }, iface);
  return frames;
}

export function framesSentOn(device: Equipment, iface?: string): EthernetFrame[] {
  const frames: EthernetFrame[] = [];
  device.attachCapture(({ direction, frame }) => {
    if (direction === 'out') frames.push(frame);
  }, iface);
  return frames;
}

export function watchWire(...devices: Equipment[]): WireWatch {
  const frames: WatchedFrame[] = [];
  const detaches = devices.map(device => device.attachCapture(({ iface, direction, frame }) => {
    frames.push({ device: device.getName(), iface, direction, frame });
  }));
  return {
    frames,
    sent: () => frames.filter(f => f.direction === 'out').map(f => f.frame),
    received: () => frames.filter(f => f.direction === 'in').map(f => f.frame),
    clear: () => { frames.length = 0; },
    stop: () => detaches.forEach(d => d()),
  };
}
