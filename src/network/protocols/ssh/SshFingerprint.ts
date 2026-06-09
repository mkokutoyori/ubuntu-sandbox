/**
 * SshFingerprint — immutable value object representing an SSH key fingerprint.
 *
 * Format: SHA256:base64(sha256(key)) with padding stripped — exactly what
 * OpenSSH `ssh-keygen -lf` prints. Backed by the real SHA-256 in `@/crypto`
 * (previously a non-cryptographic FNV stand-in).
 *
 * Reference: DESIGN-SSH-SFTP.md section 3.
 */

import { sha256, bytesToBase64, utf8ToBytes } from '@/crypto';

export class SshFingerprint {
  private constructor(private readonly _value: string) {}

  /**
   * Build a deterministic fingerprint from a public key string.
   * Pure function: same input always produces same output.
   */
  static fromPublicKey(publicKey: string): SshFingerprint {
    const digest = bytesToBase64(sha256(utf8ToBytes(publicKey))).replace(/=+$/, '');
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
