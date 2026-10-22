import { IPAddress } from '@/network/core/types';
import { ByteReader as Reader, ByteWriter as Writer } from '@/network/core/wire/ByteIo';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import { LdpIdentifier, LDP_IDENTIFIER_BYTES } from './LdpIdentifier';
import {
  ADDRESS_FAMILY_IPV4, LDP_VERSION, MessageType, StatusCode, TlvType, isFatalStatus,
  type AdvertisementMode, type FecElement, type LdpMessage, type LdpPdu, type AttachmentIdentifier, type GeneralizedPwFec, type PwIdFec, type PwInterfaceParameter,
} from './LdpMessages';

export const LDP_PDU_HEADER_BYTES = 10;
export const LDP_MINIMUM_PDU_LENGTH = 14;
const FEC_ELEMENT_WILDCARD = 0x01;
const FEC_ELEMENT_PREFIX = 0x02;
const FEC_ELEMENT_PWID = 0x80;
const FEC_ELEMENT_GENERALIZED_PWID = 0x81;
const PW_INTERFACE_PARAMETER_HEADER = 2;

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
    if (element.kind === 'pwid') {
      value.bytes(encodePwIdFec(element));
      continue;
    }
    if (element.kind === 'gen-pwid') {
      value.bytes(encodeGeneralizedFec(element));
      continue;
    }
    const octets = Math.ceil(element.length / 8);
    value.u8(FEC_ELEMENT_PREFIX).u16(ADDRESS_FAMILY_IPV4).u8(element.length);
    value.bytes(ipv4Bytes(element.prefix).slice(0, octets));
  }
  return tlv(TlvType.Fec, value.toBytes());
}

function encodePwIdFec(fec: PwIdFec): number[] {
  const info = new Writer();
  if (fec.pwId !== null) {
    info.u32(fec.pwId);
    for (const parameter of fec.interfaceParameters) {
      info.u8(parameter.type).u8(PW_INTERFACE_PARAMETER_HEADER + parameter.value.length).bytes(parameter.value);
    }
  }
  const header = new Writer().u8(FEC_ELEMENT_PWID).u16(((fec.controlWord ? 1 : 0) << 15) | fec.pwType)
    .u8(info.length).u32(fec.groupId);
  return [...header.toBytes(), ...info.toBytes()];
}

function encodeAttachmentIdentifier(identifier: AttachmentIdentifier): number[] {
  return [identifier.type, identifier.value.length, ...identifier.value];
}

function encodeGeneralizedFec(fec: GeneralizedPwFec): number[] {
  const body = [
    ...encodeAttachmentIdentifier(fec.agi), ...encodeAttachmentIdentifier(fec.saii), ...encodeAttachmentIdentifier(fec.taii),
  ];
  const header = new Writer().u8(FEC_ELEMENT_GENERALIZED_PWID).u16(((fec.controlWord ? 1 : 0) << 15) | fec.pwType).u8(body.length);
  return [...header.toBytes(), ...body];
}

function readAttachmentIdentifier(reader: Reader): AttachmentIdentifier {
  if (reader.remaining < 2) throw new LdpDecodeError(StatusCode.MalformedTlvValue, 'attachment identifier');
  const type = reader.u8();
  const length = reader.u8();
  if (length > reader.remaining) throw new LdpDecodeError(StatusCode.MalformedTlvValue, 'attachment identifier length');
  return { type, value: reader.take(length) };
}

function decodeGeneralizedFec(reader: Reader): GeneralizedPwFec {
  if (reader.remaining < 3) throw new LdpDecodeError(StatusCode.MalformedTlvValue, 'Generalized PWid FEC');
  const word = reader.u16();
  const infoLength = reader.u8();
  if (infoLength === 0 || infoLength > reader.remaining) throw new LdpDecodeError(StatusCode.MalformedTlvValue, 'Generalized PWid FEC info length');
  const info = new Reader(reader.take(infoLength));
  const agi = readAttachmentIdentifier(info);
  const saii = readAttachmentIdentifier(info);
  const taii = readAttachmentIdentifier(info);
  return { kind: 'gen-pwid', controlWord: (word & 0x8000) !== 0, pwType: word & 0x7fff, agi, saii, taii, interfaceParameters: [] };
}

function encodeInterfaceParameters(parameters: readonly PwInterfaceParameter[]): Uint8Array {
  const value = new Writer();
  for (const parameter of parameters) value.u8(parameter.type).u8(PW_INTERFACE_PARAMETER_HEADER + parameter.value.length).bytes(parameter.value);
  return tlv(TlvType.PwInterfaceParameters, value.toBytes());
}

function decodeInterfaceParameters(value: Uint8Array): PwInterfaceParameter[] {
  const info = new Reader(value);
  const parameters: PwInterfaceParameter[] = [];
  while (info.remaining > 0) {
    if (info.remaining < PW_INTERFACE_PARAMETER_HEADER) throw new LdpDecodeError(StatusCode.MalformedTlvValue, 'interface parameter');
    const type = info.u8();
    const length = info.u8();
    if (length < PW_INTERFACE_PARAMETER_HEADER || length - PW_INTERFACE_PARAMETER_HEADER > info.remaining) {
      throw new LdpDecodeError(StatusCode.MalformedTlvValue, 'interface parameter length');
    }
    parameters.push({ type, value: info.take(length - PW_INTERFACE_PARAMETER_HEADER) });
  }
  return parameters;
}

