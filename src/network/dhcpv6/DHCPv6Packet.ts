/**
 * DHCPv6Packet - wire message model (RFC 8415).
 *
 * Like DHCPPacket.ts for v4, this simulator passes packets as structured
 * objects rather than raw bytes, so the "wire format" here is a typed
 * class carrying the fields a real DHCPv6 message conveys (message type,
 * transaction-id, DUIDs, IA_NA/IAADDR, DNS options) plus RELAY-FORW/
 * RELAY-REPL encapsulation (RFC 8415 §7).
 */

import type { DHCPv6MessageType } from './types';

export interface DHCPv6IAAddress {
  address: string;
  preferredLifetime: number;
  validLifetime: number;
}

export interface DHCPv6IANA {
  iaid: number;
  t1: number;
  t2: number;
  addresses: DHCPv6IAAddress[];
  statusCode?: number;
  statusMessage?: string;
}

export interface DHCPv6Authentication {
  protocol: 3;
  algorithm: 1;
  rdm: 0;
  type: 1 | 2;
  value: string;
}

export interface DHCPv6IAPrefix {
  prefix: string;
  prefixLength: number;
  preferredLifetime: number;
  validLifetime: number;
}

export interface DHCPv6IAPD {
  iaid: number;
  t1: number;
  t2: number;
  prefixes: DHCPv6IAPrefix[];
  statusCode?: number;
  statusMessage?: string;
}

export const DHCPV6_STATUS = {
  Success: 0,
  UnspecFail: 1,
  NoAddrsAvail: 2,
  NoBinding: 3,
  NotOnLink: 4,
  UseMulticast: 5,
  NoPrefixAvail: 6,
} as const;

export const DHCPV6_HOP_COUNT_LIMIT = 8;
export const DHCPV6_REC_TIMEOUT_SECONDS = 2;
export const DHCPV6_REC_MAX_RC = 8;
export const DHCPV6_IRT_DEFAULT = 86400;
export const DHCPV6_IRT_MINIMUM = 600;
export const DHCPV6_IRT_INFINITY = 0xffffffff;

export const DHCPV6_OPTION = {
  DNS_SERVERS: 23,
  DOMAIN_LIST: 24,
  UNICAST: 12,
  RECONF_MSG: 19,
  RECONF_ACCEPT: 20,
  IA_PD: 25,
  INFORMATION_REFRESH_TIME: 32,
} as const;

export class DHCPv6Packet {
  msgType: DHCPv6MessageType = 'SOLICIT';
  transactionId: number = 0;

  clientDuid: string | null = null;
  serverDuid: string | null = null;
  ias: DHCPv6IANA[] = [];
  prefixDelegations: DHCPv6IAPD[] = [];
  rapidCommit = false;
  optionRequest: number[] | null = null;
  serverUnicast: string | null = null;
  reconfigureAccept = false;
  reconfigureMessage: 'RENEW' | 'REBIND' | 'INFORMATION-REQUEST' | null = null;
  authentication: DHCPv6Authentication | null = null;
  informationRefreshTime: number | null = null;
  preference: number | null = null;
  dnsServers: string[] = [];
  domainList: string[] = [];
  elapsedTime = 0;
  /** Status code option (0 = Success), when the server needs to signal failure. */
  statusCode: number | null = null;
  statusMessage: string | null = null;

  // RELAY-FORW/RELAY-REPL fields (RFC 8415 §7)
  hopCount = 0;
  linkAddress: string = '::';
  peerAddress: string = '::';
  interfaceId: string | null = null;
  relayedMessage: DHCPv6Packet | null = null;

  get ia(): DHCPv6IANA | null { return this.ias[0] ?? null; }
  set ia(value: DHCPv6IANA | null) {
    if (value) this.ias[0] = value;
    else this.ias = [];
  }

  static createSolicit(clientDuid: string, iaid: number, transactionId: number): DHCPv6Packet {
    const pkt = new DHCPv6Packet();
    pkt.msgType = 'SOLICIT';
    pkt.transactionId = transactionId;
    pkt.clientDuid = clientDuid;
    pkt.ia = { iaid, t1: 0, t2: 0, addresses: [] };
    return pkt;
  }

  static createRequest(
    clientDuid: string, serverDuid: string, iaid: number,
    requestedAddress: string, transactionId: number,
  ): DHCPv6Packet {
    const pkt = new DHCPv6Packet();
    pkt.msgType = 'REQUEST';
    pkt.transactionId = transactionId;
    pkt.clientDuid = clientDuid;
    pkt.serverDuid = serverDuid;
    pkt.ia = { iaid, t1: 0, t2: 0, addresses: [{ address: requestedAddress, preferredLifetime: 0, validLifetime: 0 }] };
    return pkt;
  }

