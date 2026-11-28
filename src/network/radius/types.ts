import { md5 } from '@/crypto/hash';
import { bytesToHex, bytesToUtf8, hexToBytes, utf8ToBytes } from '@/crypto/encoding';
import type { NetworkPdu } from '@/network/core/NetworkPdu';

export const UDP_PORT_RADIUS_AUTH = 1812;
export const UDP_PORT_RADIUS_ACCT = 1813;
/** RFC 5176 §3: Dynamic Authorization (CoA/Disconnect) default port. */
export const UDP_PORT_RADIUS_COA = 3799;

export type RadiusCode =
  | 'access-request'
  | 'access-accept'
  | 'access-reject'
  | 'access-challenge'
  | 'status-server'
  | 'accounting-request'
  | 'accounting-response'
  | 'disconnect-request'
  | 'disconnect-ack'
  | 'disconnect-nak'
  | 'coa-request'
  | 'coa-ack'
  | 'coa-nak';

export const RADIUS_CODE: Record<RadiusCode, number> = {
  'access-request': 1,
  'access-accept': 2,
  'access-reject': 3,
  'access-challenge': 11,
  'status-server': 12,
  'accounting-request': 4,
  'accounting-response': 5,
  'disconnect-request': 40,
  'disconnect-ack': 41,
  'disconnect-nak': 42,
  'coa-request': 43,
  'coa-ack': 44,
  'coa-nak': 45,
};

export const RADIUS_PACKET_NAME: Record<RadiusCode, string> = {
  'access-request': 'Access-Request',
  'access-accept': 'Access-Accept',
  'access-reject': 'Access-Reject',
  'access-challenge': 'Access-Challenge',
  'status-server': 'Status-Server',
  'accounting-request': 'Accounting-Request',
  'accounting-response': 'Accounting-Response',
  'disconnect-request': 'Disconnect-Request',
  'disconnect-ack': 'Disconnect-ACK',
  'disconnect-nak': 'Disconnect-NAK',
  'coa-request': 'CoA-Request',
  'coa-ack': 'CoA-ACK',
  'coa-nak': 'CoA-NAK',
};

