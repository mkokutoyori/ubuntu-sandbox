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

export const DdmapSubTlv = { Multipath: 1, LabelStack: 2, FecStackChange: 3 } as const;
export const DdmapAddressType = { Ipv4Numbered: 1, Ipv4Unnumbered: 2 } as const;
export const DdmapProtocol = { Unknown: 0, Static: 1, Bgp: 2, Ldp: 3, RsvpTe: 4 } as const;
export const DDMAP_UNKNOWN_DOWNSTREAM = '127.0.0.1';
export const DDMAP_ALL_ROUTERS = '224.0.0.2';

export const PadInstruction = { DropFromReply: 1, CopyToReply: 2 } as const;

const FecSubType = { LdpIpv4: 1, VpnIpv4: 6, Pseudowire128: 10, GenericIpv4: 14, Nil: 16 } as const;
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
export interface Pseudowire128Fec {
  readonly kind: 'pw-ipv4';
  readonly sender: IPAddress;
  readonly remote: IPAddress;
  readonly pwId: number;
  readonly pwType: number;
}
export interface NilFec { readonly kind: 'nil'; readonly label: number }
export interface UnsupportedFec { readonly kind: 'unsupported'; readonly type: number; readonly value: Uint8Array }

export type TargetFec = LdpIpv4Fec | VpnIpv4Fec | GenericIpv4Fec | Pseudowire128Fec | NilFec | UnsupportedFec;

export interface InterfaceAndLabelStack {
  readonly address: IPAddress;
  readonly interfaceAddress: IPAddress;
  readonly labels: readonly number[];
}

export interface DdmapLabel { readonly label: number; readonly protocol: number }

export interface FecStackChange {
  readonly operation: 'push' | 'pop';
  readonly peer: IPAddress | null;
  readonly fec: TargetFec | null;
}

export interface Ddmap {
  readonly mtu: number;
  readonly addressType: number;
  readonly interfaceAndLabelStackRequested: boolean;
  readonly nonIp: boolean;
  readonly downstreamAddress: IPAddress;
  readonly downstreamInterface: IPAddress;
  readonly returnCode: number;
  readonly returnSubcode: number;
  readonly multipathType: number;
  readonly multipathInformation: Uint8Array;
  readonly labelStack: readonly DdmapLabel[];
  readonly fecStackChanges: readonly FecStackChange[];
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
  readonly ddmaps: readonly Ddmap[];
  readonly erroredTlvs: readonly ErroredTlv[];
  readonly unrecognisedMandatory: readonly ErroredTlv[];
}

export class EchoDecodeError extends Error {}

