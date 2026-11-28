import type { RadiusAttribute } from './types';
import { RADIUS_DICTIONARY, RADIUS_VALUE_NAMES, lookupVsa, type RadiusValueType } from './dictionary';

const UPPERCASE_WORDS = new Set(['nas', 'ip', 'chap', 'eap', 'mtu', 'tcp']);

export function radiusAttributeDisplayName(attribute: RadiusAttribute): string {
  if (attribute.type === 'vendor-specific' && attribute.vendor) {
    return lookupVsa(attribute.vendor.id, attribute.vendor.type)?.displayName ?? `Vendor-Specific(${attribute.vendor.id}:${attribute.vendor.type})`;
  }
  return attribute.type.split('-').map((word) => {
    if (word === 'ipv6') return 'IPv6';
    if (UPPERCASE_WORDS.has(word)) return word.toUpperCase();
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join('-');
}

const NAMED_CASE: Record<string, string> = {
  ppp: 'PPP', slip: 'SLIP', arap: 'ARAP', vlan: 'VLAN', pptp: 'PPTP', l2tp: 'L2TP', gre: 'GRE', esp: 'ESP', ah: 'AH',
  ip: 'IP', ipv4: 'IPv4', ipv6: 'IPv6', 'ieee-802': 'IEEE-802', isdn: 'ISDN', sdsl: 'SDSL', xdsl: 'xDSL', idsl: 'IDSL',
  'wireless-802.11': 'Wireless-802.11', 'tcp-clear': 'TCP-Clear', 'tcp-clear-quiet': 'TCP-Clear-Quiet', 'nas-prompt-user': 'NAS-Prompt-User',
  'callback-nas-prompt': 'Callback-NAS-Prompt', 'radius-request': 'RADIUS-Request', 'van-jacobson-tcp-ip': 'Van-Jacobson-TCP-IP',
  'min-ip': 'MIN-IP', 'ip-in-ip': 'IP-in-IP', 'radius': 'RADIUS', 'residual-context-removed': 'Residual-Context-Removed', 'invalid-eap-packet': 'Invalid-EAP-Packet', 'nas-identification-mismatch': 'NAS-Identification-Mismatch', 'nas-error': 'NAS-Error', 'nas-request': 'NAS-Request', 'nas-reboot': 'NAS-Reboot',
};

export function formatRadiusAttributeValue(attribute: RadiusAttribute): string {
  const vsa = attribute.type === 'vendor-specific' && attribute.vendor ? lookupVsa(attribute.vendor.id, attribute.vendor.type) : undefined;
  const valueType: RadiusValueType = attribute.type === 'vendor-specific' ? vsa?.valueType ?? 'octets' : RADIUS_DICTIONARY[attribute.type].valueType;
  const raw = String(attribute.value);
  if (valueType === 'octets') return `0x${raw}`;
  if (valueType === 'time') {
    const date = new Date(Number(attribute.value) * 1000);
    const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `"${month} ${pad(date.getUTCDate())} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC"`;
  }
  if (valueType === 'text' || valueType === 'string' || valueType === 'tagged-string') return `"${raw}"`;
  if (valueType === 'integer' || valueType === 'tagged-integer') {
    if (vsa?.valueNames !== undefined) {
      const known = Object.keys(vsa.valueNames).find((name) => vsa.valueNames?.[name] === Number(attribute.value));
      if (known !== undefined) return known.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('-');
    }
    const names = RADIUS_VALUE_NAMES[attribute.type];
    const key = names ? Object.keys(names).find((name) => names[name] === Number(attribute.value)) : undefined;
    if (key !== undefined) return NAMED_CASE[key] ?? key.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('-');
  }
  return raw;
}

export function formatRadiusAttribute(attribute: RadiusAttribute): string {
  return `${radiusAttributeDisplayName(attribute)} = ${formatRadiusAttributeValue(attribute)}`;
}
