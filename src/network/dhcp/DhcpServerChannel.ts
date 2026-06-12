/**
 * DhcpServerChannel — the client's conversation surface with a DHCP server.
 *
 * Two implementations exist:
 *
 *  - {@link WireDhcpChannel}: builds real {@link DHCPPacket}s and sends
 *    them as UDP 68→67 broadcast frames out of the device's port. The
 *    server's reply (OFFER/ACK/NAK) travels back through the cable plant
 *    and is delivered into the channel's inbox by the host's UDP/68
 *    listener. Cable delivery being synchronous, the reply is available
 *    when `send` returns — which lets the DHCPClient state machine stay
 *    synchronous while the exchange genuinely crosses the physical plant
 *    (a missing cable or a powered-off router really means no lease).
 *
 *  - `DirectServerChannel` (in DHCPClient.ts): wraps a DHCPServer object
 *    reference. Legacy path kept for unit tests that exercise the
 *    client/server state machines without a cabled topology.
 *
 * The interface mirrors RFC 2131 message exchanges, not server internals:
 * DISCOVER→OFFER, REQUEST→ACK/NAK, DECLINE, RELEASE.
 */

import { DHCPPacket, DHCP_OPTION } from './DHCPPacket';
import type {
  DHCPDiscoverParams,
  DHCPOfferResult,
  DHCPRequestParams,
  DHCPAckResult,
  DHCPRequestWithNakResult,
  DHCPDeclineParams,
  DHCPReleaseParams,
  DHCPPoolConfig,
} from './types';

export interface DhcpServerChannel {
  /**
   * Identity of the server this channel talks to. `null` for a wire
   * channel that has not yet received an OFFER/ACK (the broadcast
   * domain is the "server" until one answers).
   */
  readonly serverIP: string | null;
  processDiscover(params: DHCPDiscoverParams): DHCPOfferResult | null;
  processRequestWithNak(params: DHCPRequestParams): DHCPRequestWithNakResult | null;
  processRequest(params: DHCPRequestParams): DHCPAckResult | null;
  processDecline(params: DHCPDeclineParams): void;
  processRelease(params: DHCPReleaseParams): void;
}

/** Function the host provides to put a DHCP message on the wire. */
export type DhcpFrameSender = (iface: string, pkt: DHCPPacket) => void;

const str = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));
const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : v !== undefined && v !== null ? [String(v)] : [];

export class WireDhcpChannel implements DhcpServerChannel {
  /** Replies captured by the host's UDP/68 listener during a send. */
  private inbox: DHCPPacket[] = [];
  private lastServerIp: string | null = null;

  constructor(
    private readonly iface: string,
    private readonly sendFrame: DhcpFrameSender,
  ) {}

  get serverIP(): string | null { return this.lastServerIp; }

  /** Called by the host when a UDP/68 datagram arrives on this iface. */
  deliver(pkt: DHCPPacket): void {
    this.inbox.push(pkt);
  }

  /** Send `pkt` and return the first matching synchronous reply, if any. */
  private exchange(
    pkt: DHCPPacket,
    expect: ReadonlyArray<string>,
    xid: number,
    clientMAC: string,
  ): DHCPPacket | null {
    this.inbox.length = 0;
    this.sendFrame(this.iface, pkt);
    const reply = this.inbox.find(p =>
      p.xid === xid
      && p.chaddr.toLowerCase() === clientMAC.toLowerCase()
      && expect.includes(p.getMessageType() ?? ''));
    this.inbox.length = 0;
    return reply ?? null;
  }

