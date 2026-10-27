import type { SyslogTime, OffsetMode, SyslogTimeType } from '@/network/syslog/codec/SyslogTime';
import type { MessageImage } from '../MessageCodec';
import { get16, get32, get64, put16, put32, put64, utf8Bytes, utf8Text } from './Bytes';

const HEADER_LENGTH = 8;
const CRITICAL = 0x01;
export const MAX_PAYLOAD = 128 * 1024 * 1024;
const TIME_LENGTH = 20;

const TYPE_U8 = 1;
const TYPE_U16 = 2;
const TYPE_U32 = 3;
const TYPE_U64 = 4;
const TYPE_BYTES = 5;
const TYPE_TIME = 6;

const FIELD = {
  protocol: 1, severity: 2, facility: 3, flags: 4, genTime: 5, received: 6, timestamp: 7, tag: 8, rawMsg: 9, hostname: 10,
  inputName: 11, rcvFrom: 12, rcvFromIp: 13, rcvFromPort: 14, structuredData: 15, json: 16, localVars: 17, appName: 18,
  procId: 19, msgId: 20, uuid: 21, ruleset: 22, msgOffset: 23, afterPriOffset: 24, parseSuccess: 25,
} as const;

export class RecordCodecError extends Error {}

function tlv(field: number, type: number, data: string, flags = 0): string {
  return put16(field) + String.fromCharCode(type, flags) + put32(data.length) + data;
}

function bytesField(field: number, text: string | null): string {
  return text === null ? '' : tlv(field, TYPE_BYTES, utf8Bytes(text));
}

function timeField(field: number, time: SyslogTime): string {
  const mode = time.offsetMode === '' ? 0 : time.offsetMode.charCodeAt(0);
  return tlv(field, TYPE_TIME, String.fromCharCode(time.timeType, time.month, time.day, 0, time.hour, time.minute, time.second, time.secfracPrecision, time.offsetMinute, time.offsetHour, mode, 0)
    + put16(time.year) + put32(time.secfrac) + '\0\0');
}

function decodeTime(data: string): SyslogTime {
  if (data.length !== TIME_LENGTH) throw new RecordCodecError('invalid time field');
  const mode = data.charCodeAt(10);
  return {
    timeType: data.charCodeAt(0) as SyslogTimeType,
    year: get16(data, 12),
    month: data.charCodeAt(1),
    day: data.charCodeAt(2),
    hour: data.charCodeAt(4),
    minute: data.charCodeAt(5),
    second: data.charCodeAt(6),
    secfrac: get32(data, 14),
    secfracPrecision: data.charCodeAt(7),
    offsetMode: (mode === 0 ? '' : String.fromCharCode(mode)) as OffsetMode,
    offsetHour: data.charCodeAt(9),
    offsetMinute: data.charCodeAt(8),
  };
}

function afterPriOffset(rawMsg: string): number {
  const match = /^<\d{1,3}>/.exec(rawMsg);
  return match === null ? 0 : match[0].length;
}

export function encodeImage(image: MessageImage): string {
  const rawBytes = utf8Bytes(image.rawMsg);
  const offsetBytes = utf8Bytes(image.rawMsg.slice(0, image.offset)).length;
  const payload = tlv(FIELD.protocol, TYPE_U16, put16(image.protocolVersion))
    + tlv(FIELD.severity, TYPE_U16, put16(image.severity))
    + tlv(FIELD.facility, TYPE_U16, put16(image.facility))
    + tlv(FIELD.flags, TYPE_U32, put32(image.flags))
    + tlv(FIELD.genTime, TYPE_U64, put64(image.generatedAt))
    + timeField(FIELD.received, image.receivedAt)
    + timeField(FIELD.timestamp, image.timestamp)
    + bytesField(FIELD.tag, image.tag)
    + tlv(FIELD.rawMsg, TYPE_BYTES, rawBytes)
    + bytesField(FIELD.hostname, image.hostname)
    + bytesField(FIELD.inputName, image.inputName)
    + bytesField(FIELD.rcvFrom, image.fromHost)
    + bytesField(FIELD.rcvFromIp, image.fromHostIp)
    + bytesField(FIELD.rcvFromPort, image.fromHostPort)
    + bytesField(FIELD.structuredData, image.structuredData)
    + bytesField(FIELD.json, image.json)
    + bytesField(FIELD.localVars, image.localVariables)
    + bytesField(FIELD.appName, image.appName)
    + bytesField(FIELD.procId, image.procId)
    + bytesField(FIELD.msgId, image.msgId)
    + bytesField(FIELD.ruleset, image.ruleset)
    + tlv(FIELD.msgOffset, TYPE_U32, put32(offsetBytes))
    + tlv(FIELD.afterPriOffset, TYPE_U32, put32(afterPriOffset(image.rawMsg)))
    + tlv(FIELD.parseSuccess, TYPE_U8, '\u0001');
  if (payload.length > MAX_PAYLOAD) throw new RecordCodecError('record too large');
  return payload;
}

