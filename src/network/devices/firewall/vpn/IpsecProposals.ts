import {
  implementedIkeGroups, isImplementedIkeGroup,
} from '../../../ipsec/IkeKeyExchange';
import type { IpsecProposal } from './IpsecTunnelTable';

export const NO_CHACHA = 'ChaCha20-Poly1305 is not implemented in this '
  + 'build. Accepting it would negotiate a cipher nothing can apply.';

export const SUPPORTED_CIPHERS: readonly string[] = Object.freeze([
  'des', '3des', 'aes128', 'aes192', 'aes256', 'aes128gcm', 'aes256gcm',
]);

export const SUPPORTED_INTEGRITY: readonly string[] = Object.freeze([
  'md5', 'sha1', 'sha256', 'sha384', 'sha512',
]);

const REFUSED_CIPHERS: Readonly<Record<string, string>> = Object.freeze({
  chacha20poly1305: NO_CHACHA,
});

export const DH_GROUPS: readonly number[] = implementedIkeGroups();

export function dhGroupRefusal(group: number): string | null {
  if (isImplementedIkeGroup(group)) return null;

  return `Diffie-Hellman group ${group} has no implementation in this build, `
    + 'so it could produce no shared secret. The key exchange computes groups '
    + `${implementedIkeGroups().join(', ')} for real — the modular ones on the `
    + 'primes of RFC 2409 and RFC 3526, the elliptic ones on X25519 and P-256. '
    + 'Accepting another group would negotiate a secret nothing derives.';
}

export type ProposalVerdict =
  | { readonly ok: true; readonly proposal: IpsecProposal }
  | { readonly ok: false; readonly reason: string; readonly term: string };

export function parseProposal(word: string): ProposalVerdict {
  const at = word.indexOf('-');
  if (at < 0) {
    return { ok: false, term: word, reason: `\`${word}\` is not a proposal; `
      + 'a proposal names a cipher and an integrity algorithm, as in '
      + '`aes256-sha256`.' };
  }

  const cipher = word.slice(0, at);
  const integrity = word.slice(at + 1);

  const refusal = REFUSED_CIPHERS[cipher];
  if (refusal) return { ok: false, term: cipher, reason: refusal };

  if (!SUPPORTED_CIPHERS.includes(cipher)) {
    return { ok: false, term: cipher, reason: `\`${cipher}\` is not a cipher `
      + `this build implements. Available: ${SUPPORTED_CIPHERS.join(', ')}.` };
  }
  if (!SUPPORTED_INTEGRITY.includes(integrity)) {
    return { ok: false, term: integrity, reason: `\`${integrity}\` is not an `
      + 'integrity algorithm this build implements. Available: '
      + `${SUPPORTED_INTEGRITY.join(', ')}.` };
  }

  return { ok: true, proposal: { cipher, integrity } };
}

export function isKnownDhGroup(group: number): boolean {
  return isImplementedIkeGroup(group);
}

export function renderProposal(proposal: IpsecProposal): string {
  return `${proposal.cipher}-${proposal.integrity}`;
}

export function proposalsAgree(
  local: readonly IpsecProposal[], remote: readonly IpsecProposal[],
): IpsecProposal | undefined {
  return local.find(mine => remote.some(theirs =>
    theirs.cipher === mine.cipher && theirs.integrity === mine.integrity));
}

export function dhGroupsAgree(
  local: readonly number[], remote: readonly number[],
): number | undefined {
  return local.find(group => remote.includes(group));
}
