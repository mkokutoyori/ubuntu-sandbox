/**
 * RADIUS attribute dictionary — value types for the standard attributes
 * (RFC 2865 §5, RFC 2866 §5, RFC 2868, RFC 2869) plus the Vendor-Specific
 * (26) sub-attributes the simulator recognises (RFC 2865 §5.26, RFC 2548).
 *
 * `codec.ts` consumes this to know how to serialise/parse each attribute's
 * value on the wire — it has no attribute-specific logic of its own.
 */
import { RADIUS_ATTR, type RadiusAttrType } from './types';

export type RadiusValueType =
  | 'text'            // UTF-8 string (RFC 2865 §5.1: "text" — printable, no length prefix)
  | 'string'          // opaque octets carried as a JS string (User-Password ciphertext, …)
  | 'address'         // 4-byte IPv4 address, dotted-decimal on the JS side
  | 'integer'         // 4-byte unsigned big-endian integer
  | 'time'            // 4-byte unsigned big-endian, seconds since 1970-01-01 (RFC 2865 §5.55)
  | 'octets'          // raw bytes, hex-encoded on the JS side
  | 'tagged-integer'  // RFC 2868 §3.1: 1 tag byte (0x00 or 0x01-0x1F) + 3-byte integer
  | 'tagged-string';  // RFC 2868 §3.1: 1 tag byte + UTF-8 string

export interface RadiusAttrDef {
  type: number;
  name: RadiusAttrType;
  valueType: RadiusValueType;
}

const VALUE_TYPE_BY_NAME: Record<RadiusAttrType, RadiusValueType> = {
  'user-name': 'text',
  'user-password': 'string',
  'chap-password': 'octets',
  'nas-ip-address': 'address',
  'nas-port': 'integer',
  'service-type': 'integer',
  'framed-protocol': 'integer',
  'framed-ip-address': 'address',
  'framed-ip-netmask': 'address',
  'framed-mtu': 'integer',
  'filter-id': 'text',
  'login-ip-host': 'address',
  'reply-message': 'text',
  'callback-number': 'string',
  'state': 'octets',
  'class': 'octets',
  'vendor-specific': 'octets',
  'session-timeout': 'integer',
  'idle-timeout': 'integer',
  'termination-action': 'integer',
  'called-station-id': 'text',
  'calling-station-id': 'text',
  'nas-identifier': 'text',
  'proxy-state': 'octets',
  'acct-status-type': 'integer',
  'acct-delay-time': 'integer',
  'acct-input-octets': 'integer',
  'acct-output-octets': 'integer',
  'acct-session-id': 'text',
  'acct-authentic': 'integer',
  'acct-session-time': 'integer',
  'acct-input-packets': 'integer',
  'acct-output-packets': 'integer',
  'acct-terminate-cause': 'integer',
  'acct-input-gigawords': 'integer',
  'acct-output-gigawords': 'integer',
  'event-timestamp': 'time',
  'chap-challenge': 'octets',
  'nas-port-type': 'integer',
  'tunnel-type': 'tagged-integer',
  'tunnel-medium-type': 'tagged-integer',
  'eap-message': 'octets',
  'message-authenticator': 'octets',
  'tunnel-private-group-id': 'tagged-string',
  'nas-port-id': 'text',
  'framed-pool': 'text',
  'error-cause': 'integer',
};

/** Dictionary entry per standard attribute, keyed by name. */
export const RADIUS_DICTIONARY: Record<RadiusAttrType, RadiusAttrDef> = Object.fromEntries(
  (Object.keys(RADIUS_ATTR) as RadiusAttrType[]).map((name) => [
    name,
    { type: RADIUS_ATTR[name], name, valueType: VALUE_TYPE_BY_NAME[name] },
  ]),
) as Record<RadiusAttrType, RadiusAttrDef>;

/** Reverse lookup used by the decoder: wire attribute number → dictionary entry. */
export const RADIUS_DICTIONARY_BY_TYPE: ReadonlyMap<number, RadiusAttrDef> = new Map(
  Object.values(RADIUS_DICTIONARY).map((def) => [def.type, def]),
);

// ─── Vendor-Specific (26) sub-dictionary ────────────────────────────

export const CISCO_VENDOR_ID = 9;
export const MICROSOFT_VENDOR_ID = 311;

export interface RadiusVsaDef {
  vendorId: number;
  vendorType: number;
  name: string;
  valueType: RadiusValueType;
}

/**
 * Known Vendor-Specific sub-attributes. Not exhaustive — covers what the
 * simulator's Cisco/Huawei AAA integration and the planned MS-CHAP path need.
 */
export const RADIUS_VSA_DICTIONARY: readonly RadiusVsaDef[] = [
  // Cisco (vendor 9): the single catch-all AV-pair sub-attribute (type 1),
  // e.g. "shell:priv-lvl=15" for privilege-level authorization.
  { vendorId: CISCO_VENDOR_ID, vendorType: 1, name: 'cisco-avpair', valueType: 'text' },
  // Microsoft (vendor 311, RFC 2548).
  { vendorId: MICROSOFT_VENDOR_ID, vendorType: 1, name: 'ms-chap-response', valueType: 'octets' },
  { vendorId: MICROSOFT_VENDOR_ID, vendorType: 11, name: 'ms-chap-challenge', valueType: 'octets' },
  { vendorId: MICROSOFT_VENDOR_ID, vendorType: 16, name: 'ms-mppe-send-key', valueType: 'octets' },
  { vendorId: MICROSOFT_VENDOR_ID, vendorType: 17, name: 'ms-mppe-recv-key', valueType: 'octets' },
  { vendorId: MICROSOFT_VENDOR_ID, vendorType: 25, name: 'ms-chap2-response', valueType: 'octets' },
  { vendorId: MICROSOFT_VENDOR_ID, vendorType: 26, name: 'ms-chap2-success', valueType: 'octets' },
];

const VSA_BY_VENDOR_AND_TYPE = new Map<string, RadiusVsaDef>(
  RADIUS_VSA_DICTIONARY.map((d) => [`${d.vendorId}:${d.vendorType}`, d]),
);
const VSA_BY_NAME = new Map<string, RadiusVsaDef>(RADIUS_VSA_DICTIONARY.map((d) => [d.name, d]));

export function lookupVsa(vendorId: number, vendorType: number): RadiusVsaDef | undefined {
  return VSA_BY_VENDOR_AND_TYPE.get(`${vendorId}:${vendorType}`);
}

export function lookupVsaByName(name: string): RadiusVsaDef | undefined {
  return VSA_BY_NAME.get(name);
}
