/**
 * SshHostKey — immutable value object describing the host key of an SSH server.
 *
 * Reference: DESIGN-SSH-SFTP.md section 3.
 */

import { SshFingerprint } from './SshFingerprint';
import { keygenDeterministicPair, type EcdsaAlgorithm } from '@/network/devices/linux/network/SshKeygenMaterial';

export type SshKeyAlgorithm = 'ssh-ed25519' | 'ssh-rsa' | EcdsaAlgorithm;

export interface SshHostKeyMaterial {
  readonly publicKey: string;
  readonly privateKey: string;
}

export class SshHostKey {
  private material: SshHostKeyMaterial | null;

  private constructor(
    public readonly algorithm: SshKeyAlgorithm,
    publicKey: string | null,
    privateKey: string | null,
    private readonly load: (() => SshHostKeyMaterial) | null = null,
  ) {
    this.material = publicKey !== null && privateKey !== null ? { publicKey, privateKey } : null;
  }

  static deferred(algorithm: SshKeyAlgorithm, load: () => SshHostKeyMaterial): SshHostKey {
    return new SshHostKey(algorithm, null, null, load);
  }

  private resolved(): SshHostKeyMaterial {
    this.material ??= this.load!();
    return this.material;
  }

  get publicKey(): string {
    return this.resolved().publicKey;
  }

  /**
   * Generate a deterministic host key from a hostname.
   * Same hostname → same key. The simulator does not perform real crypto.
   */
  static generate(
    hostname: string,
    algorithm: SshKeyAlgorithm = 'ssh-ed25519',
    bits?: number,
  ): SshHostKey {
    const seed = bits === undefined ? `${algorithm}:${hostname}` : `${algorithm}:${bits}:${hostname}`;
    const pair = keygenDeterministicPair(algorithm, seed, `root@${hostname}`, bits);
    return new SshHostKey(algorithm, pair.pub.split(/\s+/)[1], pair.priv);
  }

  static fromFiles(
    publicKey: string,
    privateKey: string,
    algorithm: SshKeyAlgorithm = 'ssh-ed25519',
  ): SshHostKey {
    return new SshHostKey(algorithm, publicKey, privateKey);
  }

  get privateKeyBlob(): string {
    return this.resolved().privateKey;
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
