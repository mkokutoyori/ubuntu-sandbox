import { bytesToBase64 } from '@/crypto/encoding';
import { sshKeyTypeLabel, sshPublicKeyBlob, sshPublicKeyFromBlob } from '@/network/devices/linux/network/SshKeygenMaterial';
import type { SshCertificate } from '../certificate/SshCertificate';
import { lineMatchesName, parseKnownHostsLines } from './KnownHostsLines';

export interface PresentedHostKey {
  readonly plainBlob: Uint8Array;
  readonly certificate: SshCertificate | null;
}

const BANNER_EDGE = '@'.repeat(67);

export function presentedKeyTypeLabel(presented: PresentedHostKey): string {
  if (presented.certificate !== null) return `${sshKeyTypeLabel(presented.certificate.subject.algorithm)}-CERT`;
  return sshKeyTypeLabel(sshPublicKeyFromBlob(presented.plainBlob)?.algorithm ?? '');
}

export function knownHostsRevocation(
  texts: readonly string[], host: string, presented: PresentedHostKey, strict: boolean,
): string[] | null {
  const candidates = new Set([bytesToBase64(presented.plainBlob)]);
  if (presented.certificate !== null) {
    candidates.add(bytesToBase64(presented.certificate.blob));
    candidates.add(bytesToBase64(sshPublicKeyBlob(presented.certificate.caKey)));
  }
  const revoked = texts.some((text) => parseKnownHostsLines(text).some((line) => (
    line.marker === 'revoke' && candidates.has(line.keyBlob) && lineMatchesName(line, host)
  )));
  if (!revoked) return null;
  const label = presentedKeyTypeLabel(presented);
  const lines = [
    BANNER_EDGE,
    '@       WARNING: REVOKED HOST KEY DETECTED!               @',
    BANNER_EDGE,
    `The ${label} host key for ${host} is marked as revoked.`,
    'This could mean that a stolen key is being used to',
    'impersonate this host.',
  ];
  if (strict) lines.push(`${label} host key for ${host} was revoked and you have requested strict checking.`);
  return lines;
}
