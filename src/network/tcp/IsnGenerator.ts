import { hmac } from '@/crypto/mac';
import { SHA256 } from '@/crypto/hash';
import { utf8ToBytes } from '@/crypto/encoding';

export const ISN_TICKS_PER_MS = 250;

const SECRET_BYTES = 16;

export class IsnGenerator {
  private readonly secret: Uint8Array;

  constructor(secret?: Uint8Array) {
    this.secret = secret ?? globalThis.crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  }

  next(
    nowMs: number, localIp: string, localPort: number, remoteIp: string, remotePort: number,
  ): number {
    const clock = Math.floor(nowMs * ISN_TICKS_PER_MS) >>> 0;
    const digest = hmac(
      SHA256, this.secret, utf8ToBytes(`${localIp}|${localPort}|${remoteIp}|${remotePort}`));
    const offset = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
    return (clock + offset) >>> 0;
  }
}
