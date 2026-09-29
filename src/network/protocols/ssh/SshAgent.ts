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
  keygenKeyFacts, keygenPrivateKey, keygenPublicOf,
} from '@/network/devices/linux/network/SshKeygenMaterial';

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

export class SshAgent {
  private readonly keys = new Map<string, AgentKey>();

  list(): readonly AgentKey[] {
    return [...this.keys.values()];
  }

  holds(blob: string): boolean {
    return this.keys.has(blob);
  }

  load(path: string, reader: SshAgentKeyReader): AgentLoad {
    const material = reader.readFile(path);
    if (material === null) return { status: 'missing' };
    const key = agentKeyOf(path, material);
    if (key === null) return { status: 'invalid' };
    this.keys.set(key.blob, key);
    return { status: 'added', key };
  }

  add(path: string, reader: SshAgentKeyReader): boolean {
    return this.load(path, reader).status === 'added';
  }

  install(key: AgentKey): void {
    this.keys.set(key.blob, key);
  }

  removeKey(blob: string): boolean {
    return this.keys.delete(blob);
  }

  removeAll(): void {
    this.keys.clear();
  }

  adopt(keys: readonly AgentKey[]): void {
    this.keys.clear();
    for (const k of keys) this.keys.set(k.blob, k);
  }
}
