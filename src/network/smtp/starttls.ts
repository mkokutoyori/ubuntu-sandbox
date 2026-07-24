import type { TcpSocket } from '@/network/tcp/TcpStack';
import { TlsServerSession, type TlsServerConfig } from '@/network/tls/TlsServerSession';
import { TlsClientSession, type TlsClientConfig } from '@/network/tls/TlsClientSession';
import type { TlsRecord } from '@/network/tls/recordLayer';
import { encodeRecords, decodeRecords } from '@/network/http/https/TlsRecordWire';
import { encryptApplicationData, decryptApplicationData } from '@/network/http/https/ApplicationDataCipher';
import { PkiKeyPair } from '@/network/pki/PkiKeyPair';
import { tbsPayload, type X509Certificate } from '@/network/pki/X509Certificate';

export function selfSignedSmtpCert(subject: string): { cert: X509Certificate; keyPair: PkiKeyPair } {
  const keyPair = PkiKeyPair.generate('rsa');
  const fields = {
    version: 3 as const, serialNumber: '1', subject, issuer: subject,
    notBefore: Date.now() - 1000, notAfter: Date.now() + 365 * 24 * 3600 * 1000,
    publicKey: keyPair.publicKey, signatureAlgorithm: 'sha256WithRSAEncryption' as const,
  };
  const signature = PkiKeyPair.sign(keyPair.privateKey, tbsPayload(fields));
  return { cert: { ...fields, signature }, keyPair };
}

export function bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

export function binaryStringToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function startClientHandshake(socket: TcpSocket, config: TlsClientConfig): TlsClientSession {
  const tls = new TlsClientSession(config);
  socket.onData((data) => {
    if (tls.result !== null) return;
    const incoming = decodeRecords(binaryStringToBytes(String(data)));
    const nextFlight = tls.handle(incoming);
    if (nextFlight && nextFlight.length > 0) socket.write(bytesToBinaryString(encodeRecords(nextFlight)));
  });
  const firstFlight = tls.start();
  socket.write(bytesToBinaryString(encodeRecords(firstFlight)));
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

export function encryptText(secret: string, seq: number, text: string): { wire: string; nextSeq: number } {
  const { records, nextSeq } = encryptApplicationData(secret, seq, encoder.encode(text));
  return { wire: bytesToBinaryString(encodeRecords(records)), nextSeq };
}

export function decryptText(secret: string, seq: number, raw: string): { text: string; nextSeq: number } {
  const incoming = decodeRecords(binaryStringToBytes(raw));
  const { plaintext, nextSeq } = decryptApplicationData(secret, seq, incoming);
  return { text: decoder.decode(plaintext), nextSeq };
}

export type { TlsServerConfig, TlsClientConfig };
export { TlsServerSession, TlsClientSession };