  processDiscover(params: DHCPDiscoverParams): DHCPOfferResult | null {
    const discover = DHCPPacket.createDiscover(params.clientMAC, params.xid);
    if (params.requestedIP) discover.setOption(DHCP_OPTION.REQUESTED_IP, params.requestedIP);
    const offer = this.exchange(discover, ['DHCPOFFER'], params.xid, params.clientMAC);
    if (!offer) return null;

    const serverIdentifier = str(offer.getOption(DHCP_OPTION.SERVER_IDENTIFIER)) ?? offer.siaddr;
    this.lastServerIp = serverIdentifier;
    const renewalTime = num(offer.getOption(DHCP_OPTION.RENEWAL_TIME));
    const rebindingTime = num(offer.getOption(DHCP_OPTION.REBINDING_TIME));
    // Synthesise the pool view from the OFFER options — the wire client
    // only knows what the server told it (unlike the direct path, which
    // peeks at the server's pool object).
    const pool: DHCPPoolConfig = {
      name: 'wire',
      network: null,
      mask: str(offer.getOption(DHCP_OPTION.SUBNET_MASK)),
      defaultRouter: str(offer.getOption(DHCP_OPTION.ROUTER)),
      dnsServers: strArray(offer.getOption(DHCP_OPTION.DNS)),
      domainName: str(offer.getOption(DHCP_OPTION.DOMAIN_NAME)),
      leaseDuration: num(offer.getOption(DHCP_OPTION.LEASE_TIME)) ?? 86400,
      denyPatterns: [],
      renewalTime,
      rebindingTime,
    };
    return {
      ip: offer.yiaddr,
      pool,
      serverIdentifier,
      xid: offer.xid,
      renewalTime,
      rebindingTime,
    };
  }

  processRequestWithNak(params: DHCPRequestParams): DHCPRequestWithNakResult | null {
    const request = DHCPPacket.createRequest(
      params.clientMAC, params.xid, params.requestedIP, params.serverIdentifier ?? '');
    // INIT-REBOOT / RENEWING / REBINDING REQUESTs carry no Server
    // Identifier (RFC 2131 §4.3.2) — strip the empty option.
    if (!params.serverIdentifier) request.removeOption(DHCP_OPTION.SERVER_IDENTIFIER);

    const reply = this.exchange(request, ['DHCPACK', 'DHCPNAK'], params.xid, params.clientMAC);
    if (!reply) return null;

    const serverIdentifier = str(reply.getOption(DHCP_OPTION.SERVER_IDENTIFIER)) ?? reply.siaddr;
    if (reply.getMessageType() === 'DHCPNAK') {
      return {
        type: 'NAK',
        serverIdentifier,
        xid: reply.xid,
        message: str(reply.getOption(DHCP_OPTION.MESSAGE)) ?? undefined,
      };
    }

    this.lastServerIp = serverIdentifier;
    const leaseDuration = num(reply.getOption(DHCP_OPTION.LEASE_TIME)) ?? 86400;
    const now = Date.now();
    return {
      type: 'ACK',
      binding: {
        ipAddress: reply.yiaddr,
        clientId: params.clientMAC,
        leaseStart: now,
        leaseExpiration: now + leaseDuration * 1000,
        poolName: 'wire',
        type: 'automatic',
      },
      serverIdentifier,
      xid: reply.xid,
      renewalTime: num(reply.getOption(DHCP_OPTION.RENEWAL_TIME)),
      rebindingTime: num(reply.getOption(DHCP_OPTION.REBINDING_TIME)),
    };
  }

  processRequest(params: DHCPRequestParams): DHCPAckResult | null {
    const reply = this.processRequestWithNak(params);
    if (!reply || reply.type !== 'ACK' || !reply.binding) return null;
    return {
      binding: reply.binding,
      serverIdentifier: reply.serverIdentifier,
      xid: reply.xid,
      renewalTime: reply.renewalTime,
      rebindingTime: reply.rebindingTime,
    };
  }

  processDecline(params: DHCPDeclineParams): void {
    const xid = Math.floor(Math.random() * 0xFFFFFFFF);
    const pkt = DHCPPacket.createDecline(
      params.clientMAC, xid, params.declinedIP, params.serverIdentifier ?? '0.0.0.0');
    this.sendFrame(this.iface, pkt);
  }

  processRelease(params: DHCPReleaseParams): void {
    const xid = Math.floor(Math.random() * 0xFFFFFFFF);
    const pkt = DHCPPacket.createRelease(
      params.clientMAC, xid, params.clientIP, params.serverIdentifier ?? '0.0.0.0');
    this.sendFrame(this.iface, pkt);
  }
}
