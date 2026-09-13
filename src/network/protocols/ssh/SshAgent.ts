/**
 * SshAgent — in-memory key cache, one per host.
 *
 * Mirrors the role of OpenSSH's `ssh-agent(1)` daemon: holds parsed
 * private-key material loaded with `ssh-add`, so subsequent SSH
 * client invocations on the same machine can authenticate without
 * re-reading the on-disk identity file or prompting for a passphrase.
 *
 * Reference: SSH-IMPLEMENTATION-ANALYSIS.md §5 advanced features.
 */

import {
  keygenDigest, keygenKeyFacts, keygenPublicOf,
} from '@/network/devices/linux/network/SshKeygenMaterial';

export interface SshAgentKeyReader {
  readFile(path: string): string | null;
}

export interface AgentKey {
  /** Absolute VFS path to the identity file. */
  readonly path: string;
  /** Raw bytes read from the VFS (simulator's "private key material"). */
  readonly material: string;
  /** `SHA256:<base64>` over the wire-format public blob. */
  readonly fingerprint: string;
  /** Algorithm derived from the file name (`id_ed25519` → `ED25519`). */
  readonly algorithm: 'ED25519' | 'RSA' | 'ECDSA' | 'DSA' | 'UNKNOWN';
  /** Comment line — defaults to `user@host` when none is stored. */
  readonly comment: string;
  /** Key size in bits (256 for ED25519, 2048+ for RSA in real life). */
  readonly bits: number;
  /** Public-key line as it would appear in authorized_keys (or null). */
  readonly publicKey: string | null;
}

const DEFAULT_IDENTITY_FILES = [
  'id_ed25519',
  'id_rsa',
  'id_ecdsa',
  'id_dsa',
] as const;

export class SshAgent {
  private readonly keys = new Map<string, AgentKey>();

  list(): readonly AgentKey[] {
    return [...this.keys.values()];
  }

  has(path: string): boolean {
    return this.keys.has(path);
  }

  /**
   * Load the identity file at `path` from `vfs`. Returns false when the
   * file does not exist (the same exit code OpenSSH's `ssh-add` returns
   * for an unknown identity).
   */
  add(path: string, vfs: SshAgentKeyReader, comment?: string): boolean {
    const material = vfs.readFile(path);
    if (material === null) return false;
    const publicKey = vfs.readFile(`${path}.pub`)?.trim() ?? keygenPublicOf(material);
    const facts = publicKey === null ? null : keygenKeyFacts(publicKey);
    const algo = labelToAlgorithm(facts?.label) ?? detectAlgorithm(path);
    const key: AgentKey = {
      path,
      material,
      fingerprint: (publicKey === null ? null : keygenDigest(publicKey, 'sha256'))
        ?? fingerprintOf(material),
      algorithm: algo,
      comment: comment ?? publicKeyComment(publicKey) ?? path,
      bits: facts?.bits ?? bitsFor(algo),
      publicKey,
    };
    this.keys.set(path, key);
    return true;
  }

  remove(path: string): boolean {
    return this.keys.delete(path);
  }

  removeAll(): void {
    this.keys.clear();
  }

  /**
   * Replace the agent's contents with a copy of `keys`. Used by `ssh -A`
   * agent forwarding to expose the originating host's identities to a
   * remote command, and to restore the remote agent once it completes.
   */
  adopt(keys: readonly AgentKey[]): void {
    this.keys.clear();
    for (const k of keys) this.keys.set(k.path, k);
  }

  /**
   * Walk `<home>/.ssh/` and load every default identity file present.
   * Returns the list of paths that were successfully added (in the
   * canonical OpenSSH order: ed25519, rsa, ecdsa, dsa).
   */
  addAll(home: string, vfs: SshAgentKeyReader): string[] {
    return this.addAllFrom(`${home.replace(/\/$/, '')}/.ssh`, '/', vfs);
  }

  addAllFrom(sshDir: string, separator: string, vfs: SshAgentKeyReader): string[] {
    const added: string[] = [];
    for (const file of DEFAULT_IDENTITY_FILES) {
      const path = [sshDir, file].join(separator);
      if (this.add(path, vfs)) added.push(path);
    }
    return added;
  }
}

function labelToAlgorithm(label: string | undefined): AgentKey['algorithm'] | null {
  switch (label) {
    case 'ED25519': return 'ED25519';
    case 'RSA': return 'RSA';
    case 'ECDSA': return 'ECDSA';
    case 'DSA': return 'DSA';
    default: return null;
  }
}

function detectAlgorithm(path: string): AgentKey['algorithm'] {
  const lower = path.toLowerCase();
  if (lower.includes('ed25519')) return 'ED25519';
  if (lower.includes('rsa')) return 'RSA';
  if (lower.includes('ecdsa')) return 'ECDSA';
  if (lower.includes('dsa')) return 'DSA';
  return 'UNKNOWN';
}

function bitsFor(algo: AgentKey['algorithm']): number {
  switch (algo) {
    case 'ED25519':
      return 256;
    case 'RSA':
      return 2048;
    case 'ECDSA':
      return 256;
    case 'DSA':
      return 1024;
    default:
      return 0;
  }
}

function publicKeyComment(publicKey: string | null): string | null {
  if (publicKey === null) return null;
  const comment = publicKey.trim().split(/\s+/).slice(2).join(' ');
  return comment === '' ? null : comment;
}

function fingerprintOf(material: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hex = h.toString(16).padStart(8, '0');
  const seed = `fp:${hex}:${material.length}:${material.slice(0, 8)}`;
  const b64 =
    typeof btoa === 'function'
      ? btoa(unescape(encodeURIComponent(seed)))
      : Buffer.from(seed, 'utf-8').toString('base64');
  return `SHA256:${b64.replace(/=+$/, '').slice(0, 43)}`;
}
