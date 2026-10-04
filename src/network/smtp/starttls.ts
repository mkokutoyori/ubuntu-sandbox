import type { TcpSocket } from '@/network/tcp/TcpStack';
import type { TrafficProtection } from '@/network/tls/trafficProtection';
import { TlsServerSession, type TlsServerConfig } from '@/network/tls/TlsServerSession';
import { TlsClientSession, type TlsClientConfig } from '@/network/tls/TlsClientSession';
import type { TlsRecord } from '@/network/tls/recordLayer';
import { encodeRecords, decodeRecords, pumpTlsHandshake } from '@/network/http/https/TlsRecordWire';
import { encryptApplicationData, decryptApplicationData } from '@/network/http/https/ApplicationDataCipher';
import { selfSignedServiceCertificate } from '@/network/pki/SelfSignedCertificate';
import { bytesToBinaryString, binaryStringToBytes } from '@/crypto/encoding';

export const selfSignedSmtpCert = selfSignedServiceCertificate;

export { bytesToBinaryString, binaryStringToBytes };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function startClientHandshake(socket: TcpSocket, config: TlsClientConfig): TlsClientSession {
  const tls = new TlsClientSession(config);
  pumpTlsHandshake(socket, tls);
  socket.write(bytesToBinaryString(encodeRecords(tls.start())));
  return tls;
}

export function encodeFlight(records: readonly TlsRecord[]): string {
  return bytesToBinaryString(encodeRecords(records));
}

export function stepHandshake(tls: { handle(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null }, raw: string): string | null {
  const incoming = decodeRecords(binaryStringToBytes(raw));
  const nextFlight = tls.handle(incoming);
  if (!nextFlight || nextFlight.length === 0) return null;
  return bytesToBinaryString(encodeRecords(nextFlight));
}

export function encryptText(secret: TrafficProtection, seq: number, text: string): { wire: string; nextSeq: number } {
  const { records, nextSeq } = encryptApplicationData(secret, seq, encoder.encode(text));
  return { wire: bytesToBinaryString(encodeRecords(records)), nextSeq };
}

export function decryptText(secret: TrafficProtection, seq: number, raw: string): { text: string; nextSeq: number } {
  const incoming = decodeRecords(binaryStringToBytes(raw));
  const { plaintext, nextSeq } = decryptApplicationData(secret, seq, incoming);
  return { text: decoder.decode(plaintext), nextSeq };
}

export type { TlsServerConfig, TlsClientConfig };
export { TlsServerSession, TlsClientSession };
