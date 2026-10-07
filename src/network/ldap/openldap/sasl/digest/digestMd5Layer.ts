import { hmac } from '@/crypto/mac/hmac';
import { MD5, md5 } from '@/crypto/hash/md5';
import { Rc4 } from '@/crypto/cipher/rc4';
import {
  desCbcDecrypt, desCbcEncrypt, desKeyHasOddParity, isDesWeakKey, tripleDesCbcDecrypt, tripleDesCbcEncrypt,
} from '@/crypto/cipher/des';
import { SaslRc, type SaslLayerResult } from '../saslTypes';
import { PlugDecodeContext } from '../pluginUtils';

const SEALING_CLIENT_SERVER = 'Digest H(A1) to client-to-server sealing key magic constant';
const SEALING_SERVER_CLIENT = 'Digest H(A1) to server-to-client sealing key magic constant';
const SIGNING_CLIENT_SERVER = 'Digest session key to client-to-server signing key magic constant';
const SIGNING_SERVER_CLIENT = 'Digest session key to server-to-client signing key magic constant';
const MAC_SIZE = 10;
const PROTOCOL_VERSION = 1;

const encoder = new TextEncoder();

export type DigestRole = 'client' | 'server';

export interface OpenedPacket {
  readonly message: Uint8Array;
  readonly mac: Uint8Array;
}

export interface CipherPair {
  encrypt(plain: Uint8Array, digest: Uint8Array): Uint8Array;
  decrypt(sealed: Uint8Array): OpenedPacket | null;
}

export interface DigestCipher {
  readonly name: string;
  readonly ssf: number;
  readonly keyBytes: number;
  readonly flag: number;
  create(enckey: Uint8Array, deckey: Uint8Array): CipherPair | null;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of parts) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}

function slideBits(input: Uint8Array, offset: number): Uint8Array {
  const out = new Uint8Array(8);
  out[0] = input[offset];
  out[1] = ((input[offset] << 7) | (input[offset + 1] >> 1)) & 0xff;
  out[2] = ((input[offset + 1] << 6) | (input[offset + 2] >> 2)) & 0xff;
  out[3] = ((input[offset + 2] << 5) | (input[offset + 3] >> 3)) & 0xff;
  out[4] = ((input[offset + 3] << 4) | (input[offset + 4] >> 4)) & 0xff;
  out[5] = ((input[offset + 4] << 3) | (input[offset + 5] >> 5)) & 0xff;
  out[6] = ((input[offset + 5] << 2) | (input[offset + 6] >> 6)) & 0xff;
  out[7] = (input[offset + 6] << 1) & 0xff;
  return out;
}

function createRc4(enckey: Uint8Array, deckey: Uint8Array): CipherPair {
  const enc = new Rc4(enckey);
  const dec = new Rc4(deckey);
  return {
    encrypt: (plain, digest) => concat(enc.process(plain), enc.process(digest.subarray(0, MAC_SIZE))),
    decrypt(sealed) {
      if (sealed.length < MAC_SIZE) return null;
      const plain = dec.process(sealed);
      return { message: plain.subarray(0, plain.length - MAC_SIZE), mac: plain.subarray(plain.length - MAC_SIZE) };
    },
  };
}

interface BlockCipher {
  encrypt(data: Uint8Array, iv: Uint8Array): Uint8Array;
  decrypt(data: Uint8Array, iv: Uint8Array): Uint8Array;
}

function createBlockPair(
  encKey: BlockCipher, decKey: BlockCipher, encIv: Uint8Array, decIv: Uint8Array,
): CipherPair {
  let sendIv = Uint8Array.from(encIv);
  let receiveIv = Uint8Array.from(decIv);
  return {
    encrypt(plain, digest) {
      const paddingLength = 8 - ((plain.length + MAC_SIZE) % 8);
      const padding = new Uint8Array(paddingLength).fill(paddingLength);
      const sealed = encKey.encrypt(concat(plain, padding, digest.subarray(0, MAC_SIZE)), sendIv);
      sendIv = sealed.slice(sealed.length - 8);
      return sealed;
    },
    decrypt(sealed) {
      if (sealed.length < 16 || sealed.length % 8 !== 0) return null;
      const plain = decKey.decrypt(sealed, receiveIv);
      receiveIv = sealed.slice(sealed.length - 8);
      const padding = plain[sealed.length - 11];
      if (padding < 1 || padding > 8) return null;
      for (let index = 1; index <= padding; index++) {
        if (plain[sealed.length - 10 - index] !== padding) return null;
      }
      return {
        message: plain.subarray(0, sealed.length - padding - 10),
        mac: plain.subarray(sealed.length - 10),
      };
    },
  };
}

function createDes(enckey: Uint8Array, deckey: Uint8Array): CipherPair {
  const encDes = slideBits(enckey, 0);
  const decDes = slideBits(deckey, 0);
  return createBlockPair(
    { encrypt: (data, iv) => desCbcEncrypt(encDes, iv, data), decrypt: () => new Uint8Array(0) },
    { encrypt: () => new Uint8Array(0), decrypt: (data, iv) => desCbcDecrypt(decDes, iv, data) },
    enckey.slice(8, 16),
    deckey.slice(8, 16),
  );
}

