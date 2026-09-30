/**
 * DHCPv6 (RFC 8415) core types — pools, bindings, message parameters.
 * Mirrors the shape of ../dhcp/types.ts for the v4 engine.
 */

export type DHCPv6MessageType =
  | 'SOLICIT' | 'ADVERTISE' | 'REQUEST' | 'CONFIRM' | 'RENEW' | 'REBIND'
  | 'REPLY' | 'RELEASE' | 'DECLINE' | 'RECONFIGURE' | 'INFORMATION-REQUEST'
  | 'RELAY-FORW' | 'RELAY-REPL';

export interface DHCPv6AddressRange {
  startIp: string;
  endIp: string;
}

export interface DHCPv6PoolConfig {
  name: string;
  /** Network prefix (host bits zeroed), e.g. "2001:db8:1::" */
  prefix: string | null;
  prefixLength: number | null;
  ranges: DHCPv6AddressRange[];
  dnsServers: string[];
  domainName: string | null;
  preferredLifetime: number;
  validLifetime: number;
  delegations: DHCPv6DelegationPool[];
  staticDelegations: DHCPv6StaticDelegation[];
  rapidCommit: boolean;
  preference: number;
  delegationFromLocalPool: string | null;
  reservations: DHCPv6Reservation[];
  exclusions: DHCPv6AddressRange[];
  t1: number | null;
  t2: number | null;
  serverUnicast: string | null;
  reconfigure: boolean;
  informationRefreshTime: number;
}

export interface DHCPv6Reservation {
  address: string;
  clientDuid: string;
  iaid: number | null;
  name: string | null;
}

export interface DHCPv6DelegationPool {
  prefix: string;
  prefixLength: number;
  assignedLength: number;
  firstPrefix?: string;
  lastPrefix?: string;
}

export interface DHCPv6StaticDelegation {
  prefix: string;
  prefixLength: number;
  clientDuid: string;
  iaid: number | null;
}

export interface DHCPv6RelayPath {
  relayAddress: string;
  layers: ReadonlyArray<DHCPv6RelayLayer>;
}

export interface DHCPv6RelayLayer {
  linkAddress: string;
  peerAddress: string;
  interfaceId: string | null;
}

export interface DHCPv6PrefixBinding {
  clientDuid: string;
  iaid: number;
  prefix: string;
  prefixLength: number;
  poolName: string;
  leaseStart: number;
  leaseExpiration: number;
}

export function createDefaultDHCPv6Pool(name: string): DHCPv6PoolConfig {
  return {
    name,
    prefix: null,
    prefixLength: null,
    ranges: [],
    dnsServers: [],
    domainName: null,
    preferredLifetime: 27000,
    validLifetime: 43200,
    delegations: [],
    staticDelegations: [],
    rapidCommit: false,
    preference: 0,
    delegationFromLocalPool: null,
    reservations: [],
    exclusions: [],
    t1: null,
    t2: null,
    serverUnicast: null,
    reconfigure: false,
    informationRefreshTime: 86400,
  };
}

export interface DHCPv6Binding {
  clientDuid: string;
  iaid: number;
  address: string;
  poolName: string;
  leaseStart: number;
  leaseExpiration: number;
}

export interface DHCPv6SolicitParams {
  clientDuid: string;
  iaid: number;
  transactionId: number;
  /** Set when relayed: the relay's own link address selects the pool. */
  linkAddress?: string;
}

export interface DHCPv6RequestParams extends DHCPv6SolicitParams {
  requestedAddress: string;
  serverDuid: string;
}

export interface DHCPv6LeaseResult {
  address: string;
  pool: DHCPv6PoolConfig;
  serverDuid: string;
  transactionId: number;
}

export interface DHCPv6ReleaseParams {
  clientDuid: string;
  iaid: number;
  address: string;
}
