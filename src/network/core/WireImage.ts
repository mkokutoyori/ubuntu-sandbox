import type { EthernetFrame } from './types';

const images = new WeakMap<EthernetFrame, Uint8Array>();

export function attachWireImage(frame: EthernetFrame, bytes: Uint8Array): void {
  images.set(frame, bytes);
}

export function wireImageOf(frame: EthernetFrame): Uint8Array | undefined {
  return images.get(frame);
}
