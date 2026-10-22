import { ByteReader, ByteWriter } from '@/network/core/wire/ByteIo';

export const PM_VERSION = 0;

export const TimestampFormat = { Null: 0, SequenceNumber: 1, Ntp: 2, Ptp: 3 } as const;

export const QueryControlCode = { InBandResponse: 0x0, OutOfBandResponse: 0x1, NoResponse: 0x2 } as const;

export const ResponseControlCode = {
  Success: 0x1,
  DataFormatInvalid: 0x2,
  InitializationInProgress: 0x3,
  DataReset: 0x4,
  ResourceTemporarilyUnavailable: 0x5,
  UnspecifiedError: 0x10,
  UnsupportedVersion: 0x11,
  UnsupportedControlCode: 0x12,
  UnsupportedDataFormat: 0x13,
  AuthenticationFailure: 0x14,
  InvalidDestinationNode: 0x15,
  ConnectionMismatch: 0x16,
  UnsupportedMandatoryTlv: 0x17,
  UnsupportedQueryInterval: 0x18,
  AdministrativeBlock: 0x19,
  ResourceUnavailable: 0x1a,
  ResourceReleased: 0x1b,
  InvalidMessage: 0x1c,
  ProtocolError: 0x1d,
} as const;

const FLAG_RESPONSE = 0x8;
const FLAG_TRAFFIC_CLASS = 0x4;
const DFLAG_EXTENDED = 0x8;
const DFLAG_OCTETS = 0x4;
const LM_LENGTH = 52;
const DM_LENGTH = 44;
const SESSION_BITS = 26;
const SESSION_MASK = (1 << SESSION_BITS) - 1;
const DS_MASK = 0x3f;

export class PerformanceDecodeError extends Error {}

export interface LossMeasurementMessage {
  readonly response: boolean;
  readonly trafficClassSpecific: boolean;
  readonly controlCode: number;
  readonly extendedCounters: boolean;
  readonly octetCounts: boolean;
  readonly originTimestampFormat: number;
  readonly sessionId: number;
  readonly ds: number;
  readonly originTimestamp: bigint;
  readonly counters: readonly [bigint, bigint, bigint, bigint];
}

export interface DelayMeasurementMessage {
  readonly response: boolean;
  readonly controlCode: number;
  readonly querierTimestampFormat: number;
  readonly responderTimestampFormat: number;
  readonly responderPreferredFormat: number;
  readonly sessionId: number;
  readonly ds: number;
  readonly timestamps: readonly [bigint, bigint, bigint, bigint];
}

function u64(writer: ByteWriter, value: bigint): void {
  writer.u32(Number((value >> 32n) & 0xffffffffn)).u32(Number(value & 0xffffffffn));
}

function readU64(reader: ByteReader): bigint {
  return (BigInt(reader.u32()) << 32n) | BigInt(reader.u32());
}

function header(flags: number, controlCode: number, length: number): ByteWriter {
  return new ByteWriter().u8((PM_VERSION << 4) | flags).u8(controlCode).u16(length);
}

function sessionWord(sessionId: number, ds: number): number {
  return (((sessionId & SESSION_MASK) << 6) | (ds & DS_MASK)) >>> 0;
}

export function encodeLoss(message: LossMeasurementMessage): Uint8Array {
  const flags = (message.response ? FLAG_RESPONSE : 0) | (message.trafficClassSpecific ? FLAG_TRAFFIC_CLASS : 0);
  const out = header(flags, message.controlCode, LM_LENGTH)
    .u8(((message.extendedCounters ? DFLAG_EXTENDED : 0) | (message.octetCounts ? DFLAG_OCTETS : 0)) << 4 | message.originTimestampFormat)
    .u8(0).u16(0)
    .u32(sessionWord(message.sessionId, message.ds));
  u64(out, message.originTimestamp);
  for (const counter of message.counters) u64(out, counter);
  return out.toBytes();
}

export function decodeLoss(bytes: Uint8Array): LossMeasurementMessage {
  if (bytes.length < LM_LENGTH) throw new PerformanceDecodeError('loss measurement message too short');
  const reader = new ByteReader(bytes);
  const first = reader.u8();
  const controlCode = reader.u8();
  const length = reader.u16();
  if ((first >> 4) !== PM_VERSION) throw new PerformanceDecodeError('unsupported version');
  if (length !== bytes.length) throw new PerformanceDecodeError('message length mismatch');
  const formats = reader.u8();
  reader.u8();
  reader.u16();
  const word = reader.u32();
  const originTimestamp = readU64(reader);
  const counters = [readU64(reader), readU64(reader), readU64(reader), readU64(reader)] as const;
  const dflags = formats >> 4;
  return {
    response: (first & FLAG_RESPONSE) !== 0, trafficClassSpecific: (first & FLAG_TRAFFIC_CLASS) !== 0, controlCode,
    extendedCounters: (dflags & DFLAG_EXTENDED) !== 0, octetCounts: (dflags & DFLAG_OCTETS) !== 0,
    originTimestampFormat: formats & 0xf, sessionId: word >>> 6, ds: word & DS_MASK, originTimestamp, counters,
  };
}

export function encodeDelay(message: DelayMeasurementMessage): Uint8Array {
  const flags = (message.response ? FLAG_RESPONSE : 0) | FLAG_TRAFFIC_CLASS;
  const out = header(flags, message.controlCode, DM_LENGTH)
    .u8((message.querierTimestampFormat << 4) | message.responderTimestampFormat)
    .u8(message.responderPreferredFormat << 4).u16(0)
    .u32(sessionWord(message.sessionId, message.ds));
  for (const timestamp of message.timestamps) u64(out, timestamp);
  return out.toBytes();
}

export function decodeDelay(bytes: Uint8Array): DelayMeasurementMessage {
  if (bytes.length < DM_LENGTH) throw new PerformanceDecodeError('delay measurement message too short');
  const reader = new ByteReader(bytes);
  const first = reader.u8();
  const controlCode = reader.u8();
  const length = reader.u16();
  if ((first >> 4) !== PM_VERSION) throw new PerformanceDecodeError('unsupported version');
  if (length !== bytes.length) throw new PerformanceDecodeError('message length mismatch');
  const formats = reader.u8();
  const preferred = reader.u8();
  reader.u16();
  const word = reader.u32();
  const timestamps = [readU64(reader), readU64(reader), readU64(reader), readU64(reader)] as const;
  return {
    response: (first & FLAG_RESPONSE) !== 0, controlCode, querierTimestampFormat: formats >> 4, responderTimestampFormat: formats & 0xf,
    responderPreferredFormat: preferred >> 4, sessionId: word >>> 6, ds: word & DS_MASK, timestamps,
  };
}
