/**
 * SshHostKey — immutable value object describing the host key of an SSH server.
 *
 * Reference: DESIGN-SSH-SFTP.md section 3.
 */

import { SshFingerprint } from './SshFingerprint';

export type SshKeyAlgorithm = 'ssh-ed25519' | 'ssh-rsa' | 'ecdsa-sha2-nistp256';

export class SshHostKey {
  private constructor(
    public readonly algorithm: SshKeyAlgorithm,
    public readonly publicKey: string,
    private readonly _privateKey: string,
  ) {}

  /**
   * Generate a deterministic host key from a hostname.
   * Same hostname → same key. The simulator does not perform real crypto.
   */
  static generate(
    hostname: string,
    algorithm: SshKeyAlgorithm = 'ssh-ed25519',
  ): SshHostKey {
    const seed = `${algorithm}:${hostname}`;
    const publicKey = deterministicMaterial(seed, 43);
    const privateKey = deterministicMaterial(`priv:${seed}`, 64);
    return new SshHostKey(algorithm, publicKey, privateKey);
  }

  static fromFiles(
    publicKey: string,
    privateKey: string,
    algorithm: SshKeyAlgorithm = 'ssh-ed25519',
  ): SshHostKey {
    return new SshHostKey(algorithm, publicKey, privateKey);
  }

  get fingerprint(): SshFingerprint {
    return SshFingerprint.fromPublicKey(this.publicKey);
  }

  /** Format suitable for `~/.ssh/known_hosts` lines. */
  get publicKeyLine(): string {
    return `${this.algorithm} ${this.publicKey}`;
  }

  matches(other: SshHostKey): boolean {
    return (
      this.algorithm === other.algorithm && this.publicKey === other.publicKey
    );
  }
}

function deterministicMaterial(seed: string, length: number): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let state = 0x9e3779b9;
  for (let i = 0; i < seed.length; i++) {
    state = Math.imul(state ^ seed.charCodeAt(i), 0x85ebca6b);
    state ^= state >>> 13;
  }
  let out = '';
  for (let i = 0; i < length; i++) {
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35);
    out += alphabet[(state >>> 0) % alphabet.length];
  }
  return out;
}
