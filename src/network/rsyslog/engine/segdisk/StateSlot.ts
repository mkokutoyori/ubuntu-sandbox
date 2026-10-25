import { crc32c } from './Crc32c';
import { get16, get32, get64, get64Big, put16, put32, put64, signed64 } from './Bytes';

export const STATE_STORE_VERSION = 2;
export const CODEC_VERSION = 1;
export const STATE_SLOT_LENGTH = 256;
export const STATE_FILE_LENGTH = 2 * STATE_SLOT_LENGTH;
export const STATE_FLAG_RECOVERY = 1;
export const STATE_FLAG_DEMATERIALIZING = 2;

const STATE_MAGIC = 'RSSEGST2';
const UUID_AT = 12;
const GENERATION_AT = 28;

export interface StateImage {
  uuid: string;
  generation: number;
  flags: number;
  committedSegment: number;
  committedOffset: number;
  committedRecordSequence: number;
  firstLiveSegment: number;
  lastDataSegment: number;
  activeSegment: number;
  recoveryFirst: number;
  recoveryLast: number;
  nextSegment: number;
  knownQueueSize: number;
  bytes: number;
  segments: number;
  writerSegment: number;
  writerEnd: number;
  writerSequence: number;
  writerCount: number;
  deleteFirst: number;
  deleteLast: number;
  deleteBytes: number;
  deleteSegments: number;
}

export function encodeSlot(state: StateImage, generation: number): string {
  const body = STATE_MAGIC + put16(STATE_STORE_VERSION) + put16(CODEC_VERSION) + state.uuid + put64(generation) + put32(state.flags)
    + put64(state.committedSegment) + put64(state.committedOffset) + put64(state.committedRecordSequence)
    + put64(state.firstLiveSegment) + put64(state.lastDataSegment) + put64(state.activeSegment)
    + put64(state.recoveryFirst) + put64(state.recoveryLast) + put64(state.nextSegment) + put64(state.knownQueueSize)
    + put64(state.bytes) + put64(state.segments) + put64(state.writerSegment) + put64(state.writerEnd)
    + put64(state.writerSequence) + put64(state.writerCount) + put64(state.deleteFirst) + put64(state.deleteLast)
    + put64(state.deleteBytes) + put64(state.deleteSegments);
  const padded = body.padEnd(STATE_SLOT_LENGTH - 4, '\0');
  return padded + put32(crc32c(padded));
}

export function validateSlot(slot: string): boolean {
  return slot.length === STATE_SLOT_LENGTH && slot.startsWith(STATE_MAGIC) && get16(slot, 8) === STATE_STORE_VERSION
    && get16(slot, 10) === CODEC_VERSION && get32(slot, STATE_SLOT_LENGTH - 4) === crc32c(slot.slice(0, STATE_SLOT_LENGTH - 4));
}

export function decodeSlot(slot: string): StateImage {
  const field = (index: number): number => get64(slot, 36 + 4 + (index - 1) * 8);
  return {
    uuid: slot.slice(UUID_AT, UUID_AT + 16),
    generation: get64(slot, GENERATION_AT),
    flags: get32(slot, 36),
    committedSegment: field(1),
    committedOffset: signed64(field(2)),
    committedRecordSequence: field(3),
    firstLiveSegment: field(4),
    lastDataSegment: field(5),
    activeSegment: field(6),
    recoveryFirst: field(7),
    recoveryLast: field(8),
    nextSegment: field(9),
    knownQueueSize: field(10),
    bytes: signed64(field(11)),
    segments: field(12),
    writerSegment: field(13),
    writerEnd: signed64(field(14)),
    writerSequence: field(15),
    writerCount: field(16),
    deleteFirst: field(17),
    deleteLast: field(18),
    deleteBytes: signed64(field(19)),
    deleteSegments: field(20),
  };
}

export function generationNewer(candidate: bigint, reference: bigint): boolean {
  if (candidate === reference) return false;
  const modulus = 1n << 64n;
  const distance = candidate > reference ? candidate - reference : modulus - reference + candidate;
  return distance < (1n << 63n);
}

export function selectSlot(slot0: string | null, slot1: string | null): { state: StateImage; slot: 0 | 1 } | null {
  const valid0 = slot0 !== null && validateSlot(slot0);
  const valid1 = slot1 !== null && validateSlot(slot1);
  if (!valid0 && !valid1) return null;
  if (valid0 && valid1 && slot0.slice(UUID_AT, UUID_AT + 16) !== (slot1 as string).slice(UUID_AT, UUID_AT + 16)) return null;
  const generation0 = valid0 ? get64Big(slot0, GENERATION_AT) : 0n;
  const generation1 = valid1 ? get64Big(slot1 as string, GENERATION_AT) : 0n;
  if (valid0 && valid1 && generation0 !== generation1 && !generationNewer(generation0, generation1) && !generationNewer(generation1, generation0)) return null;
  const second = valid1 && (!valid0 || generationNewer(generation1, generation0));
  return second ? { state: decodeSlot(slot1 as string), slot: 1 } : { state: decodeSlot(slot0 as string), slot: 0 };
}
