import { sha256 } from '@/crypto/hash/sha256';
import { bytesToBase64, base64ToBytes } from '@/crypto/encoding';
import { encodeCanonicalName } from '@/network/dns/wire/DnsMessageCodec';
import { makeDhcidRecord } from '@/network/dns/wire/ResourceRecord';
import type { DhcidRecordData, ResourceRecord } from '@/network/dns/wire/ResourceRecord';

export const DHCID_IDENTIFIER_HTYPE_CHADDR = 0x0000;
export const DHCID_IDENTIFIER_CLIENT_ID = 0x0001;
export const DHCID_IDENTIFIER_DUID = 0x0002;
export const DHCID_DIGEST_SHA256 = 1;

export interface DhcidIdentity {
  readonly identifierType: number;
  readonly identifier: Uint8Array;
}

function macToBytes(mac: string): Uint8Array {
  const parts = mac.split(/[:-]/).filter(p => p.length > 0);
  const bytes = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i++) bytes[i] = parseInt(parts[i], 16) & 0xff;
  return bytes;
}

export function dhcidIdentityFromChaddr(mac: string, htype = 1): DhcidIdentity {
  const chaddr = macToBytes(mac);
  const identifier = new Uint8Array(1 + chaddr.length);
  identifier[0] = htype & 0xff;
  identifier.set(chaddr, 1);
  return { identifierType: DHCID_IDENTIFIER_HTYPE_CHADDR, identifier };
}

export function dhcidIdentityFromClientId(clientId: string): DhcidIdentity {
  const looksLikeMac = /^[0-9a-f]{2}([:-][0-9a-f]{2})+$/i.test(clientId);
  const identifier = looksLikeMac
    ? macToBytes(clientId)
    : Uint8Array.from(clientId, c => c.charCodeAt(0) & 0xff);
  return { identifierType: DHCID_IDENTIFIER_CLIENT_ID, identifier };
}

export function computeDhcidDigest(identity: DhcidIdentity, fqdn: string): string {
  const name = Uint8Array.from(encodeCanonicalName(fqdn));
  const input = new Uint8Array(identity.identifier.length + name.length);
  input.set(identity.identifier, 0);
  input.set(name, identity.identifier.length);
  return String.fromCharCode(...sha256(input));
}

export function makeDhcidForClient(
  fqdn: string, identity: DhcidIdentity, ttl = 3600,
): ResourceRecord<DhcidRecordData> {
  return makeDhcidRecord(fqdn, ttl, {
    identifierType: identity.identifierType,
    digestType: DHCID_DIGEST_SHA256,
    digest: computeDhcidDigest(identity, fqdn),
  });
}

export function dhcidToPresentation(data: DhcidRecordData): string {
  const bytes = new Uint8Array(3 + data.digest.length);
  bytes[0] = (data.identifierType >> 8) & 0xff;
  bytes[1] = data.identifierType & 0xff;
  bytes[2] = data.digestType & 0xff;
  for (let i = 0; i < data.digest.length; i++) bytes[3 + i] = data.digest.charCodeAt(i) & 0xff;
  return bytesToBase64(bytes);
}

export function dhcidFromPresentation(text: string): {
  identifierType: number; digestType: number; digest: string;
} {
  const bytes = base64ToBytes(text.replace(/\s+/g, ''));
  if (bytes.length < 3) throw new Error(`DHCID RDATA is too short (${bytes.length} octets)`);
  return {
    identifierType: (bytes[0] << 8) | bytes[1],
    digestType: bytes[2],
    digest: String.fromCharCode(...bytes.subarray(3)),
  };
}

export function dhcidMatches(a: DhcidRecordData, b: DhcidRecordData): boolean {
  return a.identifierType === b.identifierType
    && a.digestType === b.digestType
    && a.digest === b.digest;
}
