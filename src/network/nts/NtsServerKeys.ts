import { aesSivDecrypt, aesSivEncrypt } from '@/crypto/cipher';
import { AEAD_AES_SIV_CMAC_256, aeadKeyLength } from './NtsKeRecords';
import type { RandomBytes } from './NtsClient';

export const KEY_ID_INDEX_BITS = 2;
export const MAX_SERVER_KEYS = 1 << KEY_ID_INDEX_BITS;
export const FUTURE_KEYS = 1;
export const COOKIE_NONCE_LENGTH = 12;
export const DEFAULT_ROTATION_SECONDS = 86400;

interface ServerKey {
  readonly id: number;
  readonly key: Uint8Array;
}

export interface CookieContext {
  readonly aead: number;
  readonly c2s: Uint8Array;
  readonly s2c: Uint8Array;
}

export interface DumpedKeys {
  readonly current: number;
  readonly keys: ({ id: number; key: string } | null)[];
}

const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (text: string): Uint8Array => Uint8Array.from(text.match(/../g) ?? [], (h) => parseInt(h, 16));

export class NtsServerKeys {
  private readonly slots: (ServerKey | null)[] = Array.from({ length: MAX_SERVER_KEYS }, () => null);
  private current = 0;
  lastRotationMs = 0;

  constructor(private readonly random: RandomBytes, nowMs: number, private readonly rotationSeconds = DEFAULT_ROTATION_SECONDS) {
    this.generate(this.current, nowMs);
    this.generate((this.current + FUTURE_KEYS) % MAX_SERVER_KEYS, nowMs);
  }

  rotationIntervalMs(): number { return this.rotationSeconds * 1000; }

  private generate(index: number, nowMs: number): void {
    const idBytes = this.random(4);
    let id = ((idBytes[0] << 24) | (idBytes[1] << 16) | (idBytes[2] << 8) | idBytes[3]) >>> 0;
    id = ((id & (0xffffffff << KEY_ID_INDEX_BITS)) >>> 0) | index;
    this.slots[index] = { id, key: this.random(aeadKeyLength(AEAD_AES_SIV_CMAC_256)) };
    this.lastRotationMs = nowMs;
  }

  rotate(nowMs: number): void {
    this.current = (this.current + 1) % MAX_SERVER_KEYS;
    this.generate((this.current + FUTURE_KEYS) % MAX_SERVER_KEYS, nowMs);
  }

  rotateIfDue(nowMs: number): boolean {
    let rotated = false;
    while (nowMs - this.lastRotationMs >= this.rotationIntervalMs()) {
      this.rotate(this.lastRotationMs + this.rotationIntervalMs());
      rotated = true;
    }
    return rotated;
  }

  currentKeyId(): number { return this.slots[this.current]!.id; }

  generateCookie(context: CookieContext): Uint8Array {
    const key = this.slots[this.current]!;
    const nonce = this.random(COOKIE_NONCE_LENGTH);
    const plaintext = new Uint8Array(context.c2s.length + context.s2c.length);
    plaintext.set(context.c2s);
    plaintext.set(context.s2c, context.c2s.length);
    const sealed = aesSivEncrypt(key.key, [new Uint8Array(0), nonce], plaintext);
    const cookie = new Uint8Array(4 + nonce.length + sealed.length);
    cookie[0] = (key.id >>> 24) & 0xff;
    cookie[1] = (key.id >>> 16) & 0xff;
    cookie[2] = (key.id >>> 8) & 0xff;
    cookie[3] = key.id & 0xff;
    cookie.set(nonce, 4);
    cookie.set(sealed, 4 + nonce.length);
    return cookie;
  }

  decodeCookie(cookie: Uint8Array): CookieContext | null {
    if (cookie.length <= 4) return null;
    const id = ((cookie[0] << 24) | (cookie[1] << 16) | (cookie[2] << 8) | cookie[3]) >>> 0;
    const key = this.slots[id % MAX_SERVER_KEYS];
    if (key === null || key === undefined || key.id !== id) return null;
    if (cookie.length <= 4 + COOKIE_NONCE_LENGTH + 16) return null;
    const nonce = cookie.subarray(4, 4 + COOKIE_NONCE_LENGTH);
    const plaintext = aesSivDecrypt(key.key, [new Uint8Array(0), nonce], cookie.subarray(4 + COOKIE_NONCE_LENGTH));
    if (plaintext === null || plaintext.length % 2 !== 0 || plaintext.length / 2 !== aeadKeyLength(AEAD_AES_SIV_CMAC_256)) return null;
    const half = plaintext.length / 2;
    return { aead: AEAD_AES_SIV_CMAC_256, c2s: plaintext.slice(0, half), s2c: plaintext.slice(half) };
  }

  dump(): DumpedKeys {
    return { current: this.current, keys: this.slots.map((slot) => (slot === null ? null : { id: slot.id, key: toHex(slot.key) })) };
  }

  restore(dumped: DumpedKeys): void {
    if (dumped.keys.length !== MAX_SERVER_KEYS) return;
    dumped.keys.forEach((slot, index) => {
      this.slots[index] = slot === null ? null : { id: slot.id, key: fromHex(slot.key) };
    });
    this.current = dumped.current % MAX_SERVER_KEYS;
  }
}
