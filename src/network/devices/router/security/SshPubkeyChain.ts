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

export class SshPubkeyChain {
  private readonly users = new Map<string, SshPubkeyEntry[]>();

  ensureUser(name: string): void {
    if (!this.users.has(name)) this.users.set(name, []);
  }

  removeUser(name: string): boolean {
    return this.users.delete(name);
  }

  add(name: string, entry: SshPubkeyEntry): void {
    this.ensureUser(name);
    const entries = this.users.get(name)!;
    const at = entries.findIndex((e) => e.hash === entry.hash);
    if (at >= 0) entries[at] = entry;
    else entries.push(entry);
  }

  removeHash(name: string, hash: string): boolean {
    const entries = this.users.get(name);
    if (!entries) return false;
    const at = entries.findIndex((e) => e.hash === hash.toUpperCase());
    if (at < 0) return false;
    entries.splice(at, 1);
    return true;
  }

  admits(name: string, material: string): boolean {
    const hash = keyHashOfMaterial(material);
    if (hash === null) return false;
    return (this.users.get(name) ?? []).some((entry) => entry.hash === hash);
  }

  clear(): void {
    this.users.clear();
  }

  isEmpty(): boolean {
    return this.users.size === 0;
  }

  configLines(): string[] {
    if (this.users.size === 0) return [];
    const lines = ['ip ssh pubkey-chain'];
    for (const [name, entries] of this.users) {
      lines.push(`  username ${name}`);
      for (const entry of entries) {
        lines.push(`   key-hash ${entry.type} ${entry.hash}${entry.comment ? ` ${entry.comment}` : ''}`);
      }
      lines.push('  quit');
    }
    return lines;
  }
}
