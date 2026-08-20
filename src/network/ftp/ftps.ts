/**
 * FTP (RFC 2228, RFC 4217) — FTPS wire glue: drives a real TLS 1.3
 * handshake (`PRD-TLS.md`'s `TlsClientSession`/`TlsServerSession`) over
 * an already-open `TcpSocket` — no new cryptographic primitive here,
 * this only wires the existing engine into FTP's upgrade-in-place model
 * (`AUTH TLS` on the control channel; `PROT P` on a data channel, RFC
 * 4217 §4). Reuses `TlsRecordWire.ts`/`ApplicationDataCipher.ts` from
 * the HTTPS adapter (`network/http/https/`), which are pure TLS-record
 * plumbing with no HTTP-specific logic, so nothing is duplicated.
 */
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { TlsServerSession, type TlsServerConfig } from '@/network/tls/TlsServerSession';
import { TlsClientSession, type TlsClientConfig } from '@/network/tls/TlsClientSession';
import type { TlsRecord } from '@/network/tls/recordLayer';
import { encodeRecords, decodeRecords } from '@/network/http/https/TlsRecordWire';
import { encryptApplicationData, decryptApplicationData } from '@/network/http/https/ApplicationDataCipher';

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

/**
 * Server side of an in-place TLS upgrade: registers the handshake
 * handler and waits — a TLS server never sends first. Caller must
 * ensure the peer's first flight arrives after this is registered
 * (true for `PASV`'s listener accepting a connection, and for the
 * control channel once the plaintext `234` reply has already gone out).
 */
export function startServerHandshake(socket: TcpSocket, config: TlsServerConfig): TlsServerSession {
  const tls = new TlsServerSession(config);
  socket.onData((data) => {
    if (tls.result !== null) return;
    const incoming = decodeRecords(binaryStringToBytes(String(data)));
    const nextFlight = tls.handle(incoming);
    if (nextFlight && nextFlight.length > 0) socket.write(bytesToBinaryString(encodeRecords(nextFlight)));
  });
  return tls;
}

/** Client side: sends the first `ClientHello` flight immediately, then reacts to the rest of the handshake. */
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

/** Encodes a raw handshake flight (e.g. `TlsClientSession.start()`'s `ClientHello`) into wire text. */
export function encodeFlight(records: readonly TlsRecord[]): string {
  return bytesToBinaryString(encodeRecords(records));
}

/**
 * Feeds one wire chunk through an in-progress handshake and returns any
 * reply flight, without subscribing to the socket itself — for a caller
 * that already owns a single `onData` dispatcher for this socket (the
 * control channel's) and would otherwise double-dispatch by adding a
 * second one via `startServerHandshake`/`startClientHandshake`.
 */
export function stepHandshake(tls: { handle(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null }, raw: string): string | null {
  const incoming = decodeRecords(binaryStringToBytes(raw));
  const nextFlight = tls.handle(incoming);
  if (!nextFlight || nextFlight.length === 0) return null;
  return bytesToBinaryString(encodeRecords(nextFlight));
}

/** Encrypts `text` (one FTP command/reply line, or one data-channel payload) into wire bytes ready for `socket.write()`. */
export function encryptText(secret: string, seq: number, text: string): { wire: string; nextSeq: number } {
  const { records, nextSeq } = encryptApplicationData(secret, seq, encoder.encode(text));
  return { wire: bytesToBinaryString(encodeRecords(records)), nextSeq };
}

/** Inverse of `encryptText`: `raw` is exactly one `onData` payload's `String(data)`. */
export function decryptText(secret: string, seq: number, raw: string): { text: string; nextSeq: number } {
  const incoming = decodeRecords(binaryStringToBytes(raw));
  const { plaintext, nextSeq } = decryptApplicationData(secret, seq, incoming);
  return { text: decoder.decode(plaintext), nextSeq };
}
