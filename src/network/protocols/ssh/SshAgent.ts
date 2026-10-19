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
  keygenKeyFacts, keygenPrivateKey, keygenPublicOf, sshPublicKeyFromBlob,
} from '@/network/devices/linux/network/SshKeygenMaterial';
import { bytesToBase64 } from '@/crypto/encoding';
import { simulationNowMs } from '@/network/core/SystemClock';
import { signWithAlgorithm } from './auth/UserauthSignature';
import { SSH_AGENT_RSA_SHA2_256, SSH_AGENT_RSA_SHA2_512 } from './agent/AgentWire';

export interface SshAgentKeyReader {
  readFile(path: string): string | null;
}

export interface AgentKey {
  readonly path: string;
  readonly material: string;
  readonly blob: string;
  readonly algorithm: string;
  readonly comment: string;
  readonly bits: number;
  readonly publicKey: string;
}

export type AgentLoad =
  | { readonly status: 'added'; readonly key: AgentKey }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid' };

export function agentKeyOf(path: string, material: string): AgentKey | null {
  const privateKey = keygenPrivateKey(material);
  const publicLine = keygenPublicOf(material);
  if (privateKey === null || publicLine === null) return null;
  const [algorithm = '', blob = ''] = publicLine.split(/\s+/);
  const facts = keygenKeyFacts(publicLine);
  return {
    path,
    material,
    blob,
    algorithm: facts.label,
    comment: privateKey.comment || path,
    bits: facts.bits,
    publicKey: `${algorithm} ${blob}`,
  };
}

interface HeldKey {
  readonly key: AgentKey;
  readonly expiresAt: number | null;
}

export class SshAgent {
  private readonly keys = new Map<string, HeldKey>();
  private lockPassword: string | null = null;

  constructor(private readonly defaultLifetimeSeconds: number | null = null) {}

  get locked(): boolean {
    return this.lockPassword !== null;
  }

  private live(): HeldKey[] {
    const now = simulationNowMs();
    for (const [blob, held] of this.keys) if (held.expiresAt !== null && held.expiresAt <= now) this.keys.delete(blob);
    return [...this.keys.values()];
  }

  list(): readonly AgentKey[] {
    return this.locked ? [] : this.live().map((held) => held.key);
  }

  holds(blob: string): boolean {
    return !this.locked && this.live().some((held) => held.key.blob === blob);
  }

  load(path: string, reader: SshAgentKeyReader): AgentLoad {
    const material = reader.readFile(path);
    if (material === null) return { status: 'missing' };
    const key = agentKeyOf(path, material);
    if (key === null) return { status: 'invalid' };
    this.install(key);
    return { status: 'added', key };
  }

  add(path: string, reader: SshAgentKeyReader): boolean {
    return this.load(path, reader).status === 'added';
  }

  install(key: AgentKey, lifetimeSeconds?: number): boolean {
    if (this.locked) return false;
    const lifetime = lifetimeSeconds ?? this.defaultLifetimeSeconds;
    const expiresAt = lifetime === null ? null : simulationNowMs() + lifetime * 1000;
    this.keys.set(key.blob, { key, expiresAt });
    return true;
  }

  sign(blob: Uint8Array, data: Uint8Array, flags: number): Uint8Array | null {
    if (this.locked) return null;
    const held = this.live().find((entry) => entry.key.blob === bytesToBase64(blob));
    const privateKey = held === undefined ? null : keygenPrivateKey(held.key.material);
    const publicKey = sshPublicKeyFromBlob(blob);
    if (privateKey === null || publicKey === null) return null;
    if (publicKey.algorithm !== 'ssh-rsa') return signWithAlgorithm(privateKey, publicKey.algorithm, data);
    const algorithm = (flags & SSH_AGENT_RSA_SHA2_512) !== 0 ? 'rsa-sha2-512'
      : (flags & SSH_AGENT_RSA_SHA2_256) !== 0 ? 'rsa-sha2-256' : 'ssh-rsa';
    return signWithAlgorithm(privateKey, algorithm, data);
  }

  removeKey(blob: string): boolean {
    return !this.locked && this.keys.delete(blob);
  }

  removeAll(): void {
    if (!this.locked) this.keys.clear();
  }

  lock(password: string): boolean {
    if (this.locked) return false;
    this.lockPassword = password;
    return true;
  }

  unlock(password: string): boolean {
    if (this.lockPassword === null || this.lockPassword !== password) return false;
    this.lockPassword = null;
    return true;
  }

  adopt(keys: readonly AgentKey[]): void {
    this.keys.clear();
    for (const k of keys) this.keys.set(k.blob, { key: k, expiresAt: null });
  }
}
