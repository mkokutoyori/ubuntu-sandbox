import type { VtpFrame, VtpVlanEntry } from './types';
import { VTP_DOMAIN_FIELD_BYTES } from './types';

const CODE: Readonly<Record<VtpFrame['messageType'], number>> = { summary: 1, subset: 2, request: 3, join: 4 };
const TIMESTAMP_BYTES = 12;
const DIGEST_BYTES = 16;
const VLAN_INFO_FIXED_BYTES = 12;
const ETHERNET_VLAN_TYPE = 1;
const OPERATIONAL = 0;
const SAID_BASE = 100000;

export function vlanSaid(vlanId: number): number {
  return SAID_BASE + vlanId;
}
const FIRST_JOIN_VLAN = 0;
const LAST_JOIN_VLAN = 1007;

export const VTP_SNAP_HEADER: readonly number[] = [0xaa, 0xaa, 0x03, 0x00, 0x00, 0x0c, 0x20, 0x03];

export function vtpIsEncodable(frame: VtpFrame): boolean {
  return frame.version < 3 && frame.primaryClaim === undefined && frame.database === undefined;
}

function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function ipv4(text: string): number[] {
  const parts = text.split('.').map((part) => parseInt(part, 10) & 0xff);
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4);
}

function domainBytes(domain: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(domain)).slice(0, VTP_DOMAIN_FIELD_BYTES);
  while (bytes.length < VTP_DOMAIN_FIELD_BYTES) bytes.push(0);
  return bytes;
}

export function vtpTimestampDigits(epochMs: number): string {
  if (!epochMs) return '0'.repeat(TIMESTAMP_BYTES);
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function digestBytes(hash: string): number[] {
  const bytes = new Array<number>(DIGEST_BYTES).fill(0);
  for (let index = 0; index < DIGEST_BYTES && hash.length >= 2 * (index + 1); index++) bytes[index] = parseInt(hash.slice(2 * index, 2 * index + 2), 16);
  return bytes;
}

function vlanInfo(vlan: VtpVlanEntry): number[] {
  const name = Array.from(new TextEncoder().encode(vlan.name));
  const padded = [...name, ...new Array<number>((4 - (name.length % 4)) % 4).fill(0)];
  return [
    VLAN_INFO_FIXED_BYTES + padded.length, OPERATIONAL, ETHERNET_VLAN_TYPE, name.length,
    ...u16(vlan.id), ...u16(vlan.mtu), ...u32(vlanSaid(vlan.id)), ...padded,
  ];
}

function joinBitmap(interest: readonly number[]): number[] {
  const bitmap = new Array<number>(Math.ceil((LAST_JOIN_VLAN - FIRST_JOIN_VLAN + 1) / 8)).fill(0);
  for (const vlan of interest) {
    if (vlan >= FIRST_JOIN_VLAN && vlan <= LAST_JOIN_VLAN) bitmap[(vlan - FIRST_JOIN_VLAN) >> 3] |= 0x80 >> ((vlan - FIRST_JOIN_VLAN) & 7);
  }
  return bitmap;
}

export function vtpPayloadBytes(frame: VtpFrame): number[] {
  const third = frame.messageType === 'summary' ? frame.followers ?? 0 : frame.messageType === 'subset' ? frame.sequenceNumber ?? 0 : 0;
  const domain = domainBytes(frame.domain);
  const header = [frame.version, CODE[frame.messageType], third, Math.min(new TextEncoder().encode(frame.domain).length, VTP_DOMAIN_FIELD_BYTES), ...domain];
  if (frame.messageType === 'summary') {
    return [...header, ...u32(frame.revision), ...ipv4(frame.updater), ...Array.from(vtpTimestampDigits(frame.updateTimestamp), (digit) => digit.charCodeAt(0)), ...digestBytes(frame.passwordHash)];
  }
  if (frame.messageType === 'subset') return [...header, ...u32(frame.revision), ...frame.vlans.flatMap(vlanInfo)];
  if (frame.messageType === 'request') return [...header, ...u16(0)];
  return [...header, ...u16(FIRST_JOIN_VLAN), ...u16(LAST_JOIN_VLAN), ...joinBitmap(frame.interestVlans ?? [])];
}
