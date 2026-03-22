export { Logger } from './Logger';
export type { NetworkLog, LogLevel, LogSubscriber } from './Logger';
export {
  MACAddress,
  IPAddress,
  SubnetMask,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  IP_PROTO_ICMP,
  IP_PROTO_TCP,
  IP_PROTO_UDP,
  DEVICE_CATEGORIES,
  generateId,
  resetCounters,
  nextIPv4Id,
  resetIPv4IdCounter,
  computeIPv4Checksum,
  verifyIPv4Checksum,
  createIPv4Packet,
} from './types';
export type {
  EthernetFrame,
  IPv4Packet,
  ARPPacket,
  ARPOperation,
  ICMPPacket,
  ICMPType,
  DeviceType,
  ConnectionType,
  PortInfo,
  DeviceCategory,
} from './types';

// ─── New abstractions (Section 1 gap fixes) ────────────────────────
export * from './constants';
export * from './interfaces';
export { RoutingTable, createIPv4RoutingTable, createIPv6RoutingTable, maskToPrefixLength, ipMatchesNetwork, ipv6MatchesPrefix } from './RoutingTable';
export { PacketQueue } from './PacketQueue';
export { NeighborResolver } from './NeighborResolver';
export type { NeighborEntry } from './NeighborResolver';
