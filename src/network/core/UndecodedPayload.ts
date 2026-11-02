import type { NetworkPdu } from './NetworkPdu';

export interface UndecodedPayload extends NetworkPdu {
  type: 'undecoded';
  bytes: Uint8Array;
}

export function undecodedPayload(bytes: Uint8Array): UndecodedPayload {
  return { type: 'undecoded', bytes };
}

export function isUndecodedPayload(value: unknown): value is UndecodedPayload {
  return !!value && typeof value === 'object' && (value as NetworkPdu).type === 'undecoded'
    && (value as UndecodedPayload).bytes instanceof Uint8Array;
}
