/**
 * The vendor-neutral half of answering a DHCP request off the wire:
 * a client packet in, the reply packet out. It owns no transport — the
 * caller decides which interface the request arrived on and where the
 * reply goes, which is the only part a router and an L3 switch's SVI
 * plane genuinely disagree about.
 *
 * Extracted so a switch serving its own VLANs runs the same RFC 2131
 * server path a router does, rather than a second copy of it.
 */
import { DHCPPacket, DHCP_OPTION } from './DHCPPacket';
import type { DHCPServer } from './DHCPServer';
import type { DHCPDiscoverParams, DHCPOfferResult, DhcpRelayInformation } from './types';

export interface DhcpServeContext {
  server: DHCPServer;
  /** Address of the interface the client's broadcast arrived on, when it is local. */
  localGatewayIP?: string;
  /** `ip dhcp ping packets`: probe a candidate before offering it. */
  isAddressInUse?: (ip: string) => boolean;
}

function offerPacket(pkt: DHCPPacket, offer: DHCPOfferResult, leaseDuration: number): DHCPPacket {
  return DHCPPacket.createOffer(pkt.chaddr, pkt.xid, offer.ip, offer.serverIdentifier, {
    mask: offer.pool.mask ?? '255.255.255.0',
    router: offer.pool.defaultRouter ?? '0.0.0.0',
    dns: offer.pool.dnsServers,
    domainName: offer.pool.domainName ?? undefined,
    leaseDuration,
    renewalTime: offer.renewalTime,
    rebindingTime: offer.rebindingTime,
    nextServer: offer.pool.nextServer,
    bootfile: offer.pool.bootfile,
    netbiosServers: offer.pool.netbiosServers,
    netbiosNodeType: offer.pool.netbiosNodeType,
    rawOptions: offer.pool.options,
  });
}

