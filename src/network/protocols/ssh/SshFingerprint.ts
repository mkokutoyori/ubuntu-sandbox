/**
 * SshFingerprint — immutable value object representing an SSH key fingerprint.
 *
 * Format: SHA256:base64-like-hash (mimics OpenSSH `ssh-keygen -lf`).
 *
 * Reference: DESIGN-SSH-SFTP.md section 3.
 */

export class SshFingerprint {
  private constructor(private readonly _value: string) {}

  /**
   * Build a deterministic fingerprint from a public key string.
   * Pure function: same input always produces same output.
   */
  static fromPublicKey(publicKey: string): SshFingerprint {
    const digest = simpleHash(publicKey);
    return new SshFingerprint(`SHA256:${digest}`);
  }

  static fromString(raw: string): SshFingerprint {
    return new SshFingerprint(raw);
  }

  toString(): string {
    return this._value;
  }

  toShortForm(): string {
    // The first 12 characters after the algorithm prefix.
    const colon = this._value.indexOf(':');
    const tail = colon === -1 ? this._value : this._value.slice(colon + 1);
    return tail.slice(0, 12);
  }

  equals(other: SshFingerprint): boolean {
    return this._value === other._value;
  }
}

/**
 * Deterministic non-cryptographic hash.
 * Sufficient for the simulator: produces a stable 43-char base64-like digest
 * for any given input, no external dependency.
 */
function simpleHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xdeadbeef;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  const bytes: number[] = [];
  for (let i = 0; i < 32; i++) {
    h1 = Math.imul(h1 ^ (h1 >>> 13), 0x5bd1e995);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 0xc2b2ae35);
    bytes.push(((h1 ^ h2) >>> ((i % 4) * 8)) & 0xff);
  }
  return base64(bytes).replace(/=+$/, '');
}

const B64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes: readonly number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i] ?? 0;
    const b2 = bytes[i + 1] ?? 0;
    const b3 = bytes[i + 2] ?? 0;
    out += B64[b1 >> 2];
    out += B64[((b1 & 0x03) << 4) | (b2 >> 4)];
    out += i + 1 < bytes.length ? B64[((b2 & 0x0f) << 2) | (b3 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b3 & 0x3f] : '=';
  }
  return out;
}
