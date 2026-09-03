import { isValidIPv4 } from '../core/ip';

export const DHCP_OPTION_CODE_MIN = 0;

/** 255 termine la liste et 0 la bourre (RFC 2132 §2), d'ou la plage d'IOS. */
export const DHCP_OPTION_CODE_MAX = 254;

export type DhcpOptionKind = 'ip' | 'ascii' | 'hex';

export const DHCP_OPTION_KINDS: readonly DhcpOptionKind[] = ['ascii', 'hex', 'ip'];

export function isDhcpOptionCode(code: number): boolean {
  return Number.isInteger(code)
    && code >= DHCP_OPTION_CODE_MIN && code <= DHCP_OPTION_CODE_MAX;
}

export function isDhcpOptionKind(word: string): word is DhcpOptionKind {
  return (DHCP_OPTION_KINDS as readonly string[]).includes(word.toLowerCase());
}

export function dhcpOptionValueIsValid(kind: DhcpOptionKind, value: string): boolean {
  const mots = value.trim().split(/\s+/).filter((m) => m.length > 0);
  if (mots.length === 0) return false;
  if (kind === 'ip') return mots.every((m) => isValidIPv4(m));
  if (kind === 'hex') return mots.every((m) => /^[0-9a-fA-F.]+$/.test(m));
  return true;
}

/** `01aa.bbcc.ddee.ff` — des chiffres hexadecimaux, groupes par des points. */
export function isDhcpClientIdentifier(token: string): boolean {
  return /^[0-9a-fA-F]+(\.[0-9a-fA-F]+)*$/.test(token);
}
