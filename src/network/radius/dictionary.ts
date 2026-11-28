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
  | 'tagged-string'   // RFC 2868 §3.1: 1 tag byte + UTF-8 string
  | 'ipv6addr'        // RFC 3162 §2.1/§2.4: 16-byte IPv6 address, colon-hex on the JS side
  | 'ipv6prefix'      // RFC 3162 §2.3: 1 reserved byte + 1 prefix-length byte + prefix bytes, "addr/len" on the JS side
  | 'ifid';           // RFC 3162 §2.2: 8-byte interface identifier, "xxxx:xxxx:xxxx:xxxx" on the JS side

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
  'nas-ipv6-address': 'ipv6addr',
  'framed-interface-id': 'ifid',
  'framed-ipv6-prefix': 'ipv6prefix',
  'login-ipv6-host': 'ipv6addr',
  'framed-ipv6-route': 'text',
  'framed-ipv6-pool': 'text',
  'framed-routing': 'integer',
  'framed-compression': 'integer',
  'login-service': 'integer',
  'login-tcp-port': 'integer',
  'callback-id': 'string',
  'framed-route': 'text',
  'port-limit': 'integer',
  'eap-key-name': 'octets',
  'mip6-home-link-prefix': 'octets',
  'framed-management': 'integer',
  'management-transport-protection': 'integer',
  'management-policy-id': 'text',
  'management-privilege-level': 'integer',
  'pkm-ss-cert': 'octets',
  'pkm-ca-cert': 'octets',
  'pkm-config-settings': 'octets',
  'pkm-cryptosuite-list': 'octets',
  'pkm-sa-descriptor': 'octets',
  'pkm-auth-key': 'octets',
  'ds-lite-tunnel-name': 'octets',
  'mobile-node-identifier': 'octets',
  'service-selection': 'text',
  'pmip6-home-lma-ipv6-address': 'ipv6addr',
  'pmip6-visited-lma-ipv6-address': 'ipv6addr',
  'pmip6-home-lma-ipv4-address': 'address',
  'pmip6-visited-lma-ipv4-address': 'address',
  'pmip6-home-hn-prefix': 'ipv6prefix',
  'pmip6-visited-hn-prefix': 'ipv6prefix',
  'pmip6-home-interface-id': 'ifid',
  'pmip6-visited-interface-id': 'ifid',
  'pmip6-home-dhcp4-server-address': 'address',
  'pmip6-visited-dhcp4-server-address': 'address',
  'pmip6-home-dhcp6-server-address': 'ipv6addr',
  'pmip6-visited-dhcp6-server-address': 'ipv6addr',
  'pmip6-home-ipv4-gateway': 'address',
  'pmip6-visited-ipv4-gateway': 'address',
  'eap-lower-layer': 'integer',
  'originating-line-info': 'octets',
  'egress-vlanid': 'integer',
  'ingress-filters': 'integer',
  'egress-vlan-name': 'text',
  'user-priority-table': 'octets',
  'nas-filter-rule': 'text',
  'digest-response': 'text',
  'digest-realm': 'text',
  'digest-nonce': 'text',
  'digest-response-auth': 'text',
  'digest-nextnonce': 'text',
  'digest-method': 'text',
  'digest-uri': 'text',
  'digest-qop': 'text',
  'digest-algorithm': 'text',
  'digest-entity-body-hash': 'text',
  'digest-cnonce': 'text',
  'digest-nonce-count': 'text',
  'digest-username': 'text',
  'digest-opaque': 'text',
  'digest-auth-param': 'text',
  'digest-aka-auts': 'text',
  'digest-domain': 'text',
  'digest-stale': 'text',
  'digest-ha1': 'text',
  'sip-aor': 'text',
  'operator-name': 'text',
  'location-information': 'octets',
  'location-data': 'octets',
  'basic-location-policy-rules': 'octets',
  'extended-location-policy-rules': 'text',
  'location-capable': 'integer',
  'requested-location-info': 'integer',
  'framed-ipv6-address': 'ipv6addr',
  'dns-server-ipv6-address': 'ipv6addr',
  'route-ipv6-information': 'ipv6prefix',
  'delegated-ipv6-prefix-pool': 'text',
  'stateful-ipv6-address-pool': 'text',
  'gss-acceptor-service-name': 'text',
  'gss-acceptor-host-name': 'text',
  'gss-acceptor-service-specifics': 'text',
  'gss-acceptor-realm-name': 'text',
  'allowed-called-station-id': 'text',
  'eap-peer-id': 'octets',
  'eap-server-id': 'octets',
  'mobility-domain-id': 'integer',
  'preauth-timeout': 'integer',
  'network-id-name': 'octets',
  'eapol-announcement': 'octets',
  'wlan-hessid': 'text',
  'wlan-venue-info': 'integer',
  'wlan-venue-language': 'octets',
  'wlan-venue-name': 'text',
  'wlan-reason-code': 'integer',
  'wlan-pairwise-cipher': 'integer',
  'wlan-group-cipher': 'integer',
  'wlan-akm-suite': 'integer',
  'wlan-group-mgmt-cipher': 'integer',
  'wlan-rf-band': 'integer',
  'framed-ipx-network': 'address',
  'login-lat-service': 'text',
  'login-lat-node': 'text',
  'login-lat-group': 'octets',
  'framed-appletalk-link': 'integer',
  'framed-appletalk-network': 'integer',
  'framed-appletalk-zone': 'text',
  'login-lat-port': 'text',
  'acct-multi-session-id': 'text',
  'acct-link-count': 'integer',
  'acct-tunnel-connection': 'text',
  'acct-tunnel-packets-lost': 'integer',
  'tunnel-client-endpoint': 'tagged-string',
  'tunnel-server-endpoint': 'tagged-string',
  'tunnel-assignment-id': 'tagged-string',
  'tunnel-preference': 'tagged-integer',
  'tunnel-client-auth-id': 'tagged-string',
  'tunnel-server-auth-id': 'tagged-string',
  'arap-password': 'octets',
  'arap-features': 'octets',
  'arap-zone-access': 'integer',
  'arap-security': 'integer',
  'arap-security-data': 'text',
  'password-retry': 'integer',
  'prompt': 'integer',
  'connect-info': 'text',
  'configuration-token': 'text',
  'arap-challenge-response': 'octets',
  'acct-interim-interval': 'integer',
  'chargeable-user-identity': 'octets',
  'delegated-ipv6-prefix': 'ipv6prefix',
};