function requestedAddress(pkt: DHCPPacket): string | undefined {
  const raw = pkt.getOption(DHCP_OPTION.REQUESTED_IP);
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function relayInformationOf(pkt: DHCPPacket): DhcpRelayInformation | undefined {
  const raw = pkt.getOption(82) as { circuitId?: unknown; remoteId?: unknown } | undefined;
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined;
  return { circuitId: String(raw.circuitId ?? ''), remoteId: String(raw.remoteId ?? '') };
}

function vendorClassOf(pkt: DHCPPacket): string | undefined {
  const raw = pkt.getOption(DHCP_OPTION.VENDOR_CLASS);
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function clientHostName(pkt: DHCPPacket): string | undefined {
  const raw = pkt.getOption(DHCP_OPTION.HOST_NAME);
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

export type DhcpReplyRoute =
  | { readonly kind: 'relay'; readonly relay: string }
  | { readonly kind: 'broadcast' }
  | { readonly kind: 'unicast'; readonly address: string };

const BROADCAST_FLAG = 0x8000;

export function dhcpReplyRoute(request: DHCPPacket, reply: DHCPPacket): DhcpReplyRoute {
  if (request.giaddr !== '0.0.0.0') return { kind: 'relay', relay: request.giaddr };
  if (reply.getMessageType() === 'DHCPNAK') return { kind: 'broadcast' };
  if (request.ciaddr !== '0.0.0.0') return { kind: 'unicast', address: request.ciaddr };
  if ((request.flags & BROADCAST_FLAG) !== 0 || reply.yiaddr === '0.0.0.0') return { kind: 'broadcast' };
  return { kind: 'unicast', address: reply.yiaddr };
}

/**
 * Returns the packet to send back, or null when the request needs no
 * reply (RELEASE, DECLINE, or no address available).
 */
export function buildDhcpServerReply(pkt: DHCPPacket, ctx: DhcpServeContext): DHCPPacket | null {
  const reply = answerDhcpRequest(pkt, ctx);
  if (reply === null) return null;
  reply.giaddr = pkt.giaddr;
  reply.flags = reply.getMessageType() === 'DHCPNAK' && pkt.giaddr !== '0.0.0.0'
    ? pkt.flags | BROADCAST_FLAG
    : pkt.flags;
  return reply;
}

const IMPLIED_CLIENT_IDENTIFIER = /^01([0-9a-f]{12})$/i;

export function clientKeyOf(pkt: DHCPPacket): string {
  const raw = pkt.getOption(DHCP_OPTION.CLIENT_IDENTIFIER);
  if (typeof raw !== 'string' || raw.length === 0) return pkt.chaddr;
  const implied = IMPLIED_CLIENT_IDENTIFIER.exec(raw);
  if (implied) return implied[1].toUpperCase().replace(/(..)(?=.)/g, '$1:');
  return `id:${raw}`;
}

function answerDhcpRequest(pkt: DHCPPacket, ctx: DhcpServeContext): DHCPPacket | null {
  const { server } = ctx;
  const giaddr = pkt.giaddr !== '0.0.0.0' ? pkt.giaddr : undefined;
  const type = pkt.getMessageType();

  if (type === 'DHCPDISCOVER') {
    const params: DHCPDiscoverParams = {
      clientMAC: clientKeyOf(pkt), xid: pkt.xid,
      hostName: clientHostName(pkt),
      clientIdentifier: pkt.chaddr, parameterRequestList: [],
      vendorClass: vendorClassOf(pkt),
      relayInformation: relayInformationOf(pkt),
      requestedIP: requestedAddress(pkt),
      giaddr, localGatewayIP: giaddr ? undefined : ctx.localGatewayIP,
    };
    let offer = server.processDiscover(params);
    if (offer && server.getPingPacketCount() > 0 && ctx.isAddressInUse) {
      while (offer && ctx.isAddressInUse(offer.ip)) {
        server.addConflict(offer.ip, 'ping');
        server.cancelPendingOffer(offer.ip);
        const next = server.processDiscover(params);
        offer = (next && next.ip !== offer.ip) ? next : null;
      }
    }
    if (!offer) return null;
    const previous = server.remainingLeaseSeconds(offer.ip, clientKeyOf(pkt));
    return offerPacket(pkt, offer, previous ?? server.leaseSecondsOf(offer.pool, offer.ip));
  }

  if (type === 'DHCPREQUEST') {
    const selecting = pkt.getOption(54) !== undefined;
    const result = server.processRequestWithNak({
      clientMAC: clientKeyOf(pkt), xid: pkt.xid,
      requestState: selecting ? 'selecting' : pkt.ciaddr === '0.0.0.0' ? 'init-reboot' : 'renewing',
      requestedIP: String(pkt.getOption(50) ?? pkt.ciaddr),
      hostName: clientHostName(pkt),
      clientIdentifier: pkt.chaddr,
      vendorClass: vendorClassOf(pkt),
      relayInformation: relayInformationOf(pkt),
      serverIdentifier: String(pkt.getOption(54) ?? ''),
      giaddr,
    } as never);
    if (!result) return null;
    if (result.type === 'NAK' || !result.binding) {
      return DHCPPacket.createNak(pkt.chaddr, pkt.xid, result.serverIdentifier,
        result.message ?? 'requested address not available');
    }
    const pool = server.getPool(result.binding.poolName);
    return DHCPPacket.createAck(pkt.chaddr, pkt.xid,
      result.binding.ipAddress, result.serverIdentifier, {
        mask: pool?.mask ?? '255.255.255.0',
        router: pool?.defaultRouter ?? '0.0.0.0',
        dns: pool?.dnsServers ?? [],
        domainName: pool?.domainName ?? undefined,
        leaseDuration: pool ? server.leaseSecondsOf(pool, result.binding.ipAddress) : 86400,
        renewalTime: pool?.renewalTime,
        rebindingTime: pool?.rebindingTime,
        nextServer: pool?.nextServer,
        bootfile: pool?.bootfile,
        netbiosServers: pool?.netbiosServers,
        netbiosNodeType: pool?.netbiosNodeType,
        rawOptions: pool?.options,
      });
  }

  if (type === 'DHCPINFORM') {
    const result = server.processInform({
      clientMAC: clientKeyOf(pkt), clientIP: pkt.ciaddr, xid: pkt.xid, clientIdentifier: pkt.chaddr,
    });
    if (!result) return null;
    return DHCPPacket.createInformAck(pkt.chaddr, pkt.xid, pkt.ciaddr, result.serverIdentifier, {
      mask: result.mask,
      router: result.router ?? '0.0.0.0',
      dns: result.dnsServers,
      domainName: result.domainName ?? undefined,
    });
  }

  if (type === 'DHCPDECLINE') {
    server.processDecline({
      clientMAC: clientKeyOf(pkt),
      declinedIP: String(pkt.getOption(50) ?? ''),
      serverIdentifier: String(pkt.getOption(54) ?? ''),
      clientIdentifier: pkt.chaddr,
    });
    return null;
  }

  if (type === 'DHCPRELEASE') {
    server.processRelease({
      clientMAC: clientKeyOf(pkt),
      clientIP: pkt.ciaddr,
      serverIdentifier: String(pkt.getOption(54) ?? ''),
      clientIdentifier: pkt.chaddr,
    });
    return null;
  }

  return null;
}