export type RadiusAttrType =
  | 'egress-vlanid'
  | 'ingress-filters'
  | 'egress-vlan-name'
  | 'user-priority-table'
  | 'nas-filter-rule'
  | 'digest-response'
  | 'digest-realm'
  | 'digest-nonce'
  | 'digest-response-auth'
  | 'digest-nextnonce'
  | 'digest-method'
  | 'digest-uri'
  | 'digest-qop'
  | 'digest-algorithm'
  | 'digest-entity-body-hash'
  | 'digest-cnonce'
  | 'digest-nonce-count'
  | 'digest-username'
  | 'digest-opaque'
  | 'digest-auth-param'
  | 'digest-aka-auts'
  | 'digest-domain'
  | 'digest-stale'
  | 'digest-ha1'
  | 'sip-aor'
  | 'operator-name'
  | 'location-information'
  | 'location-data'
  | 'basic-location-policy-rules'
  | 'extended-location-policy-rules'
  | 'location-capable'
  | 'requested-location-info'
  | 'framed-ipv6-address'
  | 'dns-server-ipv6-address'
  | 'route-ipv6-information'
  | 'delegated-ipv6-prefix-pool'
  | 'stateful-ipv6-address-pool'
  | 'gss-acceptor-service-name'
  | 'gss-acceptor-host-name'
  | 'gss-acceptor-service-specifics'
  | 'gss-acceptor-realm-name'
  | 'allowed-called-station-id'
  | 'eap-peer-id'
  | 'eap-server-id'
  | 'mobility-domain-id'
  | 'preauth-timeout'
  | 'network-id-name'
  | 'eapol-announcement'
  | 'wlan-hessid'
  | 'wlan-venue-info'
  | 'wlan-venue-language'
  | 'wlan-venue-name'
  | 'wlan-reason-code'
  | 'wlan-pairwise-cipher'
  | 'wlan-group-cipher'
  | 'wlan-akm-suite'
  | 'wlan-group-mgmt-cipher'
  | 'wlan-rf-band'
  | 'framed-ipx-network'
  | 'login-lat-service'
  | 'login-lat-node'
  | 'login-lat-group'
  | 'framed-appletalk-link'
  | 'framed-appletalk-network'
  | 'framed-appletalk-zone'
  | 'login-lat-port'
  | 'acct-multi-session-id'
  | 'acct-link-count'
  | 'acct-tunnel-connection'
  | 'acct-tunnel-packets-lost'
  | 'tunnel-client-endpoint'
  | 'tunnel-server-endpoint'
  | 'tunnel-assignment-id'
  | 'tunnel-preference'
  | 'tunnel-client-auth-id'
  | 'tunnel-server-auth-id'
  | 'arap-password'
  | 'arap-features'
  | 'arap-zone-access'
  | 'arap-security'
  | 'arap-security-data'
  | 'password-retry'
  | 'prompt'
  | 'connect-info'
  | 'configuration-token'
  | 'arap-challenge-response'
  | 'acct-interim-interval'
  | 'chargeable-user-identity'
  | 'delegated-ipv6-prefix'
  | 'user-name'
  | 'user-password'
  | 'chap-password'
  | 'nas-ip-address'
  | 'nas-port'
  | 'service-type'
  | 'framed-protocol'
  | 'framed-ip-address'
  | 'framed-ip-netmask'
  | 'framed-mtu'
  | 'filter-id'
  | 'login-ip-host'
  | 'reply-message'
  | 'callback-number'
  | 'state'
  | 'class'
  | 'vendor-specific'
  | 'session-timeout'
  | 'idle-timeout'
  | 'termination-action'
  | 'called-station-id'
  | 'calling-station-id'
  | 'nas-identifier'
  | 'proxy-state'
  | 'acct-status-type'
  | 'acct-delay-time'
  | 'acct-input-octets'
  | 'acct-output-octets'
  | 'acct-session-id'
  | 'acct-authentic'
  | 'acct-session-time'
  | 'acct-input-packets'
  | 'acct-output-packets'
  | 'acct-terminate-cause'
  | 'acct-input-gigawords'
  | 'acct-output-gigawords'
  | 'event-timestamp'
  | 'chap-challenge'
  | 'nas-port-type'
  | 'tunnel-type'
  | 'tunnel-medium-type'
  | 'eap-message'
  | 'message-authenticator'
  | 'tunnel-private-group-id'
  | 'nas-port-id'
  | 'framed-pool'
  | 'error-cause'
  | 'nas-ipv6-address'
  | 'framed-interface-id'
  | 'framed-ipv6-prefix'
  | 'login-ipv6-host'
  | 'framed-ipv6-route'
  | 'framed-ipv6-pool'
  | 'framed-routing'
  | 'framed-compression'
  | 'login-service'
  | 'login-tcp-port'
  | 'callback-id'
  | 'framed-route'
  | 'port-limit';

