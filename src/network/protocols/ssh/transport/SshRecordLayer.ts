import type { TcpStream } from '@/network/tcp/types';
import { aesGcmEncrypt, aesGcmDecrypt, AES_GCM_IV_SIZE } from '@/crypto/cipher/aesGcm';
import { hkdfExtract, hkdfExpand } from '@/network/tls/hkdf';
import {
  bytesToBase64, base64ToBytes, utf8ToBytes, bytesToUtf8,
} from '@/crypto/encoding';
import { x25519, x25519Base, X25519_KEY_LEN } from '@/crypto/ecc/x25519';

export const SSH_SEALED_TAG = '';
const KEY_LEN = 16;
const TAG_LEN = 16;
const SEQUENCE_LEN = 8;
const CLIENT_TO_SERVER = utf8ToBytes('ssh record client to server');
const SERVER_TO_CLIENT = utf8ToBytes('ssh record server to client');

export type SshRecordRole = 'client' | 'server';

export function generateEphemeralScalar(): Uint8Array {
  const scalar = new Uint8Array(X25519_KEY_LEN);
  for (let i = 0; i < scalar.length; i++) scalar[i] = Math.floor(Math.random() * 256);
  return scalar;
}

export function ephemeralPublicKey(scalar: Uint8Array): string {
  return bytesToBase64(x25519Base(scalar));
}

export function sharedSecretFrom(scalar: Uint8Array, peerPublicKey: string): Uint8Array | null {
  let peer: Uint8Array;
  try {
    peer = base64ToBytes(peerPublicKey);
  } catch {
    return null;
  }
  if (peer.length !== X25519_KEY_LEN) return null;
  return x25519(scalar, peer);
}

export function isSealedRecord(frame: string): boolean {
  return frame.startsWith(SSH_SEALED_TAG);
}

export class SshRecordLayer {
  private sendKey: Uint8Array | null = null;
  private receiveKey: Uint8Array | null = null;
  private sendSequence = 0;

  get established(): boolean {
    return this.sendKey !== null && this.receiveKey !== null;
  }

  install(sharedSecret: Uint8Array, role: SshRecordRole): void {
    const prk = hkdfExtract(new Uint8Array(32), sharedSecret);
    const clientToServer = hkdfExpand(prk, CLIENT_TO_SERVER, KEY_LEN);
    const serverToClient = hkdfExpand(prk, SERVER_TO_CLIENT, KEY_LEN);
    this.sendKey = role === 'client' ? clientToServer : serverToClient;
    this.receiveKey = role === 'client' ? serverToClient : clientToServer;
    this.sendSequence = 0;
  }

  seal(plaintext: string): string {
    const key = this.sendKey;
    if (!key) return plaintext;
    const sequence = this.sendSequence++;
    const { ciphertext, tag } = aesGcmEncrypt(
      key, ivFor(sequence), new Uint8Array(0), utf8ToBytes(plaintext),
    );
    const record = new Uint8Array(SEQUENCE_LEN + ciphertext.length + tag.length);
    record.set(sequenceBytes(sequence), 0);
    record.set(ciphertext, SEQUENCE_LEN);
    record.set(tag, SEQUENCE_LEN + ciphertext.length);
    return SSH_SEALED_TAG + bytesToBase64(record);
  }

  reveal(frame: string): string | null {
    return this.openWith(this.receiveKey, frame) ?? this.openWith(this.sendKey, frame);
  }

  open(frame: string): string | null {
    return this.openWith(this.receiveKey, frame);
  }

  private openWith(key: Uint8Array | null, frame: string): string | null {
    if (!key || !isSealedRecord(frame)) return null;
    let record: Uint8Array;
    try {
      record = base64ToBytes(frame.slice(SSH_SEALED_TAG.length));
    } catch {
      return null;
    }
    if (record.length < SEQUENCE_LEN + TAG_LEN) return null;
    let sequence = 0;
    for (let i = 0; i < SEQUENCE_LEN; i++) sequence = sequence * 256 + record[i];
    const ciphertext = record.subarray(SEQUENCE_LEN, record.length - TAG_LEN);
    const tag = record.subarray(record.length - TAG_LEN);
    const plaintext = aesGcmDecrypt(key, ivFor(sequence), new Uint8Array(0), ciphertext, tag);
    return plaintext === null ? null : bytesToUtf8(plaintext);
  }
}

function sequenceBytes(sequence: number): Uint8Array {
  const bytes = new Uint8Array(SEQUENCE_LEN);
  let remaining = sequence;
  for (let i = SEQUENCE_LEN - 1; i >= 0; i--) {
    bytes[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  return bytes;
}

function ivFor(sequence: number): Uint8Array {
  const iv = new Uint8Array(AES_GCM_IV_SIZE);
  iv.set(sequenceBytes(sequence), AES_GCM_IV_SIZE - SEQUENCE_LEN);
  return iv;
}

export function sealedStream(conn: TcpStream, records: SshRecordLayer): TcpStream {
  const sealed: TcpStream = {
    localIp: conn.localIp,
    localPort: conn.localPort,
    remoteIp: conn.remoteIp,
    remotePort: conn.remotePort,
    write: (data: string) => conn.write(records.established ? records.seal(data) : data),
    close: () => conn.close(),
    onData: (handler: (data: string) => void) => conn.onData((data) => {
      if (!isSealedRecord(data)) { handler(data); return; }
      const opened = records.open(data);
      if (opened !== null) handler(opened);
    }),
  };
  if (conn.onClose) {
    sealed.onClose = (handler: (reason: string) => void) => conn.onClose!(handler);
  }
  return sealed;
}
