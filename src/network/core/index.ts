export { Logger } from './Logger';
export { DEVICE_CATALOG, DEVICE_CATEGORIES, deviceDefinition } from './deviceCatalog';
export type { DeviceDefinition, DeviceOSType, DeviceCategoryId, DeviceCategory } from './deviceCatalog';
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
} from './types';

// ─── New abstractions (Section 1 gap fixes) ────────────────────────
export * from './constants';
export * from './interfaces';
export { maskToPrefixLength, ipMatchesNetwork, ipv6MatchesPrefix } from './RoutingTable';
export { PacketQueue } from './PacketQueue';
export {
  buildIpv4Frame,
  buildUdpIpv4Frame,
  wrapIpv4InEthernet,
} from './packetBuilders';
export type { Ipv4FrameArgs, UdpIpv4FrameArgs } from './packetBuilders';
export {
  ipToUint32,
  tryIpToUint32,
  uint32ToIp,
  prefixLengthToMaskUint32,
  networkAddress,
  inSameSubnet,
  wildcardMatches,
} from './ip';