export const RADIUS_ATTR: Record<RadiusAttrType, number> = {
  'user-name': 1,
  'user-password': 2,
  'chap-password': 3,
  'nas-ip-address': 4,
  'nas-port': 5,
  'service-type': 6,
  'framed-protocol': 7,
  'framed-ip-address': 8,
  'framed-ip-netmask': 9,
  'framed-mtu': 12,
  'filter-id': 11,
  'login-ip-host': 14,
  'reply-message': 18,
  'callback-number': 19,
  'state': 24,
  'class': 25,
  'vendor-specific': 26,
  'session-timeout': 27,
  'idle-timeout': 28,
  'termination-action': 29,
  'called-station-id': 30,
  'calling-station-id': 31,
  'nas-identifier': 32,
  'proxy-state': 33,
  'acct-status-type': 40,
  'acct-delay-time': 41,
  'acct-input-octets': 42,
  'acct-output-octets': 43,
  'acct-session-id': 44,
  'acct-authentic': 45,
  'acct-session-time': 46,
  'acct-input-packets': 47,
  'acct-output-packets': 48,
  'acct-terminate-cause': 49,
  'acct-input-gigawords': 52,
  'acct-output-gigawords': 53,
  'event-timestamp': 55,
  'chap-challenge': 60,
  'nas-port-type': 61,
  'tunnel-type': 64,
  'tunnel-medium-type': 65,
  'eap-message': 79,
  'message-authenticator': 80,
  'tunnel-private-group-id': 81,
  'nas-port-id': 87,
  'framed-pool': 88,
  'error-cause': 101,
  // RFC 3162 §2 — RADIUS extensions for IPv6.
  'nas-ipv6-address': 95,
  'framed-interface-id': 96,
  'framed-ipv6-prefix': 97,
  'login-ipv6-host': 98,
  'framed-ipv6-route': 99,
  'framed-ipv6-pool': 100,
  'framed-routing': 10,
  'framed-compression': 13,
  'login-service': 15,
  'login-tcp-port': 16,
  'callback-id': 20,
  'framed-route': 22,
  'port-limit': 62,
  'egress-vlanid': 56,
  'ingress-filters': 57,
  'egress-vlan-name': 58,
  'user-priority-table': 59,
  'nas-filter-rule': 92,
  'digest-response': 103,
  'digest-realm': 104,
  'digest-nonce': 105,
  'digest-response-auth': 106,
  'digest-nextnonce': 107,
  'digest-method': 108,
  'digest-uri': 109,
  'digest-qop': 110,
  'digest-algorithm': 111,
  'digest-entity-body-hash': 112,
  'digest-cnonce': 113,
  'digest-nonce-count': 114,
  'digest-username': 115,
  'digest-opaque': 116,
  'digest-auth-param': 117,
  'digest-aka-auts': 118,
  'digest-domain': 119,
  'digest-stale': 120,
  'digest-ha1': 121,
  'sip-aor': 122,
  'operator-name': 126,
  'location-information': 127,
  'location-data': 128,
  'basic-location-policy-rules': 129,
  'extended-location-policy-rules': 130,
  'location-capable': 131,
  'requested-location-info': 132,
  'framed-ipv6-address': 168,
  'dns-server-ipv6-address': 169,
  'route-ipv6-information': 170,
  'delegated-ipv6-prefix-pool': 171,
  'stateful-ipv6-address-pool': 172,
  'gss-acceptor-service-name': 164,
  'gss-acceptor-host-name': 165,
  'gss-acceptor-service-specifics': 166,
  'gss-acceptor-realm-name': 167,
  'allowed-called-station-id': 174,
  'eap-peer-id': 175,
  'eap-server-id': 176,
  'mobility-domain-id': 177,
  'preauth-timeout': 178,
  'network-id-name': 179,
  'eapol-announcement': 180,
  'wlan-hessid': 181,
  'wlan-venue-info': 182,
  'wlan-venue-language': 183,
  'wlan-venue-name': 184,
  'wlan-reason-code': 185,
  'wlan-pairwise-cipher': 186,
  'wlan-group-cipher': 187,
  'wlan-akm-suite': 188,
  'wlan-group-mgmt-cipher': 189,
  'wlan-rf-band': 190,
  'framed-ipx-network': 23,
  'login-lat-service': 34,
  'login-lat-node': 35,
  'login-lat-group': 36,
  'framed-appletalk-link': 37,
  'framed-appletalk-network': 38,
  'framed-appletalk-zone': 39,
  'login-lat-port': 63,
  'acct-multi-session-id': 50,
  'acct-link-count': 51,
  'acct-tunnel-connection': 68,
  'acct-tunnel-packets-lost': 86,
  'tunnel-client-endpoint': 66,
  'tunnel-server-endpoint': 67,
  'tunnel-assignment-id': 82,
  'tunnel-preference': 83,
  'tunnel-client-auth-id': 90,
  'tunnel-server-auth-id': 91,
  'arap-password': 70,
  'arap-features': 71,
  'arap-zone-access': 72,
  'arap-security': 73,
  'arap-security-data': 74,
  'password-retry': 75,
  'prompt': 76,
  'connect-info': 77,
  'configuration-token': 78,
  'arap-challenge-response': 84,
  'acct-interim-interval': 85,
  'chargeable-user-identity': 89,
  'delegated-ipv6-prefix': 123,
};

