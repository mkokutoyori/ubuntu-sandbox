import { systemRandom, type RandomSource } from '@/crypto/random';
import {
  AES256_PROFILE, KerberosIntegrityError, checksum, decryptWithConfounder, encrypt,
} from '../enctype/aesCtsHmacSha1';
import { TOKEN_ID_MIC, TOKEN_ID_WRAP } from './GssToken';

export const KG_USAGE_ACCEPTOR_SEAL = 22;
export const KG_USAGE_ACCEPTOR_SIGN = 23;
export const KG_USAGE_INITIATOR_SEAL = 24;
export const KG_USAGE_INITIATOR_SIGN = 25;

const HEADER_BYTES = 16;
const WRAP_FILLER = 0xff;
const FLAG_SENT_BY_ACCEPTOR = 0x01;
const FLAG_SEALED = 0x02;
const FLAG_ACCEPTOR_SUBKEY = 0x04;
const MIC_FILLER_BYTES = 5;
const CHECKSUM_BYTES = 12;
const CONFOUNDER_BYTES = 16;
const SEQUENCE_MODULUS = 2 ** 32;

export type GssRole = 'initiator' | 'acceptor';

export class GssTokenError extends Error {
  constructor(readonly reason: 'defective-token' | 'bad-mic' | 'bad-direction' | 'unsequenced' | 'bad-key', message: string) {
    super(message);
    this.name = 'GssTokenError';
  }
}

export interface GssSecurityContextOptions {
  readonly role: GssRole;
  readonly key: Uint8Array;
  readonly usesAcceptorSubkey: boolean;
  readonly sendSequence: number;
  readonly receiveSequence: number;
  readonly sequenceChecking: boolean;
  readonly random?: RandomSource;
}

export interface UnwrappedMessage {
  readonly data: Uint8Array;
  readonly sealed: boolean;
}

function rotateLeft(bytes: Uint8Array, amount: number): Uint8Array {
  if (bytes.length === 0) return bytes;
  const shift = amount % bytes.length;
  if (shift === 0) return bytes;
  const out = new Uint8Array(bytes.length);
  out.set(bytes.subarray(shift), 0);
  out.set(bytes.subarray(0, shift), bytes.length - shift);
  return out;
}

function concatenated(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function sequenceBytes(sequence: number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(sequence / SEQUENCE_MODULUS) % SEQUENCE_MODULUS, false);
  view.setUint32(4, sequence % SEQUENCE_MODULUS, false);
  return out;
}

function sequenceOf(header: Uint8Array): number {
  const view = new DataView(header.buffer, header.byteOffset, header.length);
  return view.getUint32(0, false) * SEQUENCE_MODULUS + view.getUint32(4, false);
}

export class GssSecurityContext {
  private sendSequence: number;
  private expectedSequence: number;
  private readonly random: RandomSource;

  constructor(private readonly options: GssSecurityContextOptions) {
    this.sendSequence = options.sendSequence;
    this.expectedSequence = options.receiveSequence;
    this.random = options.random ?? systemRandom;
  }

  get sessionStrengthBits(): number {
    return this.options.key.length * 8;
  }

  wrapOverhead(sealed: boolean): number {
    return sealed ? HEADER_BYTES + CONFOUNDER_BYTES + HEADER_BYTES + CHECKSUM_BYTES : HEADER_BYTES + CHECKSUM_BYTES;
  }

  private get ownSealUsage(): number {
    return this.options.role === 'initiator' ? KG_USAGE_INITIATOR_SEAL : KG_USAGE_ACCEPTOR_SEAL;
  }

  private get peerSealUsage(): number {
    return this.options.role === 'initiator' ? KG_USAGE_ACCEPTOR_SEAL : KG_USAGE_INITIATOR_SEAL;
  }

  private get ownSignUsage(): number {
    return this.options.role === 'initiator' ? KG_USAGE_INITIATOR_SIGN : KG_USAGE_ACCEPTOR_SIGN;
  }

  private get peerSignUsage(): number {
    return this.options.role === 'initiator' ? KG_USAGE_ACCEPTOR_SIGN : KG_USAGE_INITIATOR_SIGN;
  }

  private ownFlags(sealed: boolean): number {
    return (this.options.role === 'acceptor' ? FLAG_SENT_BY_ACCEPTOR : 0)
      | (sealed ? FLAG_SEALED : 0)
      | (this.options.usesAcceptorSubkey ? FLAG_ACCEPTOR_SUBKEY : 0);
  }

  private nextSequence(): number {
    const sequence = this.sendSequence;
    this.sendSequence = (this.sendSequence + 1) % (SEQUENCE_MODULUS * SEQUENCE_MODULUS);
    return sequence;
  }

