import type { DtpAdminMode, DtpFrame } from './types';

const VERSION = 1;
const TLV_DOMAIN = 0x0001;
const TLV_TRUNK_STATUS = 0x0002;
const TLV_TRUNK_TYPE = 0x0003;
const TLV_SENDER_ID = 0x0004;
const TLV_HEADER_BYTES = 4;
const OPERATING_TRUNK = 0x80;
const OPERATING_TYPE_SHIFT = 5;
const OPERATING_TYPE_NATIVE = 1;
const OPERATING_TYPE_ISL = 2;
const OPERATING_TYPE_DOT1Q = 5;
const ADMIN_TYPE: Readonly<Record<DtpFrame['trunkEncapsulation'], number>> = { negotiated: 0, isl: 2, dot1q: 5 };
const ADMIN_STATUS: Readonly<Record<DtpAdminMode, number>> = {
  trunk: 1, nonegotiate: 1, access: 2, 'dynamic-desirable': 3, 'dynamic-auto': 4,
};

export const DTP_SNAP_HEADER: readonly number[] = [0xaa, 0xaa, 0x03, 0x00, 0x00, 0x0c, 0x20, 0x04];

function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function tlv(type: number, value: readonly number[]): number[] {
  return [...u16(type), ...u16(TLV_HEADER_BYTES + value.length), ...value];
}

function operatingType(frame: DtpFrame): number {
  if (frame.operationalMode === 'access') return OPERATING_TYPE_NATIVE;
  return frame.trunkEncapsulation === 'isl' ? OPERATING_TYPE_ISL : OPERATING_TYPE_DOT1Q;
}

export function dtpPayloadBytes(frame: DtpFrame): number[] {
  const domain = Array.from(new TextEncoder().encode(frame.domain));
  const status = (frame.operationalMode === 'trunk' ? OPERATING_TRUNK : 0) | ADMIN_STATUS[frame.adminMode];
  const type = (operatingType(frame) << OPERATING_TYPE_SHIFT) | ADMIN_TYPE[frame.trunkEncapsulation];
  const sender = frame.neighborMac.split(':').map((part) => parseInt(part, 16) & 0xff);
  return [
    VERSION,
    ...tlv(TLV_DOMAIN, [...domain, 0]),
    ...tlv(TLV_TRUNK_STATUS, [status]),
    ...tlv(TLV_TRUNK_TYPE, [type]),
    ...tlv(TLV_SENDER_ID, sender),
  ];
}
