import { IPAddress } from '@/network/core/types';
import { ByteReader, ByteWriter } from '@/network/core/wire/ByteIo';
import { joinTimestamp, splitTimestamp, type NtpTimestamp } from '@/network/ntp/timestamp';

export const MPLS_ECHO_UDP_PORT = 3503;
export const MPLS_ECHO_VERSION = 1;
export const ECHO_HEADER_BYTES = 32;
export const ROUTER_ALERT_OPTION_VALUE = 0;

export const EchoMessageType = { Request: 1, Reply: 2 } as const;

export const ReplyMode = { NoReply: 1, Udp: 2, UdpRouterAlert: 3, ApplicationChannel: 4 } as const;

export const ReturnCode = {
  None: 0,
  Malformed: 1,
  TlvNotUnderstood: 2,
  Egress: 3,
  NoMapping: 4,
  DownstreamMismatch: 5,
  UpstreamInterfaceUnknown: 6,
  Switched: 8,
  SwitchedNoMplsForwarding: 9,
  MappingIsNotTheLabel: 10,
  NoLabelEntry: 11,
  ProtocolNotAssociated: 12,
  PrematureTermination: 13,
  SeeDdmap: 14,
  SwitchedWithFecChange: 15,
} as const;

export const GlobalFlag = { ValidateFecStack: 0x1, RespondOnlyIfTtlExpired: 0x2, ValidateReversePath: 0x4 } as const;

export const EchoTlvType = {
  TargetFecStack: 1,
  DownstreamMapping: 2,
  Pad: 3,
  VendorEnterpriseNumber: 5,
  InterfaceAndLabelStack: 7,
  ErroredTlvs: 9,
  ReplyTosByte: 10,
  DownstreamDetailedMapping: 20,
} as const;

export const PadInstruction = { DropFromReply: 1, CopyToReply: 2 } as const;

const FecSubType = { LdpIpv4: 1, VpnIpv4: 6, GenericIpv4: 14, Nil: 16 } as const;
const OPTIONAL_TLV_BIT = 0x8000;
const ADDRESS_TYPE_IPV4_NUMBERED = 1;

export interface LdpIpv4Fec { readonly kind: 'ldp-ipv4'; readonly prefix: IPAddress; readonly length: number }
export interface VpnIpv4Fec {
  readonly kind: 'vpn-ipv4';
  readonly routeDistinguisher: string;
  readonly prefix: IPAddress;
  readonly length: number;
}
export interface GenericIpv4Fec { readonly kind: 'generic-ipv4'; readonly prefix: IPAddress; readonly length: number }
export interface NilFec { readonly kind: 'nil'; readonly label: number }
export interface UnsupportedFec { readonly kind: 'unsupported'; readonly type: number; readonly value: Uint8Array }

export type TargetFec = LdpIpv4Fec | VpnIpv4Fec | GenericIpv4Fec | NilFec | UnsupportedFec;

export interface InterfaceAndLabelStack {
  readonly address: IPAddress;
  readonly interfaceAddress: IPAddress;
  readonly labels: readonly number[];
}

export interface ErroredTlv { readonly type: number; readonly value: Uint8Array }

export interface EchoMessage {
  readonly version: number;
  readonly globalFlags: number;
  readonly messageType: number;
  readonly replyMode: number;
  readonly returnCode: number;
  readonly returnSubcode: number;
  readonly senderHandle: number;
  readonly sequenceNumber: number;
  readonly timestampSent: NtpTimestamp;
  readonly timestampReceived: NtpTimestamp;
  readonly targetFecs: readonly TargetFec[];
  readonly pad: { readonly instruction: number; readonly length: number } | null;
  readonly replyTosByte: number | null;
  readonly interfaceAndLabelStack: InterfaceAndLabelStack | null;
  readonly erroredTlvs: readonly ErroredTlv[];
  readonly unrecognisedMandatory: readonly ErroredTlv[];
}

export class EchoDecodeError extends Error {}

export function newEchoMessage(fields: Partial<EchoMessage> & Pick<EchoMessage, 'messageType' | 'senderHandle' | 'sequenceNumber'>): EchoMessage {
  return {
    version: MPLS_ECHO_VERSION, globalFlags: 0, replyMode: ReplyMode.Udp, returnCode: ReturnCode.None, returnSubcode: 0,
    timestampSent: 0n, timestampReceived: 0n, targetFecs: [], pad: null, replyTosByte: null,
    interfaceAndLabelStack: null, erroredTlvs: [], unrecognisedMandatory: [], ...fields,
  };
}

