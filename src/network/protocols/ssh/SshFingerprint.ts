/**
 * SshFingerprint — immutable value object representing an SSH key fingerprint.
 *
 * Format: SHA256:base64(sha256(blob)) with padding stripped — exactly what
 * OpenSSH `ssh-keygen -lf` prints, over the DECODED wire blob.
 *
 * Reference: DESIGN-SSH-SFTP.md section 3.
 */

import { keygenBlobDigest } from '@/network/devices/linux/network/SshKeygenMaterial';

export class SshFingerprint {
  private constructor(private readonly _value: string) {}

  /**
   * Build a deterministic fingerprint from a public key string.
   * Pure function: same input always produces same output.
   */
  static fromPublicKey(publicKey: string): SshFingerprint {
    const fields = publicKey.trim().split(/\s+/);
    const blob = fields.length > 1 ? fields[1] : fields[0];
    return new SshFingerprint(keygenBlobDigest(blob, 'sha256') ?? 'SHA256:');
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
