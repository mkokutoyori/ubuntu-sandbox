import { IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP } from '../../../core/types';

const IP_PROTO_ICMPV6 = 58;
const IP_PROTO_SCTP = 132;

export type ServiceProtocol = 'tcp' | 'udp' | 'sctp' | 'icmp' | 'icmp6' | 'ip';

export interface PortRange {
  readonly from: number;
  readonly to: number;
}

export interface ServiceEntry {
  readonly protocol: ServiceProtocol;
  readonly destinationPorts?: readonly PortRange[];
  readonly sourcePorts?: readonly PortRange[];
  readonly icmpType?: number;
  readonly icmpCode?: number;
  readonly ipProtocolNumber?: number;
}

export interface ServiceObject {
  readonly name: string;
  readonly entries: readonly ServiceEntry[];
  readonly predefined: boolean;
  readonly category?: string;
  readonly comment?: string;
  readonly sessionTtlSec?: number;
}

export interface ServiceProbe {
  readonly protocol: number;
  readonly sourcePort?: number;
  readonly destPort?: number;
  readonly icmpType?: number;
  readonly icmpCode?: number;
}

export interface ServiceObjectOptions {
  predefined?: boolean;
  category?: string;
  comment?: string;
  sessionTtlSec?: number;
}

export type PortSpec = number | PortRange;

const NAMED_PROTOCOL_NUMBER: Readonly<Record<Exclude<ServiceProtocol, 'ip'>, number>> = {
  tcp: IP_PROTO_TCP,
  udp: IP_PROTO_UDP,
  sctp: IP_PROTO_SCTP,
  icmp: IP_PROTO_ICMP,
  icmp6: IP_PROTO_ICMPV6,
};

export function makeService(
  name: string, entries: readonly ServiceEntry[], options: ServiceObjectOptions = {},
): ServiceObject {
  return Object.freeze({
    name,
    entries: Object.freeze(entries.map(freezeEntry)),
    predefined: options.predefined ?? false,
    category: options.category,
    comment: options.comment,
    sessionTtlSec: options.sessionTtlSec,
  });
}

export function tcpService(name: string, ...ports: PortSpec[]): ServiceObject {
  return makeService(name, [{ protocol: 'tcp', destinationPorts: ports.map(toRange) }]);
}

export function udpService(name: string, ...ports: PortSpec[]): ServiceObject {
  return makeService(name, [{ protocol: 'udp', destinationPorts: ports.map(toRange) }]);
}

export function icmpService(
  name: string, icmpType?: number, icmpCode?: number,
  options: ServiceObjectOptions = {},
): ServiceObject {
  return makeService(name, [{ protocol: 'icmp', icmpType, icmpCode }], options);
}

export function ipProtocolService(
  name: string, ipProtocolNumber: number, options: ServiceObjectOptions = {},
): ServiceObject {
  return makeService(name, [{ protocol: 'ip', ipProtocolNumber }], options);
}

export function anyService(name = 'any'): ServiceObject {
  return makeService(name, [{ protocol: 'ip' }], { predefined: true });
}

export function serviceObjectMatches(service: ServiceObject, probe: ServiceProbe): boolean {
  return service.entries.some(entry => serviceEntryMatches(entry, probe));
}

export function serviceEntryMatches(entry: ServiceEntry, probe: ServiceProbe): boolean {
  if (!protocolMatches(entry, probe.protocol)) return false;

  if (entry.protocol === 'icmp' || entry.protocol === 'icmp6') {
    if (entry.icmpType !== undefined && entry.icmpType !== probe.icmpType) return false;
    if (entry.icmpCode !== undefined && entry.icmpCode !== probe.icmpCode) return false;
    return true;
  }

  if (entry.protocol === 'ip') return true;

  if (!portMatches(entry.destinationPorts, probe.destPort)) return false;
  if (!portMatches(entry.sourcePorts, probe.sourcePort)) return false;
  return true;
}

function protocolMatches(entry: ServiceEntry, protocol: number): boolean {
  if (entry.protocol === 'ip') {
    return entry.ipProtocolNumber === undefined || entry.ipProtocolNumber === protocol;
  }
  return NAMED_PROTOCOL_NUMBER[entry.protocol] === protocol;
}

function portMatches(ranges: readonly PortRange[] | undefined, port: number | undefined): boolean {
  if (ranges === undefined || ranges.length === 0) return true;
  if (port === undefined) return false;
  return ranges.some(range => port >= range.from && port <= range.to);
}

function toRange(spec: PortSpec): PortRange {
  return typeof spec === 'number' ? { from: spec, to: spec } : spec;
}

function freezeEntry(entry: ServiceEntry): ServiceEntry {
  return Object.freeze({
    ...entry,
    destinationPorts: entry.destinationPorts
      ? Object.freeze(entry.destinationPorts.map(r => Object.freeze({ ...r })))
      : undefined,
    sourcePorts: entry.sourcePorts
      ? Object.freeze(entry.sourcePorts.map(r => Object.freeze({ ...r })))
      : undefined,
  });
}