export function encodeRouteDistinguisher(text: string): Uint8Array {
  const parts = text.split(':');
  const out = new ByteWriter();
  if (parts.length !== 2 || !/^\d+$/.test(parts[1])) throw new EchoDecodeError(`bad route distinguisher ${text}`);
  const assigned = Number(parts[1]);
  if (parts[0].includes('.')) return out.u16(1).bytes(new IPAddress(parts[0]).getOctets()).u16(assigned).toBytes();
  const administrator = Number(parts[0]);
  if (administrator > 0xffff) return out.u16(2).u32(administrator).u16(assigned).toBytes();
  return out.u16(0).u16(administrator).u32(assigned).toBytes();
}

export function decodeRouteDistinguisher(bytes: Uint8Array): string {
  const reader = new ByteReader(bytes);
  const type = reader.u16();
  if (type === 1) {
    return `${readAddress(reader)}:${reader.u16()}`;
  }
  if (type === 2) return `${reader.u32()}:${reader.u16()}`;
  return `${reader.u16()}:${reader.u32()}`;
}

function prefixBytes(prefix: IPAddress, length: number): number[] {
  return [...prefix.getOctets(), length];
}

function readAddress(reader: ByteReader): IPAddress {
  return IPAddress.fromUint32(reader.u32());
}

function padded(length: number): number {
  return (4 - (length % 4)) % 4;
}

function tlv(type: number, value: Uint8Array): Uint8Array {
  const out = new ByteWriter().u16(type).u16(value.length).bytes(value);
  for (let i = 0; i < padded(value.length); i++) out.u8(0);
  return out.toBytes();
}

function encodeFec(fec: TargetFec): Uint8Array {
  switch (fec.kind) {
    case 'ldp-ipv4': return tlv(FecSubType.LdpIpv4, Uint8Array.from(prefixBytes(fec.prefix, fec.length)));
    case 'generic-ipv4': return tlv(FecSubType.GenericIpv4, Uint8Array.from(prefixBytes(fec.prefix, fec.length)));
    case 'vpn-ipv4': {
      const value = new ByteWriter().bytes(encodeRouteDistinguisher(fec.routeDistinguisher))
        .bytes(prefixBytes(fec.prefix, fec.length)).toBytes();
      return tlv(FecSubType.VpnIpv4, value);
    }
    case 'nil': return tlv(FecSubType.Nil, new ByteWriter().u32(fec.label << 12).toBytes());
    case 'unsupported': return tlv(fec.type, fec.value);
  }
}

function decodeFec(type: number, value: Uint8Array): TargetFec {
  const reader = new ByteReader(value);
  if (type === FecSubType.LdpIpv4 || type === FecSubType.GenericIpv4) {
    if (value.length !== 5) throw new EchoDecodeError(`FEC sub-TLV ${type} has length ${value.length}`);
    const prefix = readAddress(reader);
    const length = reader.u8();
    if (length > 32) throw new EchoDecodeError(`prefix length ${length} out of range`);
    return { kind: type === FecSubType.LdpIpv4 ? 'ldp-ipv4' : 'generic-ipv4', prefix, length };
  }
  if (type === FecSubType.VpnIpv4) {
    if (value.length !== 13) throw new EchoDecodeError(`VPN IPv4 FEC has length ${value.length}`);
    const routeDistinguisher = decodeRouteDistinguisher(reader.take(8));
    const prefix = readAddress(reader);
    const length = reader.u8();
    if (length > 32) throw new EchoDecodeError(`prefix length ${length} out of range`);
    return { kind: 'vpn-ipv4', routeDistinguisher, prefix, length };
  }
  if (type === FecSubType.Nil) {
    if (value.length !== 4) throw new EchoDecodeError(`Nil FEC has length ${value.length}`);
    return { kind: 'nil', label: reader.u32() >>> 12 };
  }
  return { kind: 'unsupported', type, value };
}

function readTlvs(data: Uint8Array): Array<{ type: number; value: Uint8Array }> {
  const reader = new ByteReader(data);
  const out: Array<{ type: number; value: Uint8Array }> = [];
  while (reader.remaining > 0) {
    if (reader.remaining < 4) throw new EchoDecodeError('truncated TLV header');
    const type = reader.u16();
    const length = reader.u16();
    if (length > reader.remaining) throw new EchoDecodeError('TLV overruns the message');
    const value = reader.take(length);
    reader.take(Math.min(padded(length), reader.remaining));
    out.push({ type, value });
  }
  return out;
}

function decodeInterfaceAndLabelStack(value: Uint8Array): InterfaceAndLabelStack {
  const reader = new ByteReader(value);
  const addressType = reader.u8();
  reader.take(3);
  if (addressType !== ADDRESS_TYPE_IPV4_NUMBERED || value.length < 12 || (value.length - 12) % 4 !== 0) {
    throw new EchoDecodeError('unsupported Interface and Label Stack TLV');
  }
  const address = readAddress(reader);
  const interfaceAddress = readAddress(reader);
  const labels: number[] = [];
  while (reader.remaining > 0) labels.push(reader.u32() >>> 12);
  return { address, interfaceAddress, labels };
}

