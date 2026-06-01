export const UDP_PORT_SNMP = 161;
export const UDP_PORT_SNMP_TRAP = 162;

export type SnmpVersion = 'v1' | 'v2c';

export type SnmpPduType =
  | 'get-request'
  | 'get-next-request'
  | 'get-response'
  | 'set-request'
  | 'get-bulk-request'
  | 'inform-request'
  | 'trap-v2';

export const SNMP_PDU_TYPE: Record<SnmpPduType, number> = {
  'get-request': 0xa0,
  'get-next-request': 0xa1,
  'get-response': 0xa2,
  'set-request': 0xa3,
  'get-bulk-request': 0xa5,
  'inform-request': 0xa6,
  'trap-v2': 0xa7,
};

export type SnmpErrorStatus =
  | 'no-error'
  | 'too-big'
  | 'no-such-name'
  | 'bad-value'
  | 'read-only'
  | 'gen-err'
  | 'no-access'
  | 'wrong-type'
  | 'wrong-length'
  | 'wrong-encoding'
  | 'wrong-value'
  | 'no-creation'
  | 'inconsistent-value'
  | 'resource-unavailable'
  | 'commit-failed'
  | 'undo-failed'
  | 'authorization-error'
  | 'not-writable'
  | 'inconsistent-name';

export const SNMP_ERROR_STATUS: Record<SnmpErrorStatus, number> = {
  'no-error': 0, 'too-big': 1, 'no-such-name': 2, 'bad-value': 3,
  'read-only': 4, 'gen-err': 5, 'no-access': 6, 'wrong-type': 7,
  'wrong-length': 8, 'wrong-encoding': 9, 'wrong-value': 10,
  'no-creation': 11, 'inconsistent-value': 12, 'resource-unavailable': 13,
  'commit-failed': 14, 'undo-failed': 15, 'authorization-error': 16,
  'not-writable': 17, 'inconsistent-name': 18,
};

export type SnmpValueType =
  | 'integer' | 'octet-string' | 'object-id' | 'null'
  | 'ipv4' | 'counter32' | 'gauge32' | 'timeticks' | 'counter64'
  | 'no-such-object' | 'no-such-instance' | 'end-of-mib-view';

export interface SnmpValue {
  type: SnmpValueType;
  value: string | number | null;
}

export interface SnmpVarBinding {
  oid: string;
  value: SnmpValue;
}

export interface SnmpPacket {
  type: 'snmp';
  version: SnmpVersion;
  community: string;
  pduType: SnmpPduType;
  requestId: number;
  errorStatus: SnmpErrorStatus;
  errorIndex: number;
  varBindings: SnmpVarBinding[];
}

export interface SnmpCommunityAcl {
  community: string;
  access: 'ro' | 'rw';
}

export interface SnmpTrapHost {
  ip: string;
  community: string;
  port: number;
}

export interface SnmpAgentConfig {
  enabled: boolean;
  port: number;
  communities: SnmpCommunityAcl[];
  contact: string;
  location: string;
  trapHosts: SnmpTrapHost[];
}

export function createDefaultAgentConfig(): SnmpAgentConfig {
  return {
    enabled: true, port: UDP_PORT_SNMP,
    communities: [{ community: 'public', access: 'ro' }],
    contact: '', location: '',
    trapHosts: [],
  };
}

export function v(type: SnmpValueType, value: string | number | null): SnmpValue {
  return { type, value };
}

export function vb(oid: string, value: SnmpValue): SnmpVarBinding {
  return { oid, value };
}

export function oidCompare(a: string, b: string): number {
  const ai = a.split('.').map(Number);
  const bi = b.split('.').map(Number);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) if (ai[i] !== bi[i]) return ai[i] - bi[i];
  return ai.length - bi.length;
}

export function oidStartsWith(child: string, prefix: string): boolean {
  if (child === prefix) return true;
  return child.startsWith(prefix + '.');
}

export const OID_SYS_DESCR = '1.3.6.1.2.1.1.1.0';
export const OID_SYS_OBJECT_ID = '1.3.6.1.2.1.1.2.0';
export const OID_SYS_UPTIME = '1.3.6.1.2.1.1.3.0';
export const OID_SYS_CONTACT = '1.3.6.1.2.1.1.4.0';
export const OID_SYS_NAME = '1.3.6.1.2.1.1.5.0';
export const OID_SYS_LOCATION = '1.3.6.1.2.1.1.6.0';
export const OID_SYS_SERVICES = '1.3.6.1.2.1.1.7.0';
export const OID_IF_NUMBER = '1.3.6.1.2.1.2.1.0';
export const OID_IF_INDEX_PREFIX = '1.3.6.1.2.1.2.2.1.1';
export const OID_IF_DESCR_PREFIX = '1.3.6.1.2.1.2.2.1.2';
export const OID_IF_TYPE_PREFIX = '1.3.6.1.2.1.2.2.1.3';
export const OID_IF_MTU_PREFIX = '1.3.6.1.2.1.2.2.1.4';
export const OID_IF_PHYS_ADDR_PREFIX = '1.3.6.1.2.1.2.2.1.6';
export const OID_IF_ADMIN_STATUS_PREFIX = '1.3.6.1.2.1.2.2.1.7';
export const OID_IF_OPER_STATUS_PREFIX = '1.3.6.1.2.1.2.2.1.8';
