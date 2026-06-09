/**
 * SshKeyPair — immutable value object describing a user's SSH key pair.
 *
 * Reference: DESIGN-SSH-SFTP.md section 3.
 */

import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { type Result, ok, err } from './Result';
import { SshFingerprint } from './SshFingerprint';
import { deriveKeyMaterial } from './sshKeyMaterial';

export class SshKeyPair {
  constructor(
    public readonly privateKeyPath: string,
    public readonly publicKeyPath: string,
    public readonly publicKeyContent: string,
    public readonly comment: string,
    public readonly algorithm: string,
  ) {}

  get fingerprint(): SshFingerprint {
    return SshFingerprint.fromPublicKey(this.publicKeyContent);
  }

  /**
   * Generate a deterministic key pair (simulator only).
   * Uses the comment as seed to keep the result stable for testing.
   */
  static generate(
    algorithm: string = 'ssh-ed25519',
    comment: string = 'user@host',
  ): SshKeyPair {
    const seed = `${algorithm}:${comment}`;
    const pub = deriveKeyMaterial(seed, 43);
    const privPath = '~/.ssh/id_ed25519';
    const pubPath = '~/.ssh/id_ed25519.pub';
    return new SshKeyPair(privPath, pubPath, pub, comment, algorithm);
  }

  /**
   * Load a key pair from the user's VFS given the private key path.
   * The public key is expected at `${privateKeyPath}.pub`.
   */
  static fromVfs(
    vfs: VirtualFileSystem,
    privateKeyPath: string,
  ): Result<SshKeyPair> {
    const pubPath = `${privateKeyPath}.pub`;
    const pubContent = vfs.readFile(pubPath);
    if (pubContent === null) {
      return err({
        kind: 'IO_ERROR',
        message: `cannot read public key at ${pubPath}`,
      });
    }
    if (vfs.readFile(privateKeyPath) === null) {
      return err({
        kind: 'IO_ERROR',
        message: `cannot read private key at ${privateKeyPath}`,
      });
    }
    const parsed = parsePublicKeyLine(pubContent.trim());
    return ok(
      new SshKeyPair(
        privateKeyPath,
        pubPath,
        parsed.material,
        parsed.comment,
        parsed.algorithm,
      ),
    );
  }
}

function parsePublicKeyLine(line: string): {
  algorithm: string;
  material: string;
  comment: string;
} {
  const parts = line.split(/\s+/);
  return {
    algorithm: parts[0] ?? 'ssh-ed25519',
    material: parts[1] ?? line,
    comment: parts.slice(2).join(' '),
  };
}