export function newEchoMessage(fields: Partial<EchoMessage> & Pick<EchoMessage, 'messageType' | 'senderHandle' | 'sequenceNumber'>): EchoMessage {
  return {
    version: MPLS_ECHO_VERSION, globalFlags: 0, replyMode: ReplyMode.Udp, returnCode: ReturnCode.None, returnSubcode: 0,
    timestampSent: 0n, timestampReceived: 0n, targetFecs: [], pad: null, replyTosByte: null,
    interfaceAndLabelStack: null, ddmaps: [], erroredTlvs: [], unrecognisedMandatory: [], ...fields,
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
    case 'pw-ipv4': {
      const value = new ByteWriter().bytes(fec.sender.getOctets()).bytes(fec.remote.getOctets())
        .u32(fec.pwId).u16(fec.pwType).u16(0).toBytes();
      return tlv(FecSubType.Pseudowire128, value);
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
  if (type === FecSubType.Pseudowire128) {
    if (value.length !== 14 && value.length !== 16) throw new EchoDecodeError(`FEC 128 has length ${value.length}`);
    const sender = readAddress(reader);
    const remote = readAddress(reader);
    const pwId = reader.u32();
    const pwType = reader.u16() & 0x7fff;
    return { kind: 'pw-ipv4', sender, remote, pwId, pwType };
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

const DDMAP_FIXED_BYTES = 16;
const FLAG_INTERFACE_AND_LABEL_STACK = 0x2;
const FLAG_NON_IP = 0x1;
const FEC_STACK_OPERATION = { push: 1, pop: 2 } as const;

function encodeDdmap(ddmap: Ddmap): Uint8Array {
  const subTlvs = new ByteWriter();
  subTlvs.bytes(tlv(DdmapSubTlv.Multipath, new ByteWriter()
    .u8(ddmap.multipathType).u16(ddmap.multipathInformation.length).u8(0).bytes(ddmap.multipathInformation).toBytes()));
  const stack = new ByteWriter();
  ddmap.labelStack.forEach((entry, index) => {
    const last = index === ddmap.labelStack.length - 1;
    stack.u8((entry.label >>> 12) & 0xff).u8((entry.label >>> 4) & 0xff).u8(((entry.label & 0xf) << 4) | (last ? 1 : 0)).u8(entry.protocol);
  });
  subTlvs.bytes(tlv(DdmapSubTlv.LabelStack, stack.toBytes()));
  for (const change of ddmap.fecStackChanges) {
    const fec = change.fec === null ? new Uint8Array(0) : encodeFec(change.fec);
    subTlvs.bytes(tlv(DdmapSubTlv.FecStackChange, new ByteWriter()
      .u8(FEC_STACK_OPERATION[change.operation]).u8(change.peer === null ? 0 : 1).u8(fec.length).u8(0)
      .bytes(change.peer === null ? new Uint8Array(0) : change.peer.getOctets()).bytes(fec).toBytes()));
  }
  const body = subTlvs.toBytes();
  const flags = (ddmap.interfaceAndLabelStackRequested ? FLAG_INTERFACE_AND_LABEL_STACK : 0) | (ddmap.nonIp ? FLAG_NON_IP : 0);
  return tlv(EchoTlvType.DownstreamDetailedMapping, new ByteWriter()
    .u16(ddmap.mtu).u8(ddmap.addressType).u8(flags)
    .bytes(ddmap.downstreamAddress.getOctets()).bytes(ddmap.downstreamInterface.getOctets())
    .u8(ddmap.returnCode).u8(ddmap.returnSubcode).u16(body.length).bytes(body).toBytes());
}

function decodeDdmap(value: Uint8Array): Ddmap | null {
  if (value.length < DDMAP_FIXED_BYTES) throw new EchoDecodeError('Downstream Detailed Mapping shorter than its fixed part');
  const reader = new ByteReader(value);
  const mtu = reader.u16();
  const addressType = reader.u8();
  if (addressType !== DdmapAddressType.Ipv4Numbered && addressType !== DdmapAddressType.Ipv4Unnumbered) return null;
  const flags = reader.u8();
  const downstreamAddress = readAddress(reader);
  const downstreamInterface = readAddress(reader);
  const returnCode = reader.u8();
  const returnSubcode = reader.u8();
  const length = reader.u16();
  if (length !== reader.remaining) throw new EchoDecodeError('Downstream Detailed Mapping sub-TLV length mismatch');
  let multipathType = 0;
  let multipathInformation: Uint8Array = new Uint8Array(0);
  const labelStack: DdmapLabel[] = [];
  const fecStackChanges: FecStackChange[] = [];
  for (const sub of readTlvs(reader.take(length))) {
    const part = new ByteReader(sub.value);
    if (sub.type === DdmapSubTlv.Multipath) {
      multipathType = part.u8();
      const informationLength = part.u16();
      part.u8();
      if (informationLength !== part.remaining) throw new EchoDecodeError('multipath length mismatch');
      multipathInformation = part.take(informationLength);
    } else if (sub.type === DdmapSubTlv.LabelStack) {
      if (sub.value.length % 4 !== 0) throw new EchoDecodeError('label stack sub-TLV is not a multiple of 4 octets');
      while (part.remaining > 0) {
        const word = part.u32();
        labelStack.push({ label: word >>> 12, protocol: word & 0xff });
      }
    } else if (sub.type === DdmapSubTlv.FecStackChange) {
      const operation = part.u8();
      const peerType = part.u8();
      const fecLength = part.u8();
      part.u8();
      if (operation !== FEC_STACK_OPERATION.push && operation !== FEC_STACK_OPERATION.pop) throw new EchoDecodeError(`FEC stack operation ${operation}`);
      if (peerType > 1) return null;
      const peer = peerType === 1 ? readAddress(part) : null;
      let fec: TargetFec | null = null;
      if (fecLength > 0) {
        const nested = readTlvs(part.take(fecLength));
        if (nested.length !== 1) throw new EchoDecodeError('FEC stack change must carry exactly one FEC');
        fec = decodeFec(nested[0].type, nested[0].value);
      }
      fecStackChanges.push({ operation: operation === FEC_STACK_OPERATION.push ? 'push' : 'pop', peer, fec });
    } else {
      return null;
    }
  }
  return {
    mtu, addressType, interfaceAndLabelStackRequested: (flags & FLAG_INTERFACE_AND_LABEL_STACK) !== 0, nonIp: (flags & FLAG_NON_IP) !== 0,
    downstreamAddress, downstreamInterface, returnCode, returnSubcode, multipathType, multipathInformation, labelStack, fecStackChanges,
  };
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
  for (const ddmap of message.ddmaps) out.bytes(encodeDdmap(ddmap));
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
  const ddmaps: Ddmap[] = [];
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
      case EchoTlvType.DownstreamDetailedMapping: {
        const ddmap = decodeDdmap(value);
        if (ddmap === null) unrecognisedMandatory.push({ type, value });
        else ddmaps.push(ddmap);
        break;
      }
      case EchoTlvType.ErroredTlvs:
        for (const nested of readTlvs(value)) erroredTlvs.push(nested);
        break;
      default:
        if ((type & OPTIONAL_TLV_BIT) === 0) unrecognisedMandatory.push({ type, value });
    }
  }
  return {
    version, globalFlags, messageType, replyMode, returnCode, returnSubcode, senderHandle, sequenceNumber,
    timestampSent, timestampReceived, targetFecs, pad, replyTosByte, interfaceAndLabelStack, ddmaps, erroredTlvs, unrecognisedMandatory,
  };
}
