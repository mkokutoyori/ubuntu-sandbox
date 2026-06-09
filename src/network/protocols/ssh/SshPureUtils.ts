/**
 * SshPureUtils — pure functions for parsing and formatting SSH artefacts.
 *
 * No I/O, no mutation, no time-dependent behavior.
 *
 * Reference: DESIGN-SSH-SFTP.md section 3.2.
 */

import { SshFingerprint } from './SshFingerprint';
import { SshHostKey, type SshKeyAlgorithm } from './SshHostKey';
import { hmac, SHA1, sha1, bytesToBase64, base64ToBytes, utf8ToBytes } from '@/crypto';

export interface KnownHostEntry {
  readonly host: string;
  readonly key: SshHostKey;
}

export interface AuthorizedKey {
  readonly algorithm: string;
  readonly material: string;
  readonly comment: string;
}

export interface SshHostConfig {
  readonly host: string;
  readonly hostName?: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly strictHostKeyChecking?: 'yes' | 'no' | 'accept-new';
}

const HOST_KEY_ALGORITHMS: readonly SshKeyAlgorithm[] = [
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
];

export function generateDeterministicKey(hostname: string): string {
  return SshHostKey.generate(hostname).publicKey;
}

export function computeFingerprint(publicKey: string): string {
  return SshFingerprint.fromPublicKey(publicKey).toString();
}

export function formatFingerprintLine(fp: SshFingerprint): string {
  return `Host key fingerprint is ${fp.toString()}`;
}

export function parseKnownHostsLine(line: string): KnownHostEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) return null;
  const [host, algorithm, material] = parts;
  if (!HOST_KEY_ALGORITHMS.includes(algorithm as SshKeyAlgorithm)) return null;
  const key = SshHostKey.fromFiles(material, '', algorithm as SshKeyAlgorithm);
  return { host, key };
}

export function formatKnownHostsEntry(host: string, key: SshHostKey): string {
  return `${host} ${key.algorithm} ${key.publicKey}`;
}

/**
 * Produce an OpenSSH-style `|1|<salt>|<hash>` host token for the
 * `HashKnownHosts yes` mode: HMAC-SHA1 over the host name, keyed by the raw
 * (base64-decoded) salt, with both fields base64-encoded — exactly the real
 * OpenSSH format. The salt is derived deterministically per host (OpenSSH
 * uses 20 random bytes; the simulator favours stability so the same host
 * always hashes identically and `matchHashedHost` round-trips).
 */
export function hashKnownHostsToken(host: string, salt?: string): string {
  const saltB64 = salt ?? deriveSalt(host);
  const saltBytes = base64ToBytes(saltB64);
  const hashB64 = bytesToBase64(hmac(SHA1, saltBytes, utf8ToBytes(host)));
  return `|1|${saltB64}|${hashB64}`;
}

export function isHashedKnownHostsToken(host: string): boolean {
  return host.startsWith('|1|');
}

export function matchHashedHost(hashedToken: string, candidate: string): boolean {
  if (!isHashedKnownHostsToken(hashedToken)) return hashedToken === candidate;
  const parts = hashedToken.split('|');
  if (parts.length < 4) return false;
  const salt = parts[2];
  return hashKnownHostsToken(candidate, salt) === hashedToken;
}

/**
 * Deterministic 20-byte salt (SHA-1 output size) for a host, base64-encoded.
 * Stable across runs so a given host always produces the same token.
 */
function deriveSalt(host: string): string {
  return bytesToBase64(sha1(utf8ToBytes(`salt:${host}`)));
}

export function parseSshConfigBlock(block: string): SshHostConfig {
  const cfg: Record<string, string> = {};
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.search(/\s/);
    if (idx === -1) continue;
    const key = line.slice(0, idx).toLowerCase();
    const value = line.slice(idx + 1).trim();
    cfg[key] = value;
  }
  return {
    host: cfg.host ?? '*',
    hostName: cfg.hostname,
    user: cfg.user,
    port: cfg.port ? Number.parseInt(cfg.port, 10) : undefined,
    identityFile: cfg.identityfile,
    strictHostKeyChecking: cfg.stricthostkeychecking as
      | 'yes'
      | 'no'
      | 'accept-new'
      | undefined,
  };
}

