import { IPAddress } from '@/network/core/types';
import { ByteReader as Reader, ByteWriter as Writer } from '@/network/core/wire/ByteIo';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import { LdpIdentifier, LDP_IDENTIFIER_BYTES } from './LdpIdentifier';
import {
  ADDRESS_FAMILY_IPV4, LDP_VERSION, MessageType, StatusCode, TlvType, isFatalStatus,
  type AdvertisementMode, type FecElement, type LdpMessage, type LdpPdu,
} from './LdpMessages';

export const LDP_PDU_HEADER_BYTES = 10;
export const LDP_MINIMUM_PDU_LENGTH = 14;
const FEC_ELEMENT_WILDCARD = 0x01;
const FEC_ELEMENT_PREFIX = 0x02;

export class LdpDecodeError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function tlv(type: number, value: Uint8Array, unknownBit = false, forwardBit = false): Uint8Array {
  const word = ((unknownBit ? 1 : 0) << 15) | ((forwardBit ? 1 : 0) << 14) | type;
  return new Writer().u16(word).u16(value.length).bytes(value).toBytes();
}

function ipv4Bytes(address: IPAddress): number[] {
  return address.getOctets();
}

function encodeFec(elements: readonly FecElement[]): Uint8Array {
  const value = new Writer();
  for (const element of elements) {
    if (element.kind === 'wildcard') {
      value.u8(FEC_ELEMENT_WILDCARD);
      continue;
    }
    const octets = Math.ceil(element.length / 8);
    value.u8(FEC_ELEMENT_PREFIX).u16(ADDRESS_FAMILY_IPV4).u8(element.length);
    value.bytes(ipv4Bytes(element.prefix).slice(0, octets));
  }
  return tlv(TlvType.Fec, value.toBytes());
}

function decodeFec(value: Uint8Array): FecElement[] {
  const reader = new Reader(value);
  const elements: FecElement[] = [];
  while (reader.remaining > 0) {
    const type = reader.u8();
    if (type === FEC_ELEMENT_WILDCARD) {
      elements.push({ kind: 'wildcard' });
    } else if (type === FEC_ELEMENT_PREFIX) {
      const family = reader.u16();
      const length = reader.u8();
      if (family !== ADDRESS_FAMILY_IPV4) throw new LdpDecodeError(StatusCode.UnsupportedAddressFamily, `address family ${family}`);
      const octets = Math.ceil(length / 8);
      if (length > 32 || reader.remaining < octets) throw new LdpDecodeError(StatusCode.MalformedTlvValue, 'FEC prefix');
      const raw = [...reader.take(octets)];
      while (raw.length < 4) raw.push(0);
      elements.push({ kind: 'prefix', prefix: new IPAddress(raw), length });
    } else {
      throw new LdpDecodeError(StatusCode.UnknownFec, `FEC element ${type}`);
    }
  }
  return elements;
}

function encodeLabel(label: MplsLabel): Uint8Array {
  return tlv(TlvType.GenericLabel, new Writer().u32(label.value << 12).toBytes());
}

function encodeAddressList(addresses: readonly IPAddress[]): Uint8Array {
  const value = new Writer().u16(ADDRESS_FAMILY_IPV4);
  for (const address of addresses) value.bytes(ipv4Bytes(address));
  return tlv(TlvType.AddressList, value.toBytes());
}

function message(type: number, id: number, parts: readonly Uint8Array[], unknownBit = false): Uint8Array {
  const body = new Writer().u32(id);
  for (const part of parts) body.bytes(part);
  const header = new Writer().u16(((unknownBit ? 1 : 0) << 15) | type).u16(body.length);
  return Uint8Array.from([...header.toBytes(), ...body.toBytes()]);
}