export const RADIUS_EXACT_NAMES: Readonly<Record<string, string>> = {
  'ds-lite-tunnel-name': 'DS-Lite-Tunnel-Name',
  'eap-key-name': 'EAP-Key-Name',
  'eap-lower-layer': 'EAP-Lower-Layer',
  'framed-management': 'Framed-Management',
  'management-policy-id': 'Management-Policy-Id',
  'management-privilege-level': 'Management-Privilege-Level',
  'management-transport-protection': 'Management-Transport-Protection',
  'mip6-home-link-prefix': 'MIP6-Home-Link-Prefix',
  'mobile-node-identifier': 'Mobile-Node-Identifier',
  'originating-line-info': 'Originating-Line-Info',
  'pkm-auth-key': 'PKM-Auth-Key',
  'pkm-ca-cert': 'PKM-CA-Cert',
  'pkm-config-settings': 'PKM-Config-Settings',
  'pkm-cryptosuite-list': 'PKM-Cryptosuite-List',
  'pkm-sa-descriptor': 'PKM-SA-Descriptor',
  'pkm-ss-cert': 'PKM-SS-Cert',
  'pmip6-home-dhcp4-server-address': 'PMIP6-Home-DHCP4-Server-Address',
  'pmip6-home-dhcp6-server-address': 'PMIP6-Home-DHCP6-Server-Address',
  'pmip6-home-hn-prefix': 'PMIP6-Home-HN-Prefix',
  'pmip6-home-interface-id': 'PMIP6-Home-Interface-ID',
  'pmip6-home-ipv4-gateway': 'PMIP6-Home-IPv4-Gateway',
  'pmip6-home-lma-ipv4-address': 'PMIP6-Home-LMA-IPv4-Address',
  'pmip6-home-lma-ipv6-address': 'PMIP6-Home-LMA-IPv6-Address',
  'pmip6-visited-dhcp4-server-address': 'PMIP6-Visited-DHCP4-Server-Address',
  'pmip6-visited-dhcp6-server-address': 'PMIP6-Visited-DHCP6-Server-Address',
  'pmip6-visited-hn-prefix': 'PMIP6-Visited-HN-Prefix',
  'pmip6-visited-interface-id': 'PMIP6-Visited-Interface-ID',
  'pmip6-visited-ipv4-gateway': 'PMIP6-Visited-IPv4-Gateway',
  'pmip6-visited-lma-ipv4-address': 'PMIP6-Visited-LMA-IPv4-Address',
  'pmip6-visited-lma-ipv6-address': 'PMIP6-Visited-LMA-IPv6-Address',
  'service-selection': 'Service-Selection',
  'acct-interim-interval': 'Acct-Interim-Interval',
  'acct-link-count': 'Acct-Link-Count',
  'acct-multi-session-id': 'Acct-Multi-Session-Id',
  'acct-tunnel-connection': 'Acct-Tunnel-Connection',
  'acct-tunnel-packets-lost': 'Acct-Tunnel-Packets-Lost',
  'allowed-called-station-id': 'Allowed-Called-Station-Id',
  'arap-challenge-response': 'ARAP-Challenge-Response',
  'arap-features': 'ARAP-Features',
  'arap-password': 'ARAP-Password',
  'arap-security': 'ARAP-Security',
  'arap-security-data': 'ARAP-Security-Data',
  'arap-zone-access': 'ARAP-Zone-Access',
  'basic-location-policy-rules': 'Basic-Location-Policy-Rules',
  'chargeable-user-identity': 'Chargeable-User-Identity',
  'configuration-token': 'Configuration-Token',
  'connect-info': 'Connect-Info',
  'delegated-ipv6-prefix': 'Delegated-IPv6-Prefix',
  'delegated-ipv6-prefix-pool': 'Delegated-IPv6-Prefix-Pool',
  'digest-aka-auts': 'Digest-AKA-Auts',
  'digest-algorithm': 'Digest-Algorithm',
  'digest-auth-param': 'Digest-Auth-Param',
  'digest-cnonce': 'Digest-CNonce',
  'digest-domain': 'Digest-Domain',
  'digest-entity-body-hash': 'Digest-Entity-Body-Hash',
  'digest-ha1': 'Digest-HA1',
  'digest-method': 'Digest-Method',
  'digest-nextnonce': 'Digest-Nextnonce',
  'digest-nonce': 'Digest-Nonce',
  'digest-nonce-count': 'Digest-Nonce-Count',
  'digest-opaque': 'Digest-Opaque',
  'digest-qop': 'Digest-Qop',
  'digest-realm': 'Digest-Realm',
  'digest-response': 'Digest-Response',
  'digest-response-auth': 'Digest-Response-Auth',
  'digest-stale': 'Digest-Stale',
  'digest-uri': 'Digest-URI',
  'digest-username': 'Digest-Username',
  'dns-server-ipv6-address': 'DNS-Server-IPv6-Address',
  'eap-peer-id': 'EAP-Peer-Id',
  'eap-server-id': 'EAP-Server-Id',
  'eapol-announcement': 'EAPoL-Announcement',
  'egress-vlan-name': 'Egress-VLAN-Name',
  'egress-vlanid': 'Egress-VLANID',
  'extended-location-policy-rules': 'Extended-Location-Policy-Rules',
  'framed-appletalk-link': 'Framed-AppleTalk-Link',
  'framed-appletalk-network': 'Framed-AppleTalk-Network',
  'framed-appletalk-zone': 'Framed-AppleTalk-Zone',
  'framed-ipv6-address': 'Framed-IPv6-Address',
  'framed-ipx-network': 'Framed-IPX-Network',
  'gss-acceptor-host-name': 'GSS-Acceptor-Host-Name',
  'gss-acceptor-realm-name': 'GSS-Acceptor-Realm-Name',
  'gss-acceptor-service-name': 'GSS-Acceptor-Service-Name',
  'gss-acceptor-service-specifics': 'GSS-Acceptor-Service-Specifics',
  'ingress-filters': 'Ingress-Filters',
  'location-capable': 'Location-Capable',
  'location-data': 'Location-Data',
  'location-information': 'Location-Information',
  'login-lat-group': 'Login-LAT-Group',
  'login-lat-node': 'Login-LAT-Node',
  'login-lat-port': 'Login-LAT-Port',
  'login-lat-service': 'Login-LAT-Service',
  'mobility-domain-id': 'Mobility-Domain-Id',
  'nas-filter-rule': 'NAS-Filter-Rule',
  'network-id-name': 'Network-Id-Name',
  'operator-name': 'Operator-Name',
  'password-retry': 'Password-Retry',
  'preauth-timeout': 'Preauth-Timeout',
  'prompt': 'Prompt',
  'requested-location-info': 'Requested-Location-Info',
  'route-ipv6-information': 'Route-IPv6-Information',
  'sip-aor': 'SIP-AOR',
  'stateful-ipv6-address-pool': 'Stateful-IPv6-Address-Pool',
  'tunnel-assignment-id': 'Tunnel-Assignment-Id',
  'tunnel-client-auth-id': 'Tunnel-Client-Auth-Id',
  'tunnel-client-endpoint': 'Tunnel-Client-Endpoint',
  'tunnel-preference': 'Tunnel-Preference',
  'tunnel-server-auth-id': 'Tunnel-Server-Auth-Id',
  'tunnel-server-endpoint': 'Tunnel-Server-Endpoint',
  'user-priority-table': 'User-Priority-Table',
  'wlan-akm-suite': 'WLAN-AKM-Suite',
  'wlan-group-cipher': 'WLAN-Group-Cipher',
  'wlan-group-mgmt-cipher': 'WLAN-Group-Mgmt-Cipher',
  'wlan-hessid': 'WLAN-HESSID',
  'wlan-pairwise-cipher': 'WLAN-Pairwise-Cipher',
  'wlan-reason-code': 'WLAN-Reason-Code',
  'wlan-rf-band': 'WLAN-RF-Band',
  'wlan-venue-info': 'WLAN-Venue-Info',
  'wlan-venue-language': 'WLAN-Venue-Language',
  'wlan-venue-name': 'WLAN-Venue-Name',
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
export const FREERADIUS_VENDOR_ID = 11344;

export interface RadiusVsaDef {
  vendorId: number;
  vendorType: number;
  name: string;
  displayName: string;
  valueType: RadiusValueType;
  valueNames?: Readonly<Record<string, number>>;
}

/**
 * Known Vendor-Specific sub-attributes. Not exhaustive — covers what the
 * simulator's Cisco/Huawei AAA integration and the planned MS-CHAP path need.
 */
function freeradiusCounter(vendorType: number, displayName: string, valueNames?: Readonly<Record<string, number>>): RadiusVsaDef {
  return { vendorId: FREERADIUS_VENDOR_ID, vendorType, name: displayName.toLowerCase(), displayName, valueType: 'integer', ...(valueNames === undefined ? {} : { valueNames }) };
}

export type FreeradiusCounter = readonly [type: number, displayName: string, field: 'requests' | 'responses' | 'accepts' | 'rejects' | 'challenges' | 'dup' | 'malformed' | 'badAuthenticator' | 'dropped' | 'unknownTypes' | 'conflicts'];

export const FREERADIUS_AUTH_COUNTERS: readonly FreeradiusCounter[] = [
  [128, 'FreeRADIUS-Total-Access-Requests', 'requests'], [129, 'FreeRADIUS-Total-Access-Accepts', 'accepts'], [130, 'FreeRADIUS-Total-Access-Rejects', 'rejects'],
  [131, 'FreeRADIUS-Total-Access-Challenges', 'challenges'], [132, 'FreeRADIUS-Total-Auth-Responses', 'responses'], [133, 'FreeRADIUS-Total-Auth-Duplicate-Requests', 'dup'],
  [134, 'FreeRADIUS-Total-Auth-Malformed-Requests', 'malformed'], [135, 'FreeRADIUS-Total-Auth-Invalid-Requests', 'badAuthenticator'],
  [136, 'FreeRADIUS-Total-Auth-Dropped-Requests', 'dropped'], [137, 'FreeRADIUS-Total-Auth-Unknown-Types', 'unknownTypes'], [191, 'FreeRADIUS-Total-Auth-Conflicts', 'conflicts'],
];

export const FREERADIUS_ACCT_COUNTERS: readonly FreeradiusCounter[] = [
  [148, 'FreeRADIUS-Total-Accounting-Requests', 'requests'], [149, 'FreeRADIUS-Total-Accounting-Responses', 'responses'], [150, 'FreeRADIUS-Total-Acct-Duplicate-Requests', 'dup'],
  [151, 'FreeRADIUS-Total-Acct-Malformed-Requests', 'malformed'], [152, 'FreeRADIUS-Total-Acct-Invalid-Requests', 'badAuthenticator'],
  [153, 'FreeRADIUS-Total-Acct-Dropped-Requests', 'dropped'], [154, 'FreeRADIUS-Total-Acct-Unknown-Types', 'unknownTypes'], [192, 'FreeRADIUS-Total-Acct-Conflicts', 'conflicts'],
];

export const FREERADIUS_PROXY_AUTH_COUNTERS: readonly FreeradiusCounter[] = [
  [138, 'FreeRADIUS-Total-Proxy-Access-Requests', 'requests'], [139, 'FreeRADIUS-Total-Proxy-Access-Accepts', 'accepts'], [140, 'FreeRADIUS-Total-Proxy-Access-Rejects', 'rejects'],
  [141, 'FreeRADIUS-Total-Proxy-Access-Challenges', 'challenges'], [142, 'FreeRADIUS-Total-Proxy-Auth-Responses', 'responses'], [143, 'FreeRADIUS-Total-Proxy-Auth-Duplicate-Requests', 'dup'],
  [144, 'FreeRADIUS-Total-Proxy-Auth-Malformed-Requests', 'malformed'], [145, 'FreeRADIUS-Total-Proxy-Auth-Invalid-Requests', 'badAuthenticator'],
  [146, 'FreeRADIUS-Total-Proxy-Auth-Dropped-Requests', 'dropped'], [147, 'FreeRADIUS-Total-Proxy-Auth-Unknown-Types', 'unknownTypes'],
];

export const FREERADIUS_PROXY_ACCT_COUNTERS: readonly FreeradiusCounter[] = [
  [155, 'FreeRADIUS-Total-Proxy-Accounting-Requests', 'requests'], [156, 'FreeRADIUS-Total-Proxy-Accounting-Responses', 'responses'], [157, 'FreeRADIUS-Total-Proxy-Acct-Duplicate-Requests', 'dup'],
  [158, 'FreeRADIUS-Total-Proxy-Acct-Malformed-Requests', 'malformed'], [159, 'FreeRADIUS-Total-Proxy-Acct-Invalid-Requests', 'badAuthenticator'],
  [160, 'FreeRADIUS-Total-Proxy-Acct-Dropped-Requests', 'dropped'], [161, 'FreeRADIUS-Total-Proxy-Acct-Unknown-Types', 'unknownTypes'],
];

export const FREERADIUS_INTERNAL_COUNTERS: readonly (readonly [type: number, displayName: string, valueType: RadiusValueType])[] = [
  [176, 'FreeRADIUS-Stats-Start-Time', 'time'], [177, 'FreeRADIUS-Stats-HUP-Time', 'time'],
  [162, 'FreeRADIUS-Queue-Len-Internal', 'integer'], [163, 'FreeRADIUS-Queue-Len-Proxy', 'integer'], [164, 'FreeRADIUS-Queue-Len-Auth', 'integer'],
  [165, 'FreeRADIUS-Queue-Len-Acct', 'integer'], [166, 'FreeRADIUS-Queue-Len-Detail', 'integer'],
  [181, 'FreeRADIUS-Queue-PPS-In', 'integer'], [182, 'FreeRADIUS-Queue-PPS-Out', 'integer'],
  [193, 'FreeRADIUS-Stats-Threads-Active', 'integer'], [194, 'FreeRADIUS-Stats-Threads-Total', 'integer'], [195, 'FreeRADIUS-Stats-Threads-Max', 'integer'],
];

export const FREERADIUS_STATS_CLIENT_ADDRESS = 167;
export const FREERADIUS_STATS_ERROR = 187;
export const FREERADIUS_STATS_CLIENT_NUMBER = 168;
export const FREERADIUS_STATS_CLIENT_NETMASK = 169;
export const FREERADIUS_STATS_SERVER_ADDRESS = 170;
export const FREERADIUS_STATS_SERVER_PORT = 171;
export const FREERADIUS_STATS_SERVER_OUTSTANDING = 172;
export const FREERADIUS_STATS_SERVER_STATE = 173;

export const RADIUS_VSA_DICTIONARY: readonly RadiusVsaDef[] = [
  // Cisco (vendor 9): the single catch-all AV-pair sub-attribute (type 1),
  // e.g. "shell:priv-lvl=15" for privilege-level authorization.
  { vendorId: CISCO_VENDOR_ID, vendorType: 1, name: 'cisco-avpair', displayName: 'Cisco-AVPair', valueType: 'text' },
  // Microsoft (vendor 311, RFC 2548).
  { vendorId: MICROSOFT_VENDOR_ID, vendorType: 1, name: 'ms-chap-response', displayName: 'MS-CHAP-Response', valueType: 'octets' },
  { vendorId: MICROSOFT_VENDOR_ID, vendorType: 11, name: 'ms-chap-challenge', displayName: 'MS-CHAP-Challenge', valueType: 'octets' },
  { vendorId: MICROSOFT_VENDOR_ID, vendorType: 16, name: 'ms-mppe-send-key', displayName: 'MS-MPPE-Send-Key', valueType: 'octets' },
  { vendorId: MICROSOFT_VENDOR_ID, vendorType: 17, name: 'ms-mppe-recv-key', displayName: 'MS-MPPE-Recv-Key', valueType: 'octets' },
  { vendorId: MICROSOFT_VENDOR_ID, vendorType: 25, name: 'ms-chap2-response', displayName: 'MS-CHAP2-Response', valueType: 'octets' },
  { vendorId: MICROSOFT_VENDOR_ID, vendorType: 26, name: 'ms-chap2-success', displayName: 'MS-CHAP2-Success', valueType: 'octets' },
  freeradiusCounter(127, 'FreeRADIUS-Statistics-Type', {
    'none': 0, 'authentication': 1, 'accounting': 2, 'proxy-authentication': 4, 'proxy-accounting': 8, 'internal': 0x10, 'client': 0x20,
    'server': 0x40, 'home-server': 0x80, 'auth-acct': 0x03, 'proxy-auth-acct': 0x0c, 'all': 0x1f,
  }),
  ...FREERADIUS_AUTH_COUNTERS.map(([type, name]) => freeradiusCounter(type, name)),
  ...FREERADIUS_ACCT_COUNTERS.map(([type, name]) => freeradiusCounter(type, name)),
  ...FREERADIUS_PROXY_AUTH_COUNTERS.map(([type, name]) => freeradiusCounter(type, name)),
  ...FREERADIUS_PROXY_ACCT_COUNTERS.map(([type, name]) => freeradiusCounter(type, name)),
  { vendorId: FREERADIUS_VENDOR_ID, vendorType: FREERADIUS_STATS_CLIENT_ADDRESS, name: 'freeradius-stats-client-ip-address', displayName: 'FreeRADIUS-Stats-Client-IP-Address', valueType: 'address' },
  { vendorId: FREERADIUS_VENDOR_ID, vendorType: FREERADIUS_STATS_SERVER_ADDRESS, name: 'freeradius-stats-server-ip-address', displayName: 'FreeRADIUS-Stats-Server-IP-Address', valueType: 'address' },
  freeradiusCounter(FREERADIUS_STATS_CLIENT_NUMBER, 'FreeRADIUS-Stats-Client-Number'),
  freeradiusCounter(FREERADIUS_STATS_CLIENT_NETMASK, 'FreeRADIUS-Stats-Client-Netmask'),
  freeradiusCounter(FREERADIUS_STATS_SERVER_PORT, 'FreeRADIUS-Stats-Server-Port'),
  freeradiusCounter(FREERADIUS_STATS_SERVER_OUTSTANDING, 'FreeRADIUS-Stats-Server-Outstanding-Requests'),
  freeradiusCounter(FREERADIUS_STATS_SERVER_STATE, 'FreeRADIUS-Stats-Server-State', { 'alive': 0, 'zombie': 1, 'dead': 2, 'idle': 3, 'admin-down': 4, 'connection-fail': 5 }),
  { vendorId: FREERADIUS_VENDOR_ID, vendorType: FREERADIUS_STATS_ERROR, name: 'freeradius-stats-error', displayName: 'FreeRADIUS-Stats-Error', valueType: 'text' },
  ...FREERADIUS_INTERNAL_COUNTERS.map(([type, name, valueType]) => ({ ...freeradiusCounter(type, name), valueType })),
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

export const RADIUS_VALUE_NAMES: Readonly<Partial<Record<RadiusAttrType, Readonly<Record<string, number>>>>> = {
  'service-type': {
    'login-user': 1, 'framed-user': 2, 'callback-login-user': 3, 'callback-framed-user': 4, 'outbound-user': 5,
    'administrative-user': 6, 'nas-prompt-user': 7, 'authenticate-only': 8, 'callback-nas-prompt': 9,
    'call-check': 10, 'callback-administrative': 11,
  },
  'framed-protocol': { 'ppp': 1, 'slip': 2, 'arap': 3, 'gandalf-slml': 4, 'xylogics-ipx-slip': 5, 'x.75-synchronous': 6 },
  'framed-routing': { 'none': 0, 'broadcast': 1, 'listen': 2, 'broadcast-listen': 3 },
  'framed-compression': { 'none': 0, 'van-jacobson-tcp-ip': 1, 'ipx-header-compression': 2, 'stac-lzs': 3 },
  'login-service': { 'telnet': 0, 'rlogin': 1, 'tcp-clear': 2, 'portmaster': 3, 'lat': 4, 'x25-pad': 5, 'x25-t3pos': 6, 'tcp-clear-quiet': 8 },
  'termination-action': { 'default': 0, 'radius-request': 1 },
  'error-cause': {
    'residual-context-removed': 201, 'invalid-eap-packet': 202, 'unsupported-attribute': 401, 'missing-attribute': 402,
    'nas-identification-mismatch': 403, 'invalid-request': 404, 'unsupported-service': 405, 'unsupported-extension': 406,
    'invalid-attribute-value': 407, 'administratively-prohibited': 501, 'proxy-request-not-routable': 502,
    'session-context-not-found': 503, 'session-context-not-removable': 504, 'proxy-processing-error': 505,
    'resources-unavailable': 506, 'request-initiated': 507, 'multiple-session-selection-unsupported': 508,
  },
  'acct-status-type': { 'start': 1, 'stop': 2, 'alive': 3, 'interim-update': 3, 'accounting-on': 7, 'accounting-off': 8, 'failed': 15 },
  'acct-authentic': { 'radius': 1, 'local': 2, 'remote': 3, 'diameter': 4 },
  'acct-terminate-cause': {
    'user-request': 1, 'lost-carrier': 2, 'lost-service': 3, 'idle-timeout': 4, 'session-timeout': 5, 'admin-reset': 6,
    'admin-reboot': 7, 'port-error': 8, 'nas-error': 9, 'nas-request': 10, 'nas-reboot': 11, 'port-unneeded': 12,
    'port-preempted': 13, 'port-suspended': 14, 'service-unavailable': 15, 'callback': 16, 'user-error': 17, 'host-request': 18,
  },
  'nas-port-type': {
    'async': 0, 'sync': 1, 'isdn': 2, 'isdn-v120': 3, 'isdn-v110': 4, 'virtual': 5, 'piafs': 6, 'hdlc-clear-channel': 7,
    'x.25': 8, 'x.75': 9, 'g.3-fax': 10, 'sdsl': 11, 'adsl-cap': 12, 'adsl-dmt': 13, 'idsl': 14, 'ethernet': 15,
    'xdsl': 16, 'cable': 17, 'wireless-other': 18, 'wireless-802.11': 19,
  },
  'tunnel-type': {
    'pptp': 1, 'l2f': 2, 'l2tp': 3, 'atmp': 4, 'vtp': 5, 'ah': 6, 'ip': 7, 'min-ip': 8, 'esp': 9, 'gre': 10, 'dvs': 11,
    'ip-in-ip': 12, 'vlan': 13,
  },
  'tunnel-medium-type': {
    'ip': 1, 'ipv4': 1, 'ipv6': 2, 'nsap': 3, 'hdlc': 4, 'bbn-1822': 5, 'ieee-802': 6, 'e.163': 7, 'e.164': 8, 'f.69': 9,
    'x.121': 10, 'ipx': 11, 'appletalk': 12, 'decnet-iv': 13, 'banyan-vines': 14, 'e.164-nsap': 15,
  },
};

export function canonicalValueName(type: RadiusAttrType, value: number): string | undefined {
  const names = Object.entries(RADIUS_VALUE_NAMES[type] ?? {}).filter(([, number]) => number === value);
  return names[names.length - 1]?.[0];
}