export function expandTilde(path: string, homeDir: string): string {
  if (path === '~') return homeDir;
  if (path.startsWith('~/')) return `${homeDir}/${path.slice(2)}`;
  return path;
}

export function parseOctalMode(mode: string): number {
  return Number.parseInt(mode, 8);
}

export function formatOctalMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

export function parseAuthorizedKeysLine(line: string): AuthorizedKey | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;
  const [algorithm, material, ...rest] = parts;
  if (!algorithm.startsWith('ssh-') && !algorithm.startsWith('ecdsa-')) {
    return null;
  }
  return { algorithm, material, comment: rest.join(' ') };
}

/**
 * Format the transfer progress line per OpenSSH sftp conventions:
 * <name padded 40> 100% <size> <speed>   00:00
 *
 * Reference: BRD-SSH-SFTP.md SFTP-09.
 */
export function formatTransferProgress(name: string, bytes: number): string {
  const padded = padOrTruncate(name, 40);
  const size = formatHumanSize(bytes);
  const speed = `${formatHumanSize(bytes)}/s`;
  return `${padded} 100% ${size.padStart(8, ' ')}   ${speed.padStart(9, ' ')}   00:00`;
}

function padOrTruncate(name: string, width: number): string {
  if (name.length === width) return name;
  if (name.length < width) return name.padEnd(width, ' ');
  // Truncate keeping the trailing portion (so the basename stays visible).
  return '...' + name.slice(name.length - (width - 3));
}

function formatHumanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

export function formatHumanBytes(bytes: number): string {
  return formatHumanSize(bytes);
}

/**
 * Minimal shape consumed by formatLsLongEntry. Concrete dir entries from
 * the filesystem layer (`ISftpFileSystem.SftpDirEntry`) satisfy this contract.
 */
export interface FormattableDirEntry {
  readonly name: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly mtime: number;
  readonly type: 'file' | 'directory' | 'symlink';
}

export function formatLsLongEntry(entry: FormattableDirEntry): string {
  const typeChar =
    entry.type === 'directory' ? 'd' : entry.type === 'symlink' ? 'l' : '-';
  const perms = formatPermBits(entry.mode);
  const size = String(entry.size).padStart(8, ' ');
  const date = formatMtime(entry.mtime);
  return `${typeChar}${perms}  1 ${entry.uid} ${entry.gid} ${size} ${date} ${entry.name}`;
}

function formatPermBits(mode: number): string {
  const r = (b: number) => ((mode & b) !== 0 ? 'r' : '-');
  const w = (b: number) => ((mode & b) !== 0 ? 'w' : '-');
  const x = (b: number) => ((mode & b) !== 0 ? 'x' : '-');
  return (
    r(0o400) +
    w(0o200) +
    x(0o100) +
    r(0o040) +
    w(0o020) +
    x(0o010) +
    r(0o004) +
    w(0o002) +
    x(0o001)
  );
}

function formatMtime(mtime: number): string {
  const d = new Date(mtime);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const month = months[d.getUTCMonth()];
  const day = String(d.getUTCDate()).padStart(2, ' ');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${month} ${day} ${hh}:${mm}`;
}

export function pipe<A, B, C>(f: (a: A) => B, g: (b: B) => C): (a: A) => C;
export function pipe<A, B, C, D>(
  f: (a: A) => B,
  g: (b: B) => C,
  h: (c: C) => D,
): (a: A) => D;
export function pipe(...fns: Array<(x: unknown) => unknown>) {
  return (input: unknown) => fns.reduce((acc, fn) => fn(acc), input);
}
