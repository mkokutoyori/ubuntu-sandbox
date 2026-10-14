import { md5 } from '@/crypto/hash/md5';
import { base64ToBytes, bytesToHex } from '@/crypto/encoding';

export type SshPubkeyType = 'ssh-rsa';

export interface SshPubkeyEntry {
  readonly type: SshPubkeyType;
  readonly hash: string;
  readonly comment?: string;
}

export interface DecodedKeyString {
  readonly entry: SshPubkeyEntry;
}

const HASH_PATTERN = /^[0-9A-Fa-f]{32}$/;
const SSH_RSA = 'ssh-rsa';

function blobAlgorithm(blob: Uint8Array): string | null {
  if (blob.length < 4) return null;
  const length = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(0);
  if (length > blob.length - 4) return null;
  return new TextDecoder().decode(blob.subarray(4, 4 + length));
}

export function keyHashOfMaterial(material: string): string | null {
  let blob: Uint8Array;
  try {
    blob = base64ToBytes(material);
  } catch {
    return null;
  }
  if (blobAlgorithm(blob) !== SSH_RSA) return null;
  return bytesToHex(md5(blob)).toUpperCase();
}

export function decodeKeyString(lines: readonly string[]): DecodedKeyString | null {
  const words = lines.join(' ').split(/\s+/).filter((word) => word.length > 0);
  const body = words[0] === SSH_RSA ? words.slice(1) : words;
  const split = body.findIndex((word) => !/^[A-Za-z0-9+/=]+$/.test(word));
  const material = (split < 0 ? body : body.slice(0, split)).join('');
  const comment = split < 0 ? [] : body.slice(split);
  const hash = keyHashOfMaterial(material);
  if (hash === null) return null;
  return { entry: { type: SSH_RSA, hash, ...(comment.length > 0 ? { comment: comment.join(' ') } : {}) } };
}

export function parseKeyHash(words: readonly string[]): SshPubkeyEntry | null {
  const [type, hash, ...comment] = words;
  if (type !== SSH_RSA || hash === undefined || !HASH_PATTERN.test(hash)) return null;
  return { type: SSH_RSA, hash: hash.toUpperCase(), ...(comment.length > 0 ? { comment: comment.join(' ') } : {}) };
}

class KeyTable {
  private readonly owners = new Map<string, SshPubkeyEntry[]>();

  ensure(name: string): void {
    if (!this.owners.has(name)) this.owners.set(name, []);
  }

  remove(name: string): boolean {
    return this.owners.delete(name);
  }

  add(name: string, entry: SshPubkeyEntry): void {
    this.ensure(name);
    const entries = this.owners.get(name)!;
    const at = entries.findIndex((e) => e.hash === entry.hash);
    if (at >= 0) entries[at] = entry;
    else entries.push(entry);
  }

  removeHash(name: string, hash: string): boolean {
    const entries = this.owners.get(name);
    if (!entries) return false;
    const at = entries.findIndex((e) => e.hash === hash.toUpperCase());
    if (at < 0) return false;
    entries.splice(at, 1);
    return true;
  }

  admits(name: string, material: string): boolean {
    const hash = keyHashOfMaterial(material);
    if (hash === null) return false;
    return (this.owners.get(name) ?? []).some((entry) => entry.hash === hash);
  }

  clear(): void {
    this.owners.clear();
  }

  get size(): number {
    return this.owners.size;
  }

  entries(): IterableIterator<[string, SshPubkeyEntry[]]> {
    return this.owners.entries();
  }
}

export class SshPubkeyChain {
  private readonly users = new KeyTable();
  private readonly servers = new KeyTable();

  ensureUser(name: string): void { this.users.ensure(name); }
  removeUser(name: string): boolean { return this.users.remove(name); }
  add(name: string, entry: SshPubkeyEntry): void { this.users.add(name, entry); }
  removeHash(name: string, hash: string): boolean { return this.users.removeHash(name, hash); }
  admits(name: string, material: string): boolean { return this.users.admits(name, material); }

  ensureServer(name: string): void { this.servers.ensure(name); }
  removeServer(name: string): boolean { return this.servers.remove(name); }
  addServerKey(name: string, entry: SshPubkeyEntry): void { this.servers.add(name, entry); }
  removeServerHash(name: string, hash: string): boolean { return this.servers.removeHash(name, hash); }
  admitsServer(name: string, material: string): boolean { return this.servers.admits(name, material); }

  clear(): void {
    this.users.clear();
    this.servers.clear();
  }

  isEmpty(): boolean {
    return this.users.size === 0 && this.servers.size === 0;
  }

  configLines(): string[] {
    if (this.isEmpty()) return [];
    const lines = ['ip ssh pubkey-chain'];
    for (const [heading, table] of [['username', this.users], ['server', this.servers]] as const) {
      for (const [name, entries] of table.entries()) {
        lines.push(`  ${heading} ${name}`);
        for (const entry of entries) {
          lines.push(`   key-hash ${entry.type} ${entry.hash}${entry.comment ? ` ${entry.comment}` : ''}`);
        }
        lines.push('  quit');
      }
    }
    return lines;
  }
}