function createTripleDes(enckey: Uint8Array, deckey: Uint8Array): CipherPair | null {
  const keys = [slideBits(enckey, 0), slideBits(enckey, 7), slideBits(deckey, 0), slideBits(deckey, 7)];
  if (keys.some((key) => !desKeyHasOddParity(key) || isDesWeakKey(key))) return null;
  const encTriple = concat(keys[0], keys[1]);
  const decTriple = concat(keys[2], keys[3]);
  return createBlockPair(
    { encrypt: (data, iv) => tripleDesCbcEncrypt(encTriple, iv, data), decrypt: () => new Uint8Array(0) },
    { encrypt: () => new Uint8Array(0), decrypt: (data, iv) => tripleDesCbcDecrypt(decTriple, iv, data) },
    enckey.slice(8, 16),
    deckey.slice(8, 16),
  );
}

export const AVAILABLE_CIPHERS: readonly DigestCipher[] = [
  { name: 'rc4-40', ssf: 40, keyBytes: 5, flag: 0x01, create: createRc4 },
  { name: 'rc4-56', ssf: 56, keyBytes: 7, flag: 0x02, create: createRc4 },
  { name: 'rc4', ssf: 128, keyBytes: 16, flag: 0x04, create: createRc4 },
  { name: 'des', ssf: 55, keyBytes: 16, flag: 0x08, create: createDes },
  { name: '3des', ssf: 112, keyBytes: 16, flag: 0x10, create: createTripleDes },
];

export interface DigestLayerKeys {
  readonly encryptionKey: Uint8Array;
  readonly decryptionKey: Uint8Array;
  readonly integritySend: Uint8Array;
  readonly integrityReceive: Uint8Array;
}

export function createLayerKeys(role: DigestRole, ha1: Uint8Array, keyBytes: number): DigestLayerKeys {
  const isServer = role === 'server';
  const sealSend = isServer ? SEALING_SERVER_CLIENT : SEALING_CLIENT_SERVER;
  const sealReceive = isServer ? SEALING_CLIENT_SERVER : SEALING_SERVER_CLIENT;
  const signSend = isServer ? SIGNING_SERVER_CLIENT : SIGNING_CLIENT_SERVER;
  const signReceive = isServer ? SIGNING_CLIENT_SERVER : SIGNING_SERVER_CLIENT;
  const truncated = ha1.subarray(0, keyBytes);
  return {
    encryptionKey: md5(concat(truncated, encoder.encode(sealSend))),
    decryptionKey: md5(concat(truncated, encoder.encode(sealReceive))),
    integritySend: md5(concat(ha1, encoder.encode(signSend))),
    integrityReceive: md5(concat(ha1, encoder.encode(signReceive))),
  };
}

function bigEndian32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

export class DigestSecurityLayer {
  private sendSequence = 0;
  private receiveSequence = 0;
  private readonly decoder: PlugDecodeContext;

  constructor(
    private readonly keys: DigestLayerKeys,
    private readonly cipher: CipherPair | null,
    maxReceive: number,
    private readonly seterror: (message: string) => void,
  ) {
    this.decoder = new PlugDecodeContext(maxReceive, () => undefined);
  }

  encode = (data: Uint8Array): SaslLayerResult => {
    const sequence = bigEndian32(this.sendSequence);
    const mac = hmac(MD5, this.keys.integritySend, concat(sequence, data));
    const body = this.cipher === null ? concat(data, mac.subarray(0, MAC_SIZE)) : this.cipher.encrypt(data, mac);
    const version = new Uint8Array([PROTOCOL_VERSION >> 8, PROTOCOL_VERSION & 0xff]);
    const packet = concat(bigEndian32(body.length + 6), body, version, sequence);
    this.sendSequence++;
    return { rc: SaslRc.OK, data: packet };
  };

  decode = (data: Uint8Array): SaslLayerResult => this.decoder.decode(data, (packet) => this.decodePacket(packet));

  private decodePacket(packet: Uint8Array): SaslLayerResult {
    const failure = { rc: SaslRc.FAIL, data: new Uint8Array(0) };
    if (packet.length < 16) {
      this.seterror('DIGEST-MD5 SASL packets must be at least 16 bytes long');
      return failure;
    }
    const version = (packet[packet.length - 6] << 8) | packet[packet.length - 5];
    if (version !== PROTOCOL_VERSION) {
      this.seterror('Wrong Version');
      return failure;
    }
    const sequence = ((packet[packet.length - 4] << 24) | (packet[packet.length - 3] << 16)
      | (packet[packet.length - 2] << 8) | packet[packet.length - 1]) >>> 0;
    if (sequence !== this.receiveSequence) {
      this.seterror(`Incorrect Sequence Number: received ${sequence}, expected ${this.receiveSequence}`);
      return failure;
    }
    const sequenceBytes = bigEndian32(this.receiveSequence);
    this.receiveSequence++;
    const sealed = packet.subarray(0, packet.length - 6);
    let opened: OpenedPacket | null;
    if (this.cipher !== null) {
      opened = this.cipher.decrypt(sealed);
    } else {
      opened = { message: sealed.subarray(0, sealed.length - MAC_SIZE), mac: sealed.subarray(sealed.length - MAC_SIZE) };
    }
    if (opened === null) return failure;
    const expected = hmac(MD5, this.keys.integrityReceive, concat(sequenceBytes, opened.message));
    for (let index = 0; index < MAC_SIZE; index++) {
      if (expected[index] !== opened.mac[index]) {
        this.seterror(`CMAC doesn't match at byte ${index}!`);
        return failure;
      }
    }
    return { rc: SaslRc.OK, data: Uint8Array.from(opened.message) };
  }
}