function encodeMessage(entry: LdpMessage): Uint8Array {
  switch (entry.kind) {
    case 'hello': {
      const parameters = new Writer().u16(entry.holdTimeSeconds)
        .u16(((entry.targeted ? 1 : 0) << 15) | ((entry.requestTargetedHellos ? 1 : 0) << 14));
      const optional: Uint8Array[] = [];
      if (entry.transportAddress) optional.push(tlv(TlvType.Ipv4TransportAddress, Uint8Array.from(ipv4Bytes(entry.transportAddress))));
      if (entry.configurationSequenceNumber !== undefined) {
        optional.push(tlv(TlvType.ConfigurationSequenceNumber, new Writer().u32(entry.configurationSequenceNumber).toBytes()));
      }
      return message(MessageType.Hello, entry.id, [tlv(TlvType.CommonHelloParameters, parameters.toBytes()), ...optional]);
    }
    case 'initialization': {
      const parameters = new Writer().u16(entry.protocolVersion).u16(entry.keepAliveTimeSeconds)
        .u8(((entry.advertisementMode === 'on-demand' ? 1 : 0) << 7) | ((entry.loopDetection ? 1 : 0) << 6))
        .u8(entry.pathVectorLimit).u16(entry.maxPduLength).bytes(entry.receiver.encode());
      return message(MessageType.Initialization, entry.id, [tlv(TlvType.CommonSessionParameters, parameters.toBytes())]);
    }
    case 'keepalive':
      return message(MessageType.KeepAlive, entry.id, []);
    case 'address':
      return message(MessageType.Address, entry.id, [encodeAddressList(entry.addresses)]);
    case 'address-withdraw':
      return message(MessageType.AddressWithdraw, entry.id, [encodeAddressList(entry.addresses)]);
    case 'label-mapping': {
      const optional: Uint8Array[] = [];
      if (entry.requestMessageId !== undefined) optional.push(tlv(TlvType.LabelRequestMessageId, new Writer().u32(entry.requestMessageId).toBytes()));
      if (entry.hopCount !== undefined) optional.push(tlv(TlvType.HopCount, Uint8Array.of(entry.hopCount)));
      if (entry.pathVector) optional.push(tlv(TlvType.PathVector, Uint8Array.from(entry.pathVector.flatMap(ipv4Bytes))));
      return message(MessageType.LabelMapping, entry.id, [encodeFec(entry.fec), encodeLabel(entry.label), ...optional]);
    }
    case 'label-request': {
      const optional: Uint8Array[] = [];
      if (entry.hopCount !== undefined) optional.push(tlv(TlvType.HopCount, Uint8Array.of(entry.hopCount)));
      if (entry.pathVector) optional.push(tlv(TlvType.PathVector, Uint8Array.from(entry.pathVector.flatMap(ipv4Bytes))));
      return message(MessageType.LabelRequest, entry.id, [encodeFec(entry.fec), ...optional]);
    }
    case 'label-withdraw':
    case 'label-release': {
      const type = entry.kind === 'label-withdraw' ? MessageType.LabelWithdraw : MessageType.LabelRelease;
      return message(type, entry.id, [encodeFec(entry.fec), ...(entry.label ? [encodeLabel(entry.label)] : [])]);
    }
    case 'notification': {
      const fatal = isFatalStatus(entry.statusCode);
      const word = (((fatal ? 1 : 0) << 31) | ((entry.forward ? 1 : 0) << 30) | entry.statusCode) >>> 0;
      const status = new Writer().u32(word).u32(entry.referencedMessageId).u16(entry.referencedMessageType);
      return message(MessageType.Notification, entry.id, [tlv(TlvType.Status, status.toBytes())]);
    }
    case 'unknown':
      return message(entry.messageType, entry.id, [], entry.unknownBit);
  }
}

export function encodePdu(pdu: LdpPdu): Uint8Array {
  const body = new Writer().bytes(pdu.sender.encode());
  for (const entry of pdu.messages) body.bytes(encodeMessage(entry));
  return Uint8Array.from([...new Writer().u16(pdu.version).u16(body.length).toBytes(), ...body.toBytes()]);
}