  wrap(data: Uint8Array, sealed: boolean): Uint8Array {
    const header = new Uint8Array(HEADER_BYTES);
    header[0] = TOKEN_ID_WRAP >> 8;
    header[1] = TOKEN_ID_WRAP & 0xff;
    header[2] = this.ownFlags(sealed);
    header[3] = WRAP_FILLER;
    header.set(sequenceBytes(this.nextSequence()), 8);
    if (sealed) {
      const ciphertext = encrypt(AES256_PROFILE, this.options.key, this.ownSealUsage, concatenated([data, header]), this.random);
      return concatenated([header, ciphertext]);
    }
    const mic = checksum(AES256_PROFILE, this.options.key, this.ownSealUsage, concatenated([data, header]));
    header[4] = mic.length >> 8;
    header[5] = mic.length & 0xff;
    return concatenated([header, data, mic]);
  }

  unwrap(token: Uint8Array): UnwrappedMessage {
    const header = this.parseHeader(token, TOKEN_ID_WRAP);
    const sealed = (header[2] & FLAG_SEALED) !== 0;
    const extraCount = (header[4] << 8) | header[5];
    const rotation = (header[6] << 8) | header[7];
    const zeroed = header.slice();
    zeroed[4] = 0;
    zeroed[5] = 0;
    zeroed[6] = 0;
    zeroed[7] = 0;
    if (sealed) {
      const ciphertext = rotateLeft(token.subarray(HEADER_BYTES), rotation);
      const opened = this.openSealed(ciphertext);
      const copy = opened.slice(opened.length - HEADER_BYTES);
      const data = opened.slice(0, opened.length - HEADER_BYTES - extraCount);
      const comparable = header.slice();
      comparable[6] = 0;
      comparable[7] = 0;
      if (!copy.every((byte, index) => byte === comparable[index])) {
        throw new GssTokenError('defective-token', 'the encrypted header does not match the clear header');
      }
      this.checkSequence(header);
      return { data, sealed: true };
    }
    const body = rotateLeft(token.subarray(HEADER_BYTES), rotation);
    const data = body.slice(0, body.length - extraCount);
    const mic = body.slice(body.length - extraCount);
    const expected = checksum(AES256_PROFILE, this.options.key, this.peerSealUsage, concatenated([data, zeroed]));
    if (mic.length !== CHECKSUM_BYTES || !expected.every((byte, index) => byte === mic[index])) {
      throw new GssTokenError('bad-mic', 'the checksum of the wrap token is wrong');
    }
    this.checkSequence(header);
    return { data, sealed: false };
  }

  getMic(data: Uint8Array): Uint8Array {
    const header = new Uint8Array(HEADER_BYTES);
    header[0] = TOKEN_ID_MIC >> 8;
    header[1] = TOKEN_ID_MIC & 0xff;
    header[2] = this.ownFlags(false);
    header.fill(WRAP_FILLER, 3, 3 + MIC_FILLER_BYTES);
    header.set(sequenceBytes(this.nextSequence()), 8);
    const mic = checksum(AES256_PROFILE, this.options.key, this.ownSignUsage, concatenated([data, header]));
    return concatenated([header, mic]);
  }

  verifyMic(data: Uint8Array, token: Uint8Array): void {
    const header = this.parseHeader(token, TOKEN_ID_MIC);
    const expected = checksum(AES256_PROFILE, this.options.key, this.peerSignUsage, concatenated([data, header]));
    const mic = token.subarray(HEADER_BYTES);
    if (mic.length !== expected.length || !expected.every((byte, index) => byte === mic[index])) {
      throw new GssTokenError('bad-mic', 'the checksum of the MIC token is wrong');
    }
    this.checkSequence(header);
  }

  private openSealed(ciphertext: Uint8Array): Uint8Array {
    try {
      return decryptWithConfounder(AES256_PROFILE, this.options.key, this.peerSealUsage, ciphertext).plaintext;
    } catch (error) {
      if (error instanceof KerberosIntegrityError) throw new GssTokenError('bad-key', 'the encrypted token does not decrypt');
      throw error;
    }
  }

  private parseHeader(token: Uint8Array, tokenId: number): Uint8Array {
    if (token.length < HEADER_BYTES || ((token[0] << 8) | token[1]) !== tokenId) {
      throw new GssTokenError('defective-token', 'the token header is not that of the expected token');
    }
    const header = token.slice(0, HEADER_BYTES);
    const sentByAcceptor = (header[2] & FLAG_SENT_BY_ACCEPTOR) !== 0;
    if (sentByAcceptor === (this.options.role === 'acceptor')) {
      throw new GssTokenError('bad-direction', 'the token was sent in the wrong direction');
    }
    if (((header[2] & FLAG_ACCEPTOR_SUBKEY) !== 0) !== this.options.usesAcceptorSubkey) {
      throw new GssTokenError('bad-key', 'the token names a key the context does not use');
    }
    return header;
  }

  private checkSequence(header: Uint8Array): void {
    if (!this.options.sequenceChecking) return;
    const sequence = sequenceOf(header.subarray(8));
    if (sequence !== this.expectedSequence) {
      throw new GssTokenError('unsequenced', 'the token is out of sequence');
    }
    this.expectedSequence = (this.expectedSequence + 1) % (SEQUENCE_MODULUS * SEQUENCE_MODULUS);
  }
}
