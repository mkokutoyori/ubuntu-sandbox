import { SshReader, SshWriter } from '../wire/SshDataTypes';

export interface DirectTcpipPayload {
  readonly host: string;
  readonly port: number;
  readonly originatorAddress: string;
  readonly originatorPort: number;
}

export interface ForwardedTcpipPayload {
  readonly connectedAddress: string;
  readonly connectedPort: number;
  readonly originatorAddress: string;
  readonly originatorPort: number;
}

export interface PtyRequestPayload {
  readonly term: string;
  readonly columns: number;
  readonly rows: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly modes: Uint8Array;
}

export interface WindowChangePayload {
  readonly columns: number;
  readonly rows: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

export interface ExitSignalPayload {
  readonly signal: string;
  readonly coreDumped: boolean;
  readonly message: string;
  readonly language: string;
}

export interface TcpipForwardPayload {
  readonly address: string;
  readonly port: number;
}

function tryDecode<T>(payload: Uint8Array, read: (reader: SshReader) => T): T | null {
  try {
    return read(new SshReader(payload));
  } catch {
    return null;
  }
}

export const encodeDirectTcpip = (p: DirectTcpipPayload): Uint8Array =>
  new SshWriter().writeString(p.host).writeUint32(p.port).writeString(p.originatorAddress)
    .writeUint32(p.originatorPort).toBytes();

export const decodeDirectTcpip = (payload: Uint8Array): DirectTcpipPayload | null =>
  tryDecode(payload, (r) => ({
    host: r.readString(), port: r.readUint32(), originatorAddress: r.readString(), originatorPort: r.readUint32(),
  }));

export const encodeForwardedTcpip = (p: ForwardedTcpipPayload): Uint8Array =>
  new SshWriter().writeString(p.connectedAddress).writeUint32(p.connectedPort).writeString(p.originatorAddress)
    .writeUint32(p.originatorPort).toBytes();

export const decodeForwardedTcpip = (payload: Uint8Array): ForwardedTcpipPayload | null =>
  tryDecode(payload, (r) => ({
    connectedAddress: r.readString(), connectedPort: r.readUint32(),
    originatorAddress: r.readString(), originatorPort: r.readUint32(),
  }));

export const encodePtyRequest = (p: PtyRequestPayload): Uint8Array =>
  new SshWriter().writeString(p.term).writeUint32(p.columns).writeUint32(p.rows).writeUint32(p.pixelWidth)
    .writeUint32(p.pixelHeight).writeBytes(p.modes).toBytes();

export const decodePtyRequest = (payload: Uint8Array): PtyRequestPayload | null =>
  tryDecode(payload, (r) => ({
    term: r.readString(), columns: r.readUint32(), rows: r.readUint32(),
    pixelWidth: r.readUint32(), pixelHeight: r.readUint32(), modes: r.readBytes(),
  }));

export const encodeWindowChange = (p: WindowChangePayload): Uint8Array =>
  new SshWriter().writeUint32(p.columns).writeUint32(p.rows).writeUint32(p.pixelWidth)
    .writeUint32(p.pixelHeight).toBytes();

export const decodeWindowChange = (payload: Uint8Array): WindowChangePayload | null =>
  tryDecode(payload, (r) => ({
    columns: r.readUint32(), rows: r.readUint32(), pixelWidth: r.readUint32(), pixelHeight: r.readUint32(),
  }));

export const encodeEnvRequest = (name: string, value: string): Uint8Array =>
  new SshWriter().writeString(name).writeString(value).toBytes();

export const decodeEnvRequest = (payload: Uint8Array): { name: string; value: string } | null =>
  tryDecode(payload, (r) => ({ name: r.readString(), value: r.readString() }));

export const encodeStringPayload = (value: string): Uint8Array => new SshWriter().writeString(value).toBytes();

export const decodeStringPayload = (payload: Uint8Array): string | null =>
  tryDecode(payload, (r) => r.readString());

export const encodeExitStatus = (status: number): Uint8Array => new SshWriter().writeUint32(status).toBytes();

export const decodeExitStatus = (payload: Uint8Array): number | null =>
  tryDecode(payload, (r) => r.readUint32());

export const encodeExitSignal = (p: ExitSignalPayload): Uint8Array =>
  new SshWriter().writeString(p.signal).writeByte(p.coreDumped ? 1 : 0).writeString(p.message)
    .writeString(p.language).toBytes();

export const decodeExitSignal = (payload: Uint8Array): ExitSignalPayload | null =>
  tryDecode(payload, (r) => ({
    signal: r.readString(), coreDumped: r.readByte() !== 0, message: r.readString(), language: r.readString(),
  }));

export const encodeTcpipForward = (p: TcpipForwardPayload): Uint8Array =>
  new SshWriter().writeString(p.address).writeUint32(p.port).toBytes();

export const decodeTcpipForward = (payload: Uint8Array): TcpipForwardPayload | null =>
  tryDecode(payload, (r) => ({ address: r.readString(), port: r.readUint32() }));

export const encodeBoundPort = (port: number): Uint8Array => new SshWriter().writeUint32(port).toBytes();

export const decodeBoundPort = (payload: Uint8Array): number | null =>
  tryDecode(payload, (r) => r.readUint32());
