import type { NetworkPdu } from '@/network/core/NetworkPdu';

export const ACH_FIRST_NIBBLE = 0x1;
export const ACH_VERSION = 0;

export const ChannelType = {
  BfdContinuityCheck: 0x0022,
  BfdConnectivityVerification: 0x0023,
  DirectLossMeasurement: 0x000a,
  InferredLossMeasurement: 0x000b,
  DelayMeasurement: 0x000c,
  DirectLossAndDelayMeasurement: 0x000d,
  InferredLossAndDelayMeasurement: 0x000e,
} as const;

export interface GachPayload extends NetworkPdu {
  type: 'gach';
  channelType: number;
  message: unknown;
}

export function isGachPayload(value: unknown): value is GachPayload {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'gach';
}

export function achWord(channelType: number): number {
  return ((ACH_FIRST_NIBBLE << 28) | (ACH_VERSION << 24) | channelType) >>> 0;
}

export function channelTypeOfAch(word: number): number | null {
  return (word >>> 28) === ACH_FIRST_NIBBLE && ((word >>> 24) & 0xf) === ACH_VERSION ? word & 0xffff : null;
}
