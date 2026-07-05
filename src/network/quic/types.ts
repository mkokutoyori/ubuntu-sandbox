export type QuicLongPacketType = 'initial' | '0-rtt' | 'handshake' | 'retry';

export interface QuicLongHeaderPacket {
  form: 'long';
  type: QuicLongPacketType;
  version: number;
  destConnectionId: string;
  srcConnectionId: string;
  token?: Uint8Array;
  packetNumber?: number;
  payload: Uint8Array;
}

export interface QuicShortHeaderPacket {
  form: 'short';
  destConnectionId: string;
  packetNumber: number;
  payload: Uint8Array;
}

export interface QuicVersionNegotiationPacket {
  form: 'version-negotiation';
  destConnectionId: string;
  srcConnectionId: string;
  supportedVersions: number[];
}

export type QuicPacket = QuicLongHeaderPacket | QuicShortHeaderPacket | QuicVersionNegotiationPacket;

export const QUIC_VERSION_1 = 0x00000001;

export type PacketNumberSpace = 'initial' | 'handshake' | 'application';

// RFC 9000 §5.1 — keys derived per packet-number space. In P3 these are
// supplied directly by tests; from P8 onward they come from the real TLS
// key schedule (labels "quic key"/"quic iv"/"quic hp", §5.1) of PRD-TLS.md.
export interface PacketProtectionKeys {
  space: PacketNumberSpace;
  key: string;
  iv: string;
  headerProtectionKey: string;
}

// Connection IDs (RFC 9000 §5.1) are raw byte sequences of 0-20 bytes;
// represented here as hex strings, matching the project's convention for
// other wire addresses (MACAddress, IPAddress).
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