interface Draft {
  protocolVersion: number;
  severity: number;
  facility: number;
  flags: number;
  generatedAt: number;
  receivedAt: SyslogTime | null;
  timestamp: SyslogTime | null;
  tag: string;
  rawMsg: string | null;
  offsetBytes: number | null;
  hostname: string | null;
  inputName: string;
  fromHost: string;
  fromHostIp: string;
  fromHostPort: string;
  structuredData: string | null;
  json: string | null;
  localVariables: string | null;
  appName: string | null;
  procId: string | null;
  msgId: string | null;
  ruleset: string | null;
}

function expect(condition: boolean): void {
  if (!condition) throw new RecordCodecError('invalid field');
}

export function decodeImage(payload: string): MessageImage {
  const draft: Draft = {
    protocolVersion: 0, severity: 0, facility: 0, flags: 0, generatedAt: 0, receivedAt: null, timestamp: null, tag: '',
    rawMsg: null, offsetBytes: null, hostname: null, inputName: '', fromHost: '', fromHostIp: '', fromHostPort: '',
    structuredData: null, json: null, localVariables: null, appName: null, procId: null, msgId: null, ruleset: null,
  };
  const seen = new Set<number>();
  let at = 0;
  while (at < payload.length) {
    if (payload.length - at < HEADER_LENGTH) throw new RecordCodecError('truncated header');
    const field = get16(payload, at);
    const type = payload.charCodeAt(at + 2);
    const flags = payload.charCodeAt(at + 3);
    const length = get32(payload, at + 4);
    at += HEADER_LENGTH;
    if (length > MAX_PAYLOAD || length > payload.length - at) throw new RecordCodecError('truncated field');
    const data = payload.slice(at, at + length);
    if (field >= 1 && field <= 31) {
      if (seen.has(field)) throw new RecordCodecError('duplicate field');
      seen.add(field);
    }
    const text = (): string => {
      expect(type === TYPE_BYTES);
      return utf8Text(data);
    };
    switch (field) {
      case FIELD.protocol: expect(type === TYPE_U16 && length === 2); draft.protocolVersion = get16(data, 0); break;
      case FIELD.severity: expect(type === TYPE_U16 && length === 2); draft.severity = get16(data, 0); break;
      case FIELD.facility: expect(type === TYPE_U16 && length === 2); draft.facility = get16(data, 0); break;
      case FIELD.flags: expect(type === TYPE_U32 && length === 4); draft.flags = get32(data, 0); break;
      case FIELD.genTime: expect(type === TYPE_U64 && length === 8); draft.generatedAt = get64(data, 0); break;
      case FIELD.received: expect(type === TYPE_TIME && length === TIME_LENGTH); draft.receivedAt = decodeTime(data); break;
      case FIELD.timestamp: expect(type === TYPE_TIME && length === TIME_LENGTH); draft.timestamp = decodeTime(data); break;
      case FIELD.tag: draft.tag = text(); break;
      case FIELD.rawMsg: draft.rawMsg = text(); break;
      case FIELD.hostname: draft.hostname = text(); break;
      case FIELD.inputName: draft.inputName = text(); break;
      case FIELD.rcvFrom: draft.fromHost = text(); break;
      case FIELD.rcvFromIp: draft.fromHostIp = text(); break;
      case FIELD.rcvFromPort: draft.fromHostPort = text(); break;
      case FIELD.structuredData: draft.structuredData = text(); break;
      case FIELD.json: draft.json = text(); break;
      case FIELD.localVars: draft.localVariables = text(); break;
      case FIELD.appName: draft.appName = text(); break;
      case FIELD.procId: draft.procId = text(); break;
      case FIELD.msgId: draft.msgId = text(); break;
      case FIELD.uuid: text(); break;
      case FIELD.ruleset: draft.ruleset = text(); break;
      case FIELD.msgOffset: expect(type === TYPE_U32 && length === 4); draft.offsetBytes = get32(data, 0); break;
      case FIELD.afterPriOffset: expect(type === TYPE_U32 && length === 4); break;
      case FIELD.parseSuccess: expect(type === TYPE_U8 && length === 1); break;
      default:
        if ((flags & CRITICAL) !== 0) throw new RecordCodecError('unknown critical field');
    }
    at += length;
  }
  if (draft.rawMsg === null || draft.offsetBytes === null || draft.receivedAt === null || draft.timestamp === null) throw new RecordCodecError('missing mandatory field');
  const rawBytes = utf8Bytes(draft.rawMsg);
  const offset = utf8Text(rawBytes.slice(0, draft.offsetBytes)).length;
  return {
    protocolVersion: draft.protocolVersion,
    severity: draft.severity,
    facility: draft.facility,
    flags: draft.flags,
    generatedAt: draft.generatedAt,
    receivedAt: draft.receivedAt,
    timestamp: draft.timestamp,
    tag: draft.tag,
    rawMsg: draft.rawMsg,
    offset,
    hostname: draft.hostname,
    inputName: draft.inputName,
    fromHost: draft.fromHost,
    fromHostIp: draft.fromHostIp,
    fromHostPort: draft.fromHostPort,
    structuredData: draft.structuredData,
    json: draft.json,
    localVariables: draft.localVariables,
    appName: draft.appName,
    procId: draft.procId,
    msgId: draft.msgId,
    ruleset: draft.ruleset,
  };
}
