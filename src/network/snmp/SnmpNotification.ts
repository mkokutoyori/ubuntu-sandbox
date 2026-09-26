import type { IPAddress } from '../core/types';
import type { PortNumber } from '../core/ports/PortNumber';
import {
  OID_SYS_UPTIME, oidStartsWith, v, vb,
  type SnmpPacket, type SnmpTrapV1Packet, type SnmpVarBinding, type SnmpVersion,
} from './types';

export const OID_SNMP_TRAP_OID = '1.3.6.1.6.3.1.1.4.1.0';
export const OID_SNMP_TRAPS = '1.3.6.1.6.3.1.1.5';
export const OID_LINK_DOWN = `${OID_SNMP_TRAPS}.3`;
export const OID_LINK_UP = `${OID_SNMP_TRAPS}.4`;

const FIRST_GENERIC_TRAP_ARC = 1;
const LAST_GENERIC_TRAP_ARC = 6;
const ENTERPRISE_SPECIFIC = 6;

export interface SnmpNotification {
  readonly oid: string;
  readonly objects: readonly SnmpVarBinding[];
  readonly v1Enterprise?: string;
}

export interface SnmpNotificationTarget {
  readonly version: SnmpVersion;
  readonly community: string;
  readonly destination: IPAddress;
  readonly destinationPort: PortNumber;
  readonly sourcePort: PortNumber;
  readonly source?: IPAddress;
  readonly iface?: string;
}

export function trapV2Pdu(
  community: string, requestId: number, uptimeTicks: number, notification: SnmpNotification,
): SnmpPacket {
  return {
    type: 'snmp', version: 'v2c', community, pduType: 'trap-v2', requestId,
    errorStatus: 'no-error', errorIndex: 0,
    varBindings: [
      vb(OID_SYS_UPTIME, v('timeticks', uptimeTicks)),
      vb(OID_SNMP_TRAP_OID, v('object-id', notification.oid)),
      ...notification.objects,
    ],
  };
}

export function trapV1Pdu(
  community: string, agentAddress: IPAddress, uptimeTicks: number, notification: SnmpNotification,
): SnmpTrapV1Packet {
  const arcs = notification.oid.split('.');
  const last = Number(arcs[arcs.length - 1]);
  const generic = genericTrapArc(notification.oid) !== null;
  return {
    type: 'snmp', version: 'v1', community, pduType: 'trap-v1',
    enterprise: generic ? OID_SNMP_TRAPS : notification.v1Enterprise ?? enterpriseOf(arcs),
    agentAddress,
    genericTrap: generic ? last - 1 : ENTERPRISE_SPECIFIC,
    specificTrap: generic ? 0 : last,
    timestamp: uptimeTicks,
    varBindings: notification.objects.filter((binding) => binding.value.type !== 'counter64'),
  };
}

function genericTrapArc(oid: string): number | null {
  if (!oidStartsWith(oid, OID_SNMP_TRAPS) || oid === OID_SNMP_TRAPS) return null;
  const arc = Number(oid.slice(OID_SNMP_TRAPS.length + 1));
  return Number.isInteger(arc) && arc >= FIRST_GENERIC_TRAP_ARC && arc <= LAST_GENERIC_TRAP_ARC ? arc : null;
}

function enterpriseOf(arcs: readonly string[]): string {
  const withoutSpecific = arcs.slice(0, -1);
  return (withoutSpecific[withoutSpecific.length - 1] === '0'
    ? withoutSpecific.slice(0, -1) : withoutSpecific).join('.');
}