export interface RadiusAttribute {
  type: RadiusAttrType;
  value: string | number;
  /** Present only on 'vendor-specific' (26): Vendor-Id + sub-attribute Vendor-Type (RFC 2865 §5.26). */
  vendor?: { id: number; type: number };
  tag?: number;
}

export interface RadiusPacket extends NetworkPdu {
  type: 'radius';
  code: RadiusCode;
  identifier: number;
  authenticator: string;
  attributes: RadiusAttribute[];
  /** Wire-format bytes, when produced by/decoded through `codec.ts` — optional, transport doesn't require it. */
  raw?: Uint8Array;
}

export interface RadiusServerConfig {
  ip: string;
  authPort: number;
  acctPort: number;
  sharedSecret: string;
  timeoutMs: number;
  retransmit: number;
}

export interface StatusCheck {
  intervalMs: number;
  timeoutMs: number;
  answers: number;
}

export interface ProxyRoute {
  realm: string;
  forwardName: string;
  homeServerIp: string;
  homePort: number;
  homeSecret: string;
  timeoutMs: number;
  statusCheck?: StatusCheck;
  radSec?: boolean;
  fallbacks: { homeServerIp: string; homePort: number; homeSecret: string; timeoutMs: number; statusCheck?: StatusCheck; radSec?: boolean }[];
}

export interface RadiusUser {
  username: string;
  password: string;
  verify?: (clear: string) => boolean;
  acceptAny?: boolean;
  loginTime?: string;
  simultaneousUse?: number;
  knownGoodName?: string;
  serviceType?: number;
  replyAttributes?: RadiusAttribute[];
  /** When set, a first Access-Request is always answered Access-Challenge with this prompt before the real accept/reject (RFC 2865 §4.4). */
  challenge?: { prompt: string };
  proxy?: ProxyRoute;
}

export interface RadiusAttributePolicy {
  nasIpAddress: string | null;
  serviceTypeInLoginRequest: boolean;
  serviceTypeMandatory: boolean;
  serviceTypeSupportMultiple: boolean;
  nasIdentifier: ((nasIp: string) => string) | null;
  eventTimestampInAccounting: boolean;
  nowMs?: () => number;
}

export function defaultAttributePolicy(): RadiusAttributePolicy {
  return {
    nasIpAddress: null, serviceTypeInLoginRequest: false, serviceTypeMandatory: false,
    serviceTypeSupportMultiple: false, nasIdentifier: null, eventTimestampInAccounting: false,
  };
}

export interface RadiusClientConfig {
  enabled: boolean;
  servers: RadiusServerConfig[];
  nasIdentifier: string | null;
  sourceInterface: string | null;
}

export interface RadiusServerAgentConfig {
  enabled: boolean;
  port: number;
  acctPort: number;
  sharedSecret: string;
  users: Map<string, RadiusUser>;
  clients: Set<string>;
  requireAuthorizedClient?: boolean;
  rejectReplyMessage?: string | null;
  statusServer?: boolean;
  deniedMessage?: string;
  callerIdInUtmp?: boolean;
}

export function createDefaultClientConfig(): RadiusClientConfig {
  return { enabled: true, servers: [], nasIdentifier: null, sourceInterface: null };
}

export function createDefaultServerConfig(secret = 'shared'): RadiusServerAgentConfig {
  return {
    enabled: true,
    port: UDP_PORT_RADIUS_AUTH,
    acctPort: UDP_PORT_RADIUS_ACCT,
    sharedSecret: secret,
    users: new Map(),
    clients: new Set(),
  };
}

