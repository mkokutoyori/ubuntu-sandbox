/**
 * HighWatermarkVector — per-originating-DC "highest USN already seen"
 * (PRD-Windows-Server-Advanced.md §5 P4, inspired by MS-DRSR's
 * up-to-dateness vector): a replication puller sends its vector so the
 * partner only returns objects it hasn't seen yet, and the puller
 * advances its own vector as it applies each incoming object.
 */

export interface HighWatermarkVector {
  readonly usnByInvocationId: Map<string, number>;
}

export function emptyHighWatermarkVector(): HighWatermarkVector {
  return { usnByInvocationId: new Map() };
}

export function highestKnownUsn(vector: HighWatermarkVector, invocationId: string): number {
  return vector.usnByInvocationId.get(invocationId) ?? 0;
}

/** Advances the vector's entry for `invocationId` — a no-op if `usn` doesn't move it forward (USNs only ever increase). */
export function recordUsn(vector: HighWatermarkVector, invocationId: string, usn: number): void {
  if (usn > highestKnownUsn(vector, invocationId)) vector.usnByInvocationId.set(invocationId, usn);
}

export function cloneHighWatermarkVector(vector: HighWatermarkVector): HighWatermarkVector {
  return { usnByInvocationId: new Map(vector.usnByInvocationId) };
}

/** JSON-serializable form for the replication wire protocol (a `Map` doesn't survive `JSON.stringify` directly). */
export type HighWatermarkVectorWire = [string, number][];

export function encodeHighWatermarkVector(vector: HighWatermarkVector): HighWatermarkVectorWire {
  return [...vector.usnByInvocationId.entries()];
}

export function decodeHighWatermarkVector(wire: HighWatermarkVectorWire): HighWatermarkVector {
  return { usnByInvocationId: new Map(wire) };
}
