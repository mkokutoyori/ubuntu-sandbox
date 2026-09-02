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
