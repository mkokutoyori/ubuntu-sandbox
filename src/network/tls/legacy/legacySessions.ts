import { aesGcmEncrypt, aesGcmDecrypt, AES_GCM_TAG_SIZE } from '@/crypto/cipher';
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from '@/crypto/encoding';
import type { LegacyVersion } from './legacyCipherSuites';

export interface LegacySessionState {
  readonly id: string;
  readonly version: LegacyVersion;
  readonly suiteName: string;
  readonly master: string;
  readonly extendedMasterSecret: boolean;
  readonly createdAt: number;
  readonly lifetimeSeconds: number;
}

export interface ResumableLegacySession {
  readonly state: LegacySessionState;
  readonly ticket: string | null;
}

export const DEFAULT_SESSION_TIMEOUT_SECONDS = 300;

export function sessionIsFresh(state: LegacySessionState, now: number): boolean {
  return now >= state.createdAt && now <= state.createdAt + state.lifetimeSeconds * 1000;
}

export class LegacySessionStore {
  private readonly sessions = new Map<string, LegacySessionState>();

  constructor(
    readonly timeoutSeconds: number = DEFAULT_SESSION_TIMEOUT_SECONDS,
    private readonly clock: () => number = Date.now,
  ) {}

  put(state: LegacySessionState): void {
    this.sessions.set(state.id, state);
  }

  get(id: string): LegacySessionState | null {
    const state = this.sessions.get(id);
    if (!state) return null;
    if (!sessionIsFresh(state, this.clock())) {
      this.sessions.delete(id);
      return null;
    }
    return state;
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }
}

const NONCE_LENGTH = 12;

export class LegacyTicketCodec {
  constructor(private readonly key: Uint8Array, private readonly clock: () => number = Date.now) {
    if (key.length !== 32) throw new RangeError('ticket key must be 32 bytes');
  }

  seal(state: LegacySessionState): string {
    const nonce = new Uint8Array(NONCE_LENGTH);
    for (let i = 0; i < NONCE_LENGTH; i++) nonce[i] = Math.floor(Math.random() * 256);
    const { ciphertext, tag } = aesGcmEncrypt(this.key, nonce, new Uint8Array(0), utf8ToBytes(JSON.stringify(state)));
    const out = new Uint8Array(NONCE_LENGTH + ciphertext.length + tag.length);
    out.set(nonce, 0);
    out.set(ciphertext, NONCE_LENGTH);
    out.set(tag, NONCE_LENGTH + ciphertext.length);
    return bytesToHex(out);
  }

  open(ticket: string): LegacySessionState | null {
    if (!/^[0-9a-f]+$/i.test(ticket) || ticket.length % 2 !== 0) return null;
    const bytes = hexToBytes(ticket);
    if (bytes.length < NONCE_LENGTH + AES_GCM_TAG_SIZE) return null;
    const cipherEnd = bytes.length - AES_GCM_TAG_SIZE;
    const plain = aesGcmDecrypt(
      this.key, bytes.subarray(0, NONCE_LENGTH), new Uint8Array(0),
      bytes.subarray(NONCE_LENGTH, cipherEnd), bytes.subarray(cipherEnd),
    );
    if (plain === null) return null;
    try {
      const state = JSON.parse(bytesToUtf8(plain)) as LegacySessionState;
      return sessionIsFresh(state, this.clock()) ? state : null;
    } catch {
      return null;
    }
  }
}
