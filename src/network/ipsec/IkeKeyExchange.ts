import {
  generateKeyExchange, sharedSecret, IMPLEMENTED_GROUPS,
  type KeyExchangeKeyPair,
} from '../tls/keyExchange';
import {
  generateModpKeyPair, modpFromHex, modpGroup, modpSharedSecret, modpToHex,
  type ModpKeyPair,
} from '../../crypto/dh/modp';
import type { IkeKeyExchangePayload } from './IPSecTypes';

/**
 * IANA "Transform Type 4 - Diffie-Hellman Group Transform IDs", limited to the
 * groups this repository actually computes. The elliptic-curve groups run
 * `tls/keyExchange.ts` (X25519 and P-256, checked against published vectors);
 * the modular-exponentiation groups run `crypto/dh/modp.ts`, whose primes come
 * from RFC 2409 and RFC 3526. A group absent from this table can produce no
 * shared secret, which is why it is refused rather than negotiated.
 */
export const IKE_GROUP_NAMES: Readonly<Record<number, string>> = Object.freeze({
  19: 'secp256r1',
  31: 'x25519',
});

export function ikeGroupName(group: number): string | undefined {
  return IKE_GROUP_NAMES[group];
}

export function isImplementedIkeGroup(group: number): boolean {
  const name = IKE_GROUP_NAMES[group];
  if (name !== undefined) return IMPLEMENTED_GROUPS.includes(name);
  return modpGroup(group) !== undefined;
}

export function implementedIkeGroups(): readonly number[] {
  const curves = Object.keys(IKE_GROUP_NAMES)
    .map(key => Number.parseInt(key, 10))
    .filter(group => IMPLEMENTED_GROUPS.includes(IKE_GROUP_NAMES[group]));
  const modp = [1, 2, 5, 14, 15, 16].filter(group => modpGroup(group) !== undefined);
  return Object.freeze([...modp, ...curves].sort((a, b) => a - b));
}

export type IkeKeyPair =
  | { readonly kind: 'curve'; readonly group: number; readonly pair: KeyExchangeKeyPair }
  | { readonly kind: 'modp'; readonly group: number; readonly pair: ModpKeyPair };

export function generateIkeKeyShare(group: number): {
  pair: IkeKeyPair; payload: IkeKeyExchangePayload;
} | null {
  const name = ikeGroupName(group);
  if (name !== undefined && IMPLEMENTED_GROUPS.includes(name)) {
    const pair = generateKeyExchange(name);
    return {
      pair: { kind: 'curve', group, pair },
      payload: { group, share: pair.share },
    };
  }

  const declared = modpGroup(group);
  if (!declared) return null;

  const pair = generateModpKeyPair(declared);
  return {
    pair: { kind: 'modp', group, pair },
    payload: { group, share: modpToHex(pair.publicKey) },
  };
}

export function ikeSharedSecret(
  own: IkeKeyPair, peer: IkeKeyExchangePayload | undefined,
): string | null {
  if (!peer || peer.group !== own.group) return null;

  if (own.kind === 'curve') {
    if (parseGroup(peer.share) !== own.pair.group) return null;
    return sharedSecret(own.pair, peer.share);
  }

  const secret = modpSharedSecret(own.pair, safeFromHex(peer.share));
  return secret === null ? null : modpToHex(secret);
}

function safeFromHex(share: string): bigint {
  try {
    return modpFromHex(share);
  } catch {
    return 0n;
  }
}

function parseGroup(share: string): string {
  const at = share.indexOf(':');
  return at < 0 ? share : share.slice(0, at);
}
