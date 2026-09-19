export const NS_HEADER_SIZE = 8;

export enum NsPacketType {
  Connect = 1,
  Accept = 2,
  Ack = 3,
  Refuse = 4,
  Redirect = 5,
  Data = 6,
  Null = 7,
  Abort = 9,
  Resend = 11,
  Marker = 12,
  Attention = 13,
  Control = 14,
}

export enum NsDataFlag {
  None = 0x0000,
  SendToken = 0x0001,
  RequestConfirmation = 0x0002,
  Confirmation = 0x0004,
  MoreDataToCome = 0x0020,
  EndOfFile = 0x0040,
  DoImmediateConfirmation = 0x0080,
  RequestToSend = 0x0100,
  SendNtTrailer = 0x0200,
}

export enum NsRefuseReason {
  None = 0x00,
  User = 0x01,
  System = 0x02,
  ServiceUnknown = 0x22,
}

export const NS_VERSION_19C = 319;
export const NS_VERSION_COMPATIBLE = 300;
export const NS_SERVICE_OPTIONS = 0x0c41;
export const NS_SDU_SIZE = 8192;
export const NS_MAX_TDU_SIZE = 65535;
export const NS_NT_PROTO_CHARACTERISTICS = 0x7f08;
export const NS_LINE_TURNAROUND = 0;
export const NS_VALUE_OF_ONE = 0x0001;
export const NS_CONNECT_DATA_MAX = 0x00000800;
export const NS_CONNECT_BODY_SIZE = 50;
export const NS_ACCEPT_BODY_SIZE = 24;

export interface NsHeader {
  readonly length: number;
  readonly packetChecksum: number;
  readonly type: NsPacketType;
  readonly flags: number;
  readonly headerChecksum: number;
}

export interface NsConnectBody {
  readonly version: number;
  readonly compatibleVersion: number;
  readonly serviceOptions: number;
  readonly sduSize: number;
  readonly maxTduSize: number;
  readonly ntProtoCharacteristics: number;
  readonly lineTurnaround: number;
  readonly connectData: string;
}

export interface NsAcceptBody {
  readonly version: number;
  readonly serviceOptions: number;
  readonly sduSize: number;
  readonly maxTduSize: number;
  readonly acceptData: string;
}

export interface NsRefuseBody {
  readonly userReason: NsRefuseReason;
  readonly systemReason: NsRefuseReason;
  readonly refuseData: string;
}

export interface NsRedirectBody {
  readonly redirectData: string;
}

export interface NsDataBody {
  readonly dataFlags: number;
  readonly payload: Uint8Array;
}

export type NsPacket =
  | { readonly type: NsPacketType.Connect; readonly body: NsConnectBody }
  | { readonly type: NsPacketType.Accept; readonly body: NsAcceptBody }
  | { readonly type: NsPacketType.Refuse; readonly body: NsRefuseBody }
  | { readonly type: NsPacketType.Redirect; readonly body: NsRedirectBody }
  | { readonly type: NsPacketType.Data; readonly body: NsDataBody }
  | { readonly type: NsPacketType.Resend }
  | { readonly type: NsPacketType.Marker; readonly body: Uint8Array };

export function encodeAscii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function decodeAscii(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function frame(type: NsPacketType, body: Uint8Array, flags = 0): Uint8Array {
  const total = NS_HEADER_SIZE + body.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, total, false);
  view.setUint16(2, 0, false);
  out[4] = type;
  out[5] = flags;
  view.setUint16(6, 0, false);
  out.set(body, NS_HEADER_SIZE);
  return out;
}

export function readNsHeader(bytes: Uint8Array): NsHeader | null {
  if (bytes.length < NS_HEADER_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    length: view.getUint16(0, false),
    packetChecksum: view.getUint16(2, false),
    type: view.getUint8(4) as NsPacketType,
    flags: view.getUint8(5),
    headerChecksum: view.getUint16(6, false),
  };
}

export interface NsFrameRead {
  readonly packet: Uint8Array;
  readonly consumed: number;
}

export function readNsFrame(stream: Uint8Array): NsFrameRead | null {
  const header = readNsHeader(stream);
  if (!header) return null;
  if (header.length < NS_HEADER_SIZE || stream.length < header.length) return null;
  return { packet: stream.subarray(0, header.length), consumed: header.length };
}

export function encodeConnect(body: NsConnectBody): Uint8Array {
  const data = encodeAscii(body.connectData);
  const fixed = new Uint8Array(NS_CONNECT_BODY_SIZE - NS_HEADER_SIZE);
  const view = new DataView(fixed.buffer);
  view.setUint16(0, body.version, false);
  view.setUint16(2, body.compatibleVersion, false);
  view.setUint16(4, body.serviceOptions, false);
  view.setUint16(6, body.sduSize, false);
  view.setUint16(8, body.maxTduSize, false);
  view.setUint16(10, body.ntProtoCharacteristics, false);
  view.setUint16(12, body.lineTurnaround, false);
  view.setUint16(14, NS_VALUE_OF_ONE, false);
  view.setUint16(16, data.length, false);
  view.setUint16(18, NS_CONNECT_BODY_SIZE, false);
  view.setUint32(20, NS_CONNECT_DATA_MAX, false);
  const full = new Uint8Array(fixed.length + data.length);
  full.set(fixed, 0);
  full.set(data, fixed.length);
  return frame(NsPacketType.Connect, full);
}