export function encodeEcho(message: EchoMessage): Uint8Array {
  const sent = splitTimestamp(message.timestampSent);
  const received = splitTimestamp(message.timestampReceived);
  const out = new ByteWriter()
    .u16(message.version).u16(message.globalFlags)
    .u8(message.messageType).u8(message.replyMode).u8(message.returnCode).u8(message.returnSubcode)
    .u32(message.senderHandle).u32(message.sequenceNumber)
    .u32(sent.seconds).u32(sent.fraction).u32(received.seconds).u32(received.fraction);
  if (message.targetFecs.length > 0) {
    const stack = new ByteWriter();
    for (const fec of message.targetFecs) stack.bytes(encodeFec(fec));
    out.bytes(tlv(EchoTlvType.TargetFecStack, stack.toBytes()));
  }
  if (message.pad !== null) {
    out.bytes(tlv(EchoTlvType.Pad, Uint8Array.from([message.pad.instruction, ...new Array(Math.max(message.pad.length - 1, 0)).fill(0)])));
  }
  if (message.replyTosByte !== null) out.bytes(tlv(EchoTlvType.ReplyTosByte, Uint8Array.from([message.replyTosByte, 0, 0, 0])));
  if (message.interfaceAndLabelStack !== null) {
    const { address, interfaceAddress, labels } = message.interfaceAndLabelStack;
    const value = new ByteWriter().u8(ADDRESS_TYPE_IPV4_NUMBERED).u8(0).u16(0)
      .bytes(address.getOctets()).bytes(interfaceAddress.getOctets());
    for (const label of labels) value.u32(label << 12);
    out.bytes(tlv(EchoTlvType.InterfaceAndLabelStack, value.toBytes()));
  }
  if (message.erroredTlvs.length > 0) {
    const nested = new ByteWriter();
    for (const errored of message.erroredTlvs) nested.bytes(tlv(errored.type, errored.value));
    out.bytes(tlv(EchoTlvType.ErroredTlvs, nested.toBytes()));
  }
  return out.toBytes();
}

export function decodeEcho(data: Uint8Array): EchoMessage {
  if (data.length < ECHO_HEADER_BYTES) throw new EchoDecodeError('echo message shorter than the fixed header');
  const reader = new ByteReader(data);
  const version = reader.u16();
  const globalFlags = reader.u16();
  const messageType = reader.u8();
  const replyMode = reader.u8();
  const returnCode = reader.u8();
  const returnSubcode = reader.u8();
  const senderHandle = reader.u32();
  const sequenceNumber = reader.u32();
  const timestampSent = joinTimestamp(reader.u32(), reader.u32());
  const timestampReceived = joinTimestamp(reader.u32(), reader.u32());
  let targetFecs: TargetFec[] = [];
  let pad: EchoMessage['pad'] = null;
  let replyTosByte: number | null = null;
  let interfaceAndLabelStack: InterfaceAndLabelStack | null = null;
  const erroredTlvs: ErroredTlv[] = [];
  const unrecognisedMandatory: ErroredTlv[] = [];
  for (const { type, value } of readTlvs(data.subarray(ECHO_HEADER_BYTES))) {
    switch (type) {
      case EchoTlvType.TargetFecStack:
        targetFecs = readTlvs(value).map(sub => decodeFec(sub.type, sub.value));
        break;
      case EchoTlvType.Pad:
        if (value.length < 1) throw new EchoDecodeError('empty Pad TLV');
        pad = { instruction: value[0], length: value.length };
        break;
      case EchoTlvType.VendorEnterpriseNumber:
        break;
      case EchoTlvType.ReplyTosByte:
        if (value.length !== 4) throw new EchoDecodeError('Reply TOS TLV must be 4 octets');
        replyTosByte = value[0];
        break;
      case EchoTlvType.InterfaceAndLabelStack:
        interfaceAndLabelStack = decodeInterfaceAndLabelStack(value);
        break;
      case EchoTlvType.ErroredTlvs:
        for (const nested of readTlvs(value)) erroredTlvs.push(nested);
        break;
      default:
        if ((type & OPTIONAL_TLV_BIT) === 0) unrecognisedMandatory.push({ type, value });
    }
  }
  return {
    version, globalFlags, messageType, replyMode, returnCode, returnSubcode, senderHandle, sequenceNumber,
    timestampSent, timestampReceived, targetFecs, pad, replyTosByte, interfaceAndLabelStack, erroredTlvs, unrecognisedMandatory,
  };
}
