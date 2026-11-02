import {
  LLDP_CAPABILITY_BIT, LLDP_CHASSIS_ID_SUBTYPE, LLDP_MANAGEMENT_ADDRESS_FAMILY, LLDP_PORT_ID_SUBTYPE,
  LLDP_INTERFACE_NUMBERING_SUBTYPE, type LldpFrame,
} from './types';

const TLV_END = 0;
const TLV_CHASSIS_ID = 1;
const TLV_PORT_ID = 2;
const TLV_TTL = 3;
const TLV_PORT_DESCRIPTION = 4;
const TLV_SYSTEM_NAME = 5;
const TLV_SYSTEM_DESCRIPTION = 6;
const TLV_SYSTEM_CAPABILITIES = 7;
const TLV_MANAGEMENT_ADDRESS = 8;
const TLV_ORGANIZATION_SPECIFIC = 127;
const OUI_IEEE_8021 = [0x00, 0x80, 0xc2];
const OUI_IEEE_8023 = [0x00, 0x12, 0x0f];
const SUBTYPE_8021_PORT_VLAN_ID = 1;
const SUBTYPE_8021_VLAN_NAME = 3;
const SUBTYPE_8023_MAC_PHY = 1;
const SUBTYPE_8023_MAX_FRAME_SIZE = 4;
const AUTONEGOTIATION_SUPPORTED = 0x01;
const AUTONEGOTIATION_ENABLED = 0x02;
const MAX_VLAN_NAME_BYTES = 32;
const IPV4_BYTES = 4;
const IPV6_BYTES = 16;

function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function text(value: string): number[] {
  return Array.from(new TextEncoder().encode(value));
}

function tlv(type: number, value: readonly number[]): number[] {
  return [...u16(((type & 0x7f) << 9) | (value.length & 0x1ff)), ...value];
}

function macBytes(mac: string): number[] {
  return mac.split(':').map((part) => parseInt(part, 16) & 0xff);
}

function ipv4Bytes(address: string): number[] {
  return address.split('.').map((part) => parseInt(part, 10) & 0xff).slice(0, IPV4_BYTES);
}

function ipv6Bytes(address: string): number[] {
  const [head, tail] = address.includes('::') ? address.split('::') : [address, ''];
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const groups = [...left, ...new Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return groups.flatMap((group) => u16(parseInt(group, 16) & 0xffff)).slice(0, IPV6_BYTES);
}

function identifier(subtype: number, value: string, isMac: boolean): number[] {
  return [subtype, ...(isMac ? macBytes(value) : text(value))];
}

function organizationSpecific(oui: readonly number[], subtype: number, value: readonly number[]): number[] {
  return tlv(TLV_ORGANIZATION_SPECIFIC, [...oui, subtype, ...value]);
}

export function lldpPayloadBytes(frame: LldpFrame): number[] {
  const bytes: number[] = [
    ...tlv(TLV_CHASSIS_ID, identifier(LLDP_CHASSIS_ID_SUBTYPE[frame.chassisIdSubtype], frame.chassisId, frame.chassisIdSubtype === 'macAddress')),
    ...tlv(TLV_PORT_ID, identifier(LLDP_PORT_ID_SUBTYPE[frame.portIdSubtype], frame.portId, frame.portIdSubtype === 'macAddress')),
    ...tlv(TLV_TTL, u16(frame.ttlSec)),
  ];
  if (frame.portDescription !== undefined) bytes.push(...tlv(TLV_PORT_DESCRIPTION, text(frame.portDescription)));
  if (frame.systemName !== undefined) bytes.push(...tlv(TLV_SYSTEM_NAME, text(frame.systemName)));
  if (frame.systemDescription !== undefined) bytes.push(...tlv(TLV_SYSTEM_DESCRIPTION, text(frame.systemDescription)));
  if (frame.capabilities !== undefined) {
    const bits = frame.capabilities.reduce((all, capability) => all | LLDP_CAPABILITY_BIT[capability], 0);
    bytes.push(...tlv(TLV_SYSTEM_CAPABILITIES, [...u16(bits), ...u16(bits)]));
  }
  for (const entry of frame.managementAddresses ?? []) {
    const family = LLDP_MANAGEMENT_ADDRESS_FAMILY[entry.family];
    const address = entry.family === 'ipv6' ? ipv6Bytes(entry.address.toString()) : ipv4Bytes(entry.address.toString());
    bytes.push(...tlv(TLV_MANAGEMENT_ADDRESS, [
      1 + address.length, family, ...address,
      LLDP_INTERFACE_NUMBERING_SUBTYPE[entry.numbering], ...u32(entry.interfaceNumber), 0,
    ]));
  }
  if (frame.portVlanId !== undefined) {
    bytes.push(...organizationSpecific(OUI_IEEE_8021, SUBTYPE_8021_PORT_VLAN_ID, u16(frame.portVlanId)));
  }
  for (const vlan of frame.vlanNames ?? []) {
    const name = text(vlan.name).slice(0, MAX_VLAN_NAME_BYTES);
    bytes.push(...organizationSpecific(OUI_IEEE_8021, SUBTYPE_8021_VLAN_NAME, [...u16(vlan.id), name.length, ...name]));
  }
  if (frame.autoNegotiation !== undefined) {
    const flags = (frame.autoNegotiation.supported ? AUTONEGOTIATION_SUPPORTED : 0)
      | (frame.autoNegotiation.enabled ? AUTONEGOTIATION_ENABLED : 0);
    bytes.push(...organizationSpecific(OUI_IEEE_8023, SUBTYPE_8023_MAC_PHY, [flags, ...u16(0), ...u16(0)]));
  }
  if (frame.maxFrameSize !== undefined) {
    bytes.push(...organizationSpecific(OUI_IEEE_8023, SUBTYPE_8023_MAX_FRAME_SIZE, u16(frame.maxFrameSize)));
  }
  bytes.push(...tlv(TLV_END, []));
  return bytes;
}
