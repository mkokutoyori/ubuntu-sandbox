import { payloadBytes } from '@/network/layers/transport/L4Checksum';

export type StreamPayload = string | Uint8Array;

export function isStreamPayload(value: unknown): value is StreamPayload {
  return typeof value === 'string' || value instanceof Uint8Array;
}

export function sliceStream(payload: StreamPayload, start: number, end?: number): StreamPayload {
  return typeof payload === 'string' ? payload.slice(start, end) : payload.slice(start, end);
}

export function appendStream(left: StreamPayload | null, right: StreamPayload): StreamPayload {
  if (left === null || left.length === 0) return right;
  if (typeof left === 'string' && typeof right === 'string') return left + right;
  const head = typeof left === 'string' ? new Uint8Array(payloadBytes(left)) : left;
  const tail = typeof right === 'string' ? new Uint8Array(payloadBytes(right)) : right;
  const joined = new Uint8Array(head.length + tail.length);
  joined.set(head, 0);
  joined.set(tail, head.length);
  return joined;
}