  static createRelease(clientDuid: string, serverDuid: string, iaid: number, address: string, transactionId: number): DHCPv6Packet {
    const pkt = new DHCPv6Packet();
    pkt.msgType = 'RELEASE';
    pkt.transactionId = transactionId;
    pkt.clientDuid = clientDuid;
    pkt.serverDuid = serverDuid;
    pkt.ia = { iaid, t1: 0, t2: 0, addresses: [{ address, preferredLifetime: 0, validLifetime: 0 }] };
    return pkt;
  }

  private static createServerReply(
    msgType: 'ADVERTISE' | 'REPLY',
    clientDuid: string, serverDuid: string, transactionId: number, iaid: number,
    address: string, preferredLifetime: number, validLifetime: number,
    dnsServers: string[], domainName: string | null,
  ): DHCPv6Packet {
    const pkt = new DHCPv6Packet();
    pkt.msgType = msgType;
    pkt.transactionId = transactionId;
    pkt.clientDuid = clientDuid;
    pkt.serverDuid = serverDuid;
    pkt.ia = { iaid, t1: Math.floor(preferredLifetime / 2), t2: Math.floor(preferredLifetime * 0.8), addresses: [{ address, preferredLifetime, validLifetime }] };
    pkt.dnsServers = dnsServers;
    if (domainName) pkt.domainList = [domainName];
    return pkt;
  }

  static createAdvertise(
    clientDuid: string, serverDuid: string, transactionId: number, iaid: number,
    address: string, preferredLifetime: number, validLifetime: number,
    dnsServers: string[] = [], domainName: string | null = null,
  ): DHCPv6Packet {
    return DHCPv6Packet.createServerReply('ADVERTISE', clientDuid, serverDuid, transactionId, iaid, address, preferredLifetime, validLifetime, dnsServers, domainName);
  }

  static createReply(
    clientDuid: string, serverDuid: string, transactionId: number, iaid: number,
    address: string, preferredLifetime: number, validLifetime: number,
    dnsServers: string[] = [], domainName: string | null = null,
  ): DHCPv6Packet {
    return DHCPv6Packet.createServerReply('REPLY', clientDuid, serverDuid, transactionId, iaid, address, preferredLifetime, validLifetime, dnsServers, domainName);
  }

  /**
   * INFORMATION-REQUEST (RFC 8415 §18.2.6): a client that wants NO
   * address, only the other configuration — name servers, search
   * domain. It carries no IA: there is nothing to bind.
   */
  static createInformationRequest(clientDuid: string, transactionId: number): DHCPv6Packet {
    const pkt = new DHCPv6Packet();
    pkt.msgType = 'INFORMATION-REQUEST';
    pkt.transactionId = transactionId;
    pkt.clientDuid = clientDuid;
    return pkt;
  }

  /**
   * The REPLY to an INFORMATION-REQUEST: the same configuration options
   * as an ordinary lease and no IA — nothing assigned, nothing retained.
   */
  static createInformationReply(
    clientDuid: string, serverDuid: string, transactionId: number,
    dnsServers: string[] = [], domainName: string | null = null,
  ): DHCPv6Packet {
    const pkt = new DHCPv6Packet();
    pkt.msgType = 'REPLY';
    pkt.transactionId = transactionId;
    pkt.clientDuid = clientDuid;
    pkt.serverDuid = serverDuid;
    pkt.dnsServers = dnsServers;
    if (domainName) pkt.domainList = [domainName];
    return pkt;
  }

  static createClientMessage(
    msgType: 'REQUEST' | 'CONFIRM' | 'RENEW' | 'REBIND' | 'RELEASE' | 'DECLINE',
    clientDuid: string, serverDuid: string | null, transactionId: number,
    ias: DHCPv6IANA[], prefixDelegations: DHCPv6IAPD[] = [],
  ): DHCPv6Packet {
    const pkt = new DHCPv6Packet();
    pkt.msgType = msgType;
    pkt.transactionId = transactionId;
    pkt.clientDuid = clientDuid;
    pkt.serverDuid = serverDuid;
    pkt.ias = ias;
    pkt.prefixDelegations = prefixDelegations;
    return pkt;
  }

  static createRelayForw(linkAddress: string, peerAddress: string, hopCount: number, interfaceId: string | null, relayedMessage: DHCPv6Packet): DHCPv6Packet {
    const pkt = new DHCPv6Packet();
    pkt.msgType = 'RELAY-FORW';
    pkt.linkAddress = linkAddress;
    pkt.peerAddress = peerAddress;
    pkt.hopCount = hopCount;
    pkt.interfaceId = interfaceId;
    pkt.relayedMessage = relayedMessage;
    return pkt;
  }

  static createRelayRepl(linkAddress: string, peerAddress: string, interfaceId: string | null, relayedMessage: DHCPv6Packet): DHCPv6Packet {
    const pkt = new DHCPv6Packet();
    pkt.msgType = 'RELAY-REPL';
    pkt.linkAddress = linkAddress;
    pkt.peerAddress = peerAddress;
    pkt.interfaceId = interfaceId;
    pkt.relayedMessage = relayedMessage;
    return pkt;
  }
}