export function defaultServerEntry(ip: string, sharedSecret: string): RadiusServerConfig {
  return {
    ip, authPort: UDP_PORT_RADIUS_AUTH, acctPort: UDP_PORT_RADIUS_ACCT,
    sharedSecret, timeoutMs: 5000, retransmit: 2,
  };
}

export function attr(
  type: RadiusAttrType, value: string | number, vendor?: { id: number; type: number },
): RadiusAttribute {
  return vendor ? { type, value, vendor } : { type, value };
}

/** Find a Vendor-Specific (26) attribute by Vendor-Id + sub-attribute Vendor-Type. */
export function getVsa(pkt: RadiusPacket, vendorId: number, vendorType: number): RadiusAttribute | undefined {
  return pkt.attributes.find(
    (a) => a.type === 'vendor-specific' && a.vendor?.id === vendorId && a.vendor?.type === vendorType,
  );
}

export const EAP_MESSAGE_FRAGMENT_HEX = 253 * 2;

export function eapMessageAttributes(hex: string): RadiusAttribute[] {
  const pieces: RadiusAttribute[] = [];
  for (let at = 0; at === 0 || at < hex.length; at += EAP_MESSAGE_FRAGMENT_HEX) pieces.push({ type: 'eap-message', value: hex.slice(at, at + EAP_MESSAGE_FRAGMENT_HEX) });
  return pieces;
}

export function splitEapMessages(attributes: readonly RadiusAttribute[]): RadiusAttribute[] {
  return attributes.flatMap((attribute) => attribute.type === 'eap-message' && String(attribute.value).length > EAP_MESSAGE_FRAGMENT_HEX ? eapMessageAttributes(String(attribute.value)) : [attribute]);
}

export function eapMessageHex(attributes: readonly RadiusAttribute[]): string | null {
  const pieces = attributes.filter((attribute) => attribute.type === 'eap-message');
  return pieces.length === 0 ? null : pieces.map((piece) => String(piece.value)).join('');
}

export function getAttr(pkt: RadiusPacket, type: RadiusAttrType): RadiusAttribute | undefined {
  return pkt.attributes.find((a) => a.type === type);
}

export function encryptUserPassword(plain: string, secret: string, authenticatorHex: string): string {
  const plainBytes = utf8ToBytes(plain);
  const padded = new Uint8Array(Math.max(16, Math.ceil(plainBytes.length / 16) * 16));
  padded.set(plainBytes);
  const secretBytes = utf8ToBytes(secret);
  let prev = hexToBytes(authenticatorHex);
  const cipher = new Uint8Array(padded.length);
  for (let off = 0; off < padded.length; off += 16) {
    const padInput = new Uint8Array(secretBytes.length + prev.length);
    padInput.set(secretBytes, 0);
    padInput.set(prev, secretBytes.length);
    const pad = md5(padInput);
    const block = new Uint8Array(16);
    for (let i = 0; i < 16; i++) block[i] = padded[off + i] ^ pad[i];
    cipher.set(block, off);
    prev = block;
  }
  return bytesToHex(cipher);
}

export function decryptUserPassword(cipherHex: string, secret: string, authenticatorHex: string): string {
  const cipher = hexToBytes(cipherHex);
  const secretBytes = utf8ToBytes(secret);
  let prev = hexToBytes(authenticatorHex);
  const plain = new Uint8Array(cipher.length);
  for (let off = 0; off < cipher.length; off += 16) {
    const padInput = new Uint8Array(secretBytes.length + prev.length);
    padInput.set(secretBytes, 0);
    padInput.set(prev, secretBytes.length);
    const pad = md5(padInput);
    const block = cipher.subarray(off, off + 16);
    for (let i = 0; i < 16; i++) plain[off + i] = block[i] ^ pad[i];
    prev = block;
  }
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  return bytesToUtf8(plain.subarray(0, end));
}

export function isPrintablePassword(s: string): boolean {
  if (s.length === 0) return true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}