function withParameters(fec: FecElement[], parameters: PwInterfaceParameter[] | undefined): FecElement[] {
  if (parameters === undefined) return fec;
  return fec.map(element => (element.kind === 'gen-pwid' ? { ...element, interfaceParameters: parameters } : element));
}

function decodePwIdFec(reader: Reader): PwIdFec {
  if (reader.remaining < 7) throw new LdpDecodeError(StatusCode.MalformedTlvValue, 'PWid FEC');
  const word = reader.u16();
  const infoLength = reader.u8();
  const groupId = reader.u32();
  if (infoLength > reader.remaining) throw new LdpDecodeError(StatusCode.MalformedTlvValue, 'PWid FEC info length');
  const info = new Reader(reader.take(infoLength));
  const interfaceParameters: PwInterfaceParameter[] = [];
  let pwId: number | null = null;
  if (infoLength > 0) {
    if (infoLength < 4) throw new LdpDecodeError(StatusCode.MalformedTlvValue, 'PWid FEC info length');
    pwId = info.u32();
    while (info.remaining > 0) {
      if (info.remaining < PW_INTERFACE_PARAMETER_HEADER) throw new LdpDecodeError(StatusCode.MalformedTlvValue, 'interface parameter');
      const type = info.u8();
      const length = info.u8();
      if (length < PW_INTERFACE_PARAMETER_HEADER || length - PW_INTERFACE_PARAMETER_HEADER > info.remaining) {
        throw new LdpDecodeError(StatusCode.MalformedTlvValue, 'interface parameter length');
      }
      interfaceParameters.push({ type, value: info.take(length - PW_INTERFACE_PARAMETER_HEADER) });
    }
  }
  return { kind: 'pwid', controlWord: (word & 0x8000) !== 0, pwType: word & 0x7fff, groupId, pwId, interfaceParameters };
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
    } else if (type === FEC_ELEMENT_PWID) {
      elements.push(decodePwIdFec(reader));
    } else if (type === FEC_ELEMENT_GENERALIZED_PWID) {
      elements.push(decodeGeneralizedFec(reader));
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

function encodeStatus(statusCode: number, forward: boolean, referencedMessageId: number, referencedMessageType: number): Uint8Array {
  const word = (((isFatalStatus(statusCode) ? 1 : 0) << 31) | ((forward ? 1 : 0) << 30) | statusCode) >>> 0;
  return tlv(TlvType.Status, new Writer().u32(word).u32(referencedMessageId).u16(referencedMessageType).toBytes());
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
    case 'mac-withdraw':
      return message(MessageType.AddressWithdraw, entry.id, [
        encodeFec(entry.fec), tlv(TlvType.MacList, Uint8Array.from(entry.macs.flat()), true),
      ]);
    case 'label-mapping': {
      const optional: Uint8Array[] = [];
      if (entry.requestMessageId !== undefined) optional.push(tlv(TlvType.LabelRequestMessageId, new Writer().u32(entry.requestMessageId).toBytes()));
      if (entry.hopCount !== undefined) optional.push(tlv(TlvType.HopCount, Uint8Array.of(entry.hopCount)));
      if (entry.pathVector) optional.push(tlv(TlvType.PathVector, Uint8Array.from(entry.pathVector.flatMap(ipv4Bytes))));
      const generalized = entry.fec.find((element): element is GeneralizedPwFec => element.kind === 'gen-pwid');
      if (generalized !== undefined && generalized.interfaceParameters.length > 0) {
        optional.push(encodeInterfaceParameters(generalized.interfaceParameters));
      }
      if (entry.pwStatus !== undefined) optional.push(tlv(TlvType.PwStatus, new Writer().u32(entry.pwStatus).toBytes(), true));
      if (entry.entropyLabelCapable === true) optional.push(tlv(TlvType.EntropyLabelCapability, new Uint8Array(0), true, true));
      if (entry.lspMtu !== undefined) optional.push(tlv(TlvType.Mtu, new Writer().u16(entry.lspMtu).toBytes(), true, true));
      return message(MessageType.LabelMapping, entry.id, [encodeFec(entry.fec), encodeLabel(entry.label), ...optional]);
    }
    case 'label-request': {
      const optional: Uint8Array[] = [];
      if (entry.hopCount !== undefined) optional.push(tlv(TlvType.HopCount, Uint8Array.of(entry.hopCount)));
      if (entry.pathVector) optional.push(tlv(TlvType.PathVector, Uint8Array.from(entry.pathVector.flatMap(ipv4Bytes))));
      return message(MessageType.LabelRequest, entry.id, [encodeFec(entry.fec), ...optional]);
    }
    case 'label-abort-request':
      return message(MessageType.LabelAbortRequest, entry.id, [
        encodeFec(entry.fec), tlv(TlvType.LabelRequestMessageId, new Writer().u32(entry.requestMessageId).toBytes()),
      ]);
    case 'label-withdraw':
    case 'label-release': {
      const type = entry.kind === 'label-withdraw' ? MessageType.LabelWithdraw : MessageType.LabelRelease;
      return message(type, entry.id, [
        encodeFec(entry.fec), ...(entry.label ? [encodeLabel(entry.label)] : []),
        ...(entry.status !== undefined ? [encodeStatus(entry.status, false, 0, 0)] : []),
      ]);
    }
    case 'notification': {
      return message(MessageType.Notification, entry.id, [
        encodeStatus(entry.statusCode, entry.forward, entry.referencedMessageId, entry.referencedMessageType),
        ...(entry.pwStatus !== undefined ? [tlv(TlvType.PwStatus, new Writer().u32(entry.pwStatus).toBytes(), true)] : []),
        ...(entry.requestMessageId !== undefined ? [tlv(TlvType.LabelRequestMessageId, new Writer().u32(entry.requestMessageId).toBytes())] : []),
        ...(entry.fec !== undefined ? [encodeFec(entry.fec)] : []),
      ]);
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
    case MessageType.AddressWithdraw: {
      const macList = optional(tlvs, TlvType.MacList);
      if (type === MessageType.AddressWithdraw && macList !== undefined) {
        if (macList.value.length % 6 !== 0) throw new LdpDecodeError(StatusCode.MalformedTlvValue, 'MAC list length');
        const macs: number[][] = [];
        for (let offset = 0; offset < macList.value.length; offset += 6) macs.push([...macList.value.subarray(offset, offset + 6)]);
        return { kind: 'mac-withdraw', id, fec: decodeFec(required(tlvs, TlvType.Fec).value), macs };
      }
      return {
        kind: type === MessageType.Address ? 'address' : 'address-withdraw', id,
        addresses: decodeAddresses(required(tlvs, TlvType.AddressList).value),
      };
    }
    case MessageType.LabelMapping: {
      const request = optional(tlvs, TlvType.LabelRequestMessageId);
      const hop = optional(tlvs, TlvType.HopCount);
      const path = optional(tlvs, TlvType.PathVector);
      const pwStatus = optional(tlvs, TlvType.PwStatus);
      const parameterTlv = optional(tlvs, TlvType.PwInterfaceParameters);
      const interfaceParameters = parameterTlv ? decodeInterfaceParameters(parameterTlv.value) : undefined;
      return {
        kind: 'label-mapping', id, fec: withParameters(decodeFec(required(tlvs, TlvType.Fec).value), interfaceParameters),
        label: decodeLabel(required(tlvs, TlvType.GenericLabel).value),
        ...(request ? { requestMessageId: new Reader(request.value).u32() } : {}),
        ...(hop ? { hopCount: hop.value[0] } : {}),
        ...(path ? { pathVector: decodePathVector(path.value) } : {}),
        ...(pwStatus ? { pwStatus: new Reader(pwStatus.value).u32() } : {}),
        ...(optional(tlvs, TlvType.EntropyLabelCapability) ? { entropyLabelCapable: true } : {}),
        ...(optional(tlvs, TlvType.Mtu) ? { lspMtu: new Reader(optional(tlvs, TlvType.Mtu)!.value).u16() } : {}),
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
    case MessageType.LabelAbortRequest:
      return {
        kind: 'label-abort-request', id, fec: decodeFec(required(tlvs, TlvType.Fec).value),
        requestMessageId: new Reader(required(tlvs, TlvType.LabelRequestMessageId).value).u32(),
      };
    case MessageType.LabelWithdraw:
    case MessageType.LabelRelease: {
      const label = optional(tlvs, TlvType.GenericLabel);
      const status = optional(tlvs, TlvType.Status);
      return {
        kind: type === MessageType.LabelWithdraw ? 'label-withdraw' : 'label-release', id,
        fec: decodeFec(required(tlvs, TlvType.Fec).value),
        ...(label ? { label: decodeLabel(label.value) } : {}),
        ...(status ? { status: new Reader(status.value).u32() & 0x3fffffff } : {}),
      };
    }
    case MessageType.Notification: {
      const reader = new Reader(required(tlvs, TlvType.Status).value);
      const word = reader.u32();
      const pwStatus = optional(tlvs, TlvType.PwStatus);
      const fec = optional(tlvs, TlvType.Fec);
      const aborted = optional(tlvs, TlvType.LabelRequestMessageId);
      return {
        kind: 'notification', id, statusCode: word & 0x3fffffff, forward: (word & 0x40000000) !== 0,
        referencedMessageId: reader.u32(), referencedMessageType: reader.u16(),
        ...(pwStatus ? { pwStatus: new Reader(pwStatus.value).u32() } : {}),
        ...(aborted ? { requestMessageId: new Reader(aborted.value).u32() } : {}),
        ...(fec ? { fec: decodeFec(fec.value) } : {}),
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
