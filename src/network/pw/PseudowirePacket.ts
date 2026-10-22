import type { NetworkPdu } from '@/network/core/NetworkPdu';
import type { EthernetFrame } from '@/network/core/types';

export const PW_CONTROL_WORD_BYTES = 4;

export interface PseudowirePayload extends NetworkPdu {
  type: 'pw-ethernet';
  controlWord: number | null;
  frame: EthernetFrame;
}

export function isPseudowirePayload(value: unknown): value is PseudowirePayload {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'pw-ethernet';
}

export function controlWordOf(sequenceNumber: number): number {
  return sequenceNumber & 0xffff;
}

export function isValidControlWord(word: number): boolean {
  return (word >>> 28) === 0;
}