export function decodeConnect(packet: Uint8Array): NsConnectBody | null {
  const header = readNsHeader(packet);
  if (!header || header.type !== NsPacketType.Connect) return null;
  if (packet.length < NS_CONNECT_BODY_SIZE - 8) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const dataLength = view.getUint16(NS_HEADER_SIZE + 16, false);
  const dataOffset = view.getUint16(NS_HEADER_SIZE + 18, false);
  if (dataOffset + dataLength > packet.length) return null;
  return {
    version: view.getUint16(NS_HEADER_SIZE + 0, false),
    compatibleVersion: view.getUint16(NS_HEADER_SIZE + 2, false),
    serviceOptions: view.getUint16(NS_HEADER_SIZE + 4, false),
    sduSize: view.getUint16(NS_HEADER_SIZE + 6, false),
    maxTduSize: view.getUint16(NS_HEADER_SIZE + 8, false),
    ntProtoCharacteristics: view.getUint16(NS_HEADER_SIZE + 10, false),
    lineTurnaround: view.getUint16(NS_HEADER_SIZE + 12, false),
    connectData: decodeAscii(packet.subarray(dataOffset, dataOffset + dataLength)),
  };
}

export function encodeAccept(body: NsAcceptBody): Uint8Array {
  const data = encodeAscii(body.acceptData);
  const fixed = new Uint8Array(NS_ACCEPT_BODY_SIZE - NS_HEADER_SIZE);
  const view = new DataView(fixed.buffer);
  view.setUint16(0, body.version, false);
  view.setUint16(2, body.serviceOptions, false);
  view.setUint16(4, body.sduSize, false);
  view.setUint16(6, body.maxTduSize, false);
  view.setUint16(8, NS_VALUE_OF_ONE, false);
  view.setUint16(10, data.length, false);
  view.setUint16(12, NS_ACCEPT_BODY_SIZE, false);
  const full = new Uint8Array(fixed.length + data.length);
  full.set(fixed, 0);
  full.set(data, fixed.length);
  return frame(NsPacketType.Accept, full);
}

export function decodeAccept(packet: Uint8Array): NsAcceptBody | null {
  const header = readNsHeader(packet);
  if (!header || header.type !== NsPacketType.Accept) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const dataLength = view.getUint16(NS_HEADER_SIZE + 10, false);
  const dataOffset = view.getUint16(NS_HEADER_SIZE + 12, false);
  if (dataOffset + dataLength > packet.length) return null;
  return {
    version: view.getUint16(NS_HEADER_SIZE + 0, false),
    serviceOptions: view.getUint16(NS_HEADER_SIZE + 2, false),
    sduSize: view.getUint16(NS_HEADER_SIZE + 4, false),
    maxTduSize: view.getUint16(NS_HEADER_SIZE + 6, false),
    acceptData: decodeAscii(packet.subarray(dataOffset, dataOffset + dataLength)),
  };
}

export function encodeRefuse(body: NsRefuseBody): Uint8Array {
  const data = encodeAscii(body.refuseData);
  const full = new Uint8Array(4 + data.length);
  const view = new DataView(full.buffer);
  full[0] = body.userReason;
  full[1] = body.systemReason;
  view.setUint16(2, data.length, false);
  full.set(data, 4);
  return frame(NsPacketType.Refuse, full);
}

export function decodeRefuse(packet: Uint8Array): NsRefuseBody | null {
  const header = readNsHeader(packet);
  if (!header || header.type !== NsPacketType.Refuse) return null;
  if (packet.length < NS_HEADER_SIZE + 4) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const dataLength = view.getUint16(NS_HEADER_SIZE + 2, false);
  const start = NS_HEADER_SIZE + 4;
  return {
    userReason: packet[NS_HEADER_SIZE] as NsRefuseReason,
    systemReason: packet[NS_HEADER_SIZE + 1] as NsRefuseReason,
    refuseData: decodeAscii(packet.subarray(start, start + dataLength)),
  };
}

export function encodeRedirect(body: NsRedirectBody): Uint8Array {
  const data = encodeAscii(body.redirectData);
  const full = new Uint8Array(2 + data.length);
  new DataView(full.buffer).setUint16(0, data.length, false);
  full.set(data, 2);
  return frame(NsPacketType.Redirect, full);
}

export function decodeRedirect(packet: Uint8Array): NsRedirectBody | null {
  const header = readNsHeader(packet);
  if (!header || header.type !== NsPacketType.Redirect) return null;
  if (packet.length < NS_HEADER_SIZE + 2) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const dataLength = view.getUint16(NS_HEADER_SIZE, false);
  const start = NS_HEADER_SIZE + 2;
  return { redirectData: decodeAscii(packet.subarray(start, start + dataLength)) };
}

export function encodeData(payload: Uint8Array, dataFlags = NsDataFlag.None): Uint8Array {
  const full = new Uint8Array(2 + payload.length);
  new DataView(full.buffer).setUint16(0, dataFlags, false);
  full.set(payload, 2);
  return frame(NsPacketType.Data, full);
}

export function decodeData(packet: Uint8Array): NsDataBody | null {
  const header = readNsHeader(packet);
  if (!header || header.type !== NsPacketType.Data) return null;
  if (packet.length < NS_HEADER_SIZE + 2) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  return {
    dataFlags: view.getUint16(NS_HEADER_SIZE, false),
    payload: packet.subarray(NS_HEADER_SIZE + 2),
  };
}

export function encodeMarker(markerType: number, dataByte: number, markerFunction: number): Uint8Array {
  return frame(NsPacketType.Marker, Uint8Array.from([markerType, dataByte, markerFunction]));
}