interface ParsedTlv { readonly type: number; readonly unknownBit: boolean; readonly value: Uint8Array }

function readTlvs(data: Uint8Array): ParsedTlv[] {
  const reader = new Reader(data);
  const parsed: ParsedTlv[] = [];
  while (reader.remaining > 0) {
    if (reader.remaining < 4) throw new LdpDecodeError(StatusCode.BadTlvLength, 'truncated TLV header');
    const word = reader.u16();
    const length = reader.u16();
    if (length > reader.remaining) throw new LdpDecodeError(StatusCode.BadTlvLength, 'TLV overruns message');
    parsed.push({ type: word & 0x3fff, unknownBit: (word & 0x8000) !== 0, value: reader.take(length) });
  }
  return parsed;
}

function required(tlvs: readonly ParsedTlv[], type: number): ParsedTlv {
  const found = tlvs.find(item => item.type === type);
  if (!found) throw new LdpDecodeError(StatusCode.MissingMessageParameters, `missing TLV 0x${type.toString(16)}`);
  return found;
}

function optional(tlvs: readonly ParsedTlv[], type: number): ParsedTlv | undefined {
  return tlvs.find(item => item.type === type);
}

function decodeLabel(value: Uint8Array): MplsLabel {
  if (value.length !== 4) throw new LdpDecodeError(StatusCode.BadTlvLength, 'generic label length');
  return MplsLabel.of(new Reader(value).u32() >>> 12);
}

function decodeAddresses(value: Uint8Array): IPAddress[] {
  const reader = new Reader(value);
  if (reader.u16() !== ADDRESS_FAMILY_IPV4) throw new LdpDecodeError(StatusCode.UnsupportedAddressFamily, 'address list');
  const addresses: IPAddress[] = [];
  while (reader.remaining >= 4) addresses.push(new IPAddress([...reader.take(4)]));
  if (reader.remaining !== 0) throw new LdpDecodeError(StatusCode.MalformedTlvValue, 'address list');
  return addresses;
}

function decodePathVector(value: Uint8Array): IPAddress[] {
  const reader = new Reader(value);
  const ids: IPAddress[] = [];
  while (reader.remaining >= 4) ids.push(new IPAddress([...reader.take(4)]));
  return ids;
}

