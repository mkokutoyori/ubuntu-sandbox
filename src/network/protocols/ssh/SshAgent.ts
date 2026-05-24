/**
 * SshAgent — in-memory key cache, one per host.
 *
 * Mirrors the role of OpenSSH's `ssh-agent(1)` daemon: holds parsed
 * private-key material loaded with `ssh-add`, so subsequent SSH
 * client invocations on the same machine can authenticate without
 * re-reading the on-disk identity file or prompting for a passphrase.
 *
 * The simulator stores no real key material — `material` is the raw
 * bytes read from the VFS, and `fingerprint` is a deterministic
 * non-cryptographic SHA256-shaped token (BRD C-02). The pedagogical
 * surface (`ssh-add -l` / `-L`, identity discovery, `ssh -A` agent
 * forwarding) is what matters for tutorials.
 *
 * Reference: SSH-IMPLEMENTATION-ANALYSIS.md §5 advanced features.
 */

import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

export interface AgentKey {
  /** Absolute VFS path to the identity file. */
  readonly path: string;
  /** Raw bytes read from the VFS (simulator's "private key material"). */
  readonly material: string;
  /** `SHA256:<base64>` — pedagogical, deterministic (BRD C-02). */
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
  add(path: string, vfs: VirtualFileSystem, comment?: string): boolean {
    const material = vfs.readFile(path);
    if (material === null) return false;
    const algo = detectAlgorithm(path);
    // Companion .pub file is what authorized_keys checks compare against.
    const publicKey = vfs.readFile(`${path}.pub`)?.trim() ?? null;
    const key: AgentKey = {
      path,
      material,
      fingerprint: fingerprintOf(material),
      algorithm: algo,
      comment: comment ?? defaultComment(path),
      bits: bitsFor(algo),
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
  addAll(home: string, vfs: VirtualFileSystem): string[] {
    const added: string[] = [];
    const base = `${home.replace(/\/$/, '')}/.ssh`;
    for (const file of DEFAULT_IDENTITY_FILES) {
      const path = `${base}/${file}`;
      if (this.add(path, vfs)) added.push(path);
    }
    return added;
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

function defaultComment(path: string): string {
  const at = path.lastIndexOf('/');
  return at >= 0 ? path.slice(at + 1) : path;
}

/**
 * Deterministic non-cryptographic stand-in for SHA-256 + base64
 * fingerprint. The shape (`SHA256:<token>`) is faithful so output
 * blends in with real OpenSSH lines.
 */
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
