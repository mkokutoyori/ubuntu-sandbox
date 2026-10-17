import { bytesToBase64, fileTextToBytes } from '@/crypto/encoding';
import { keygenBlobDigest, sshKeyTypeLabel, sshPublicKeyBlob, type SshPublicKey } from '@/network/devices/linux/network/SshKeygenMaterial';
import { parsePublicKeyText } from '../keygen/AllowedSigners';
import { KeyRevocationList } from './KeyRevocationList';
import type { SshCertificate } from './SshCertificate';

export type RevocationVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'error'; readonly message: string };

const KRL_FAILURES = {
  'bad-magic': 'KRL file has invalid magic number',
  'invalid-format': 'invalid format',
  'signature-invalid': 'incorrect signature',
  'key-revoked': 'key is revoked',
} as const;

function sameKey(first: SshPublicKey, second: SshPublicKey): boolean {
  const left = sshPublicKeyBlob(first);
  const right = sshPublicKeyBlob(second);
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function listedKeys(text: string): SshPublicKey[] {
  const keys: SshPublicKey[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const key = parsePublicKeyText(line);
    if (key !== null) keys.push(key);
  }
  return keys;
}

export function checkRevocation(text: string | null, key: SshPublicKey | SshCertificate): RevocationVerdict {
  if (text === null) return { kind: 'error', message: 'No such file or directory' };
  const bytes = fileTextToBytes(text);
  if (KeyRevocationList.isKrl(bytes)) {
    const parsed = KeyRevocationList.parse(bytes);
    if (parsed.ok === false) return { kind: 'error', message: KRL_FAILURES[parsed.failure] };
    return parsed.krl.isRevoked(key) ? { kind: 'revoked' } : { kind: 'ok' };
  }
  const listed = listedKeys(text);
  const candidates = 'subject' in key ? [key.subject, key.caKey] : [key];
  return candidates.some((candidate) => listed.some((entry) => sameKey(entry, candidate))) ? { kind: 'revoked' } : { kind: 'ok' };
}

export function revocationFailureText(
  subject: 'Authentication key' | 'Host key', path: string, key: SshPublicKey | SshCertificate,
  verdict: Exclude<RevocationVerdict, { readonly kind: 'ok' }>,
): string {
  const certificate = 'subject' in key ? key : null;
  const blob = bytesToBase64(certificate === null ? sshPublicKeyBlob(key as SshPublicKey) : certificate.blob);
  const fingerprint = keygenBlobDigest(blob, 'sha256') ?? '(null)';
  const label = certificate === null
    ? `${sshKeyTypeLabel((key as SshPublicKey).algorithm)} ${fingerprint}`
    : `${sshKeyTypeLabel(certificate.subject.algorithm)}-CERT ${fingerprint}`;
  if (verdict.kind === 'revoked') return `${subject} ${label} revoked by file ${path}`;
  return `Error checking ${subject.toLowerCase()} ${label} in revoked keys file ${path}: ${verdict.message}`;
}