function decodeMessage(type: number, unknownBit: boolean, id: number, tlvs: readonly ParsedTlv[]): LdpMessage {
  switch (type) {
    case MessageType.Hello: {
      const common = new Reader(required(tlvs, TlvType.CommonHelloParameters).value);
      const holdTimeSeconds = common.u16();
      const flags = common.u16();
      const transport = optional(tlvs, TlvType.Ipv4TransportAddress);
      const sequence = optional(tlvs, TlvType.ConfigurationSequenceNumber);
      return {
        kind: 'hello', id, holdTimeSeconds, targeted: (flags & 0x8000) !== 0, requestTargetedHellos: (flags & 0x4000) !== 0,
        ...(transport ? { transportAddress: new IPAddress([...transport.value]) } : {}),
        ...(sequence ? { configurationSequenceNumber: new Reader(sequence.value).u32() } : {}),
      };
    }
    case MessageType.Initialization: {
      const reader = new Reader(required(tlvs, TlvType.CommonSessionParameters).value);
      const protocolVersion = reader.u16();
      const keepAliveTimeSeconds = reader.u16();
      const flags = reader.u8();
      const pathVectorLimit = reader.u8();
      const maxPduLength = reader.u16();
      const receiver = LdpIdentifier.decode(reader.take(LDP_IDENTIFIER_BYTES));
      const advertisementMode: AdvertisementMode = (flags & 0x80) !== 0 ? 'on-demand' : 'unsolicited';
      return {
        kind: 'initialization', id, protocolVersion, keepAliveTimeSeconds, advertisementMode,
        loopDetection: (flags & 0x40) !== 0, pathVectorLimit, maxPduLength, receiver,
      };
    }
    case MessageType.KeepAlive:
      return { kind: 'keepalive', id };
    case MessageType.Address:
    case MessageType.AddressWithdraw:
      return {
        kind: type === MessageType.Address ? 'address' : 'address-withdraw', id,
        addresses: decodeAddresses(required(tlvs, TlvType.AddressList).value),
      };
    case MessageType.LabelMapping: {
      const request = optional(tlvs, TlvType.LabelRequestMessageId);
      const hop = optional(tlvs, TlvType.HopCount);
      const path = optional(tlvs, TlvType.PathVector);
      return {
        kind: 'label-mapping', id, fec: decodeFec(required(tlvs, TlvType.Fec).value),
        label: decodeLabel(required(tlvs, TlvType.GenericLabel).value),
        ...(request ? { requestMessageId: new Reader(request.value).u32() } : {}),
        ...(hop ? { hopCount: hop.value[0] } : {}),
        ...(path ? { pathVector: decodePathVector(path.value) } : {}),
      };
    }
    case MessageType.LabelRequest: {
      const hop = optional(tlvs, TlvType.HopCount);
      const path = optional(tlvs, TlvType.PathVector);
      return {
        kind: 'label-request', id, fec: decodeFec(required(tlvs, TlvType.Fec).value),
        ...(hop ? { hopCount: hop.value[0] } : {}),
        ...(path ? { pathVector: decodePathVector(path.value) } : {}),
      };
    }
    case MessageType.LabelWithdraw:
    case MessageType.LabelRelease: {
      const label = optional(tlvs, TlvType.GenericLabel);
      return {
        kind: type === MessageType.LabelWithdraw ? 'label-withdraw' : 'label-release', id,
        fec: decodeFec(required(tlvs, TlvType.Fec).value),
        ...(label ? { label: decodeLabel(label.value) } : {}),
      };
    }
    case MessageType.Notification: {
      const reader = new Reader(required(tlvs, TlvType.Status).value);
      const word = reader.u32();
      return {
        kind: 'notification', id, statusCode: word & 0x3fffffff, forward: (word & 0x40000000) !== 0,
        referencedMessageId: reader.u32(), referencedMessageType: reader.u16(),
      };
    }
    default:
      return { kind: 'unknown', id, messageType: type, unknownBit };
  }
}

export function decodePdu(bytes: Uint8Array, maxPduLength = 4096): LdpPdu {
  if (bytes.length < LDP_PDU_HEADER_BYTES) throw new LdpDecodeError(StatusCode.BadPduLength, 'truncated PDU header');
  const reader = new Reader(bytes);
  const version = reader.u16();
  const pduLength = reader.u16();
  if (version !== LDP_VERSION) throw new LdpDecodeError(StatusCode.BadProtocolVersion, `version ${version}`);
  if (pduLength < LDP_MINIMUM_PDU_LENGTH && pduLength !== LDP_IDENTIFIER_BYTES) throw new LdpDecodeError(StatusCode.BadPduLength, `length ${pduLength}`);
  if (pduLength > maxPduLength || pduLength > reader.remaining) throw new LdpDecodeError(StatusCode.BadPduLength, `length ${pduLength}`);
  const sender = LdpIdentifier.decode(reader.take(LDP_IDENTIFIER_BYTES));
  const messages: LdpMessage[] = [];
  let remaining = pduLength - LDP_IDENTIFIER_BYTES;
  while (remaining > 0) {
    if (remaining < 8) throw new LdpDecodeError(StatusCode.BadMessageLength, 'truncated message header');
    const word = reader.u16();
    const length = reader.u16();
    remaining -= 4;
    if (length < 4 || length > remaining) throw new LdpDecodeError(StatusCode.BadMessageLength, `message length ${length}`);
    const id = reader.u32();
    const tlvs = readTlvs(reader.take(length - 4));
    remaining -= length;
    messages.push(decodeMessage(word & 0x7fff, (word & 0x8000) !== 0, id, tlvs));
  }
  return { version, sender, messages };
}
