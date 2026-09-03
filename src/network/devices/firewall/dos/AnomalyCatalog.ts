import {
  IP_PROTO_ICMP, IP_PROTO_ICMPV6, IP_PROTO_TCP, IP_PROTO_UDP,
} from '../../../core/types';

export const IP_PROTO_SCTP = 132;

export type AnomalyKind = 'flood' | 'scan' | 'src-session' | 'dst-session';

export type AnomalyFamily = 'tcp' | 'udp' | 'icmp' | 'ip' | 'sctp';

export interface AnomalySpec {
  readonly name: string;
  readonly family: AnomalyFamily;
  readonly kind: AnomalyKind;
  readonly defaultThreshold: number;
}

function spec(
  name: string, family: AnomalyFamily, kind: AnomalyKind, defaultThreshold: number,
): AnomalySpec {
  return Object.freeze({ name, family, kind, defaultThreshold });
}

export const ANOMALY_CATALOG: readonly AnomalySpec[] = Object.freeze([
  spec('tcp_syn_flood', 'tcp', 'flood', 2000),
  spec('tcp_port_scan', 'tcp', 'scan', 1000),
  spec('tcp_src_session', 'tcp', 'src-session', 5000),
  spec('tcp_dst_session', 'tcp', 'dst-session', 5000),
  spec('udp_flood', 'udp', 'flood', 2000),
  spec('udp_scan', 'udp', 'scan', 2000),
  spec('udp_src_session', 'udp', 'src-session', 5000),
  spec('udp_dst_session', 'udp', 'dst-session', 5000),
  spec('icmp_flood', 'icmp', 'flood', 250),
  spec('icmp_sweep', 'icmp', 'scan', 100),
  spec('icmp_src_session', 'icmp', 'src-session', 300),
  spec('icmp_dst_session', 'icmp', 'dst-session', 1000),
  spec('ip_src_session', 'ip', 'src-session', 5000),
  spec('ip_dst_session', 'ip', 'dst-session', 5000),
  spec('sctp_flood', 'sctp', 'flood', 2000),
  spec('sctp_scan', 'sctp', 'scan', 1000),
  spec('sctp_src_session', 'sctp', 'src-session', 5000),
  spec('sctp_dst_session', 'sctp', 'dst-session', 5000),
]);

const BY_NAME: ReadonlyMap<string, AnomalySpec> = new Map(
  ANOMALY_CATALOG.map(entry => [entry.name, entry]));

export function anomalySpec(name: string): AnomalySpec | undefined {
  return BY_NAME.get(name);
}

export function anomalyNames(): readonly string[] {
  return ANOMALY_CATALOG.map(entry => entry.name);
}

export function anomalyDefaultThresholds(): ReadonlyMap<string, number> {
  return new Map(ANOMALY_CATALOG.map(entry => [entry.name, entry.defaultThreshold]));
}

export type IpVersion = 4 | 6;

const FAMILY_PROTOCOL: Readonly<Record<AnomalyFamily, Readonly<Record<IpVersion, number | null>>>> = {
  tcp: { 4: IP_PROTO_TCP, 6: IP_PROTO_TCP },
  udp: { 4: IP_PROTO_UDP, 6: IP_PROTO_UDP },
  icmp: { 4: IP_PROTO_ICMP, 6: IP_PROTO_ICMPV6 },
  sctp: { 4: IP_PROTO_SCTP, 6: IP_PROTO_SCTP },
  ip: { 4: null, 6: null },
};

export function familyCovers(
  family: AnomalyFamily, protocol: number, version: IpVersion,
): boolean {
  const declared = FAMILY_PROTOCOL[family][version];
  return declared === null || declared === protocol;
}
