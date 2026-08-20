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
import { DHCPPacket } from './DHCPPacket';
import type { DHCPServer } from './DHCPServer';
import type { DHCPDiscoverParams, DHCPOfferResult } from './types';

export interface DhcpServeContext {
  server: DHCPServer;
  /** Address of the interface the client's broadcast arrived on, when it is local. */
  localGatewayIP?: string;
  /** `ip dhcp ping packets`: probe a candidate before offering it. */
  isAddressInUse?: (ip: string) => boolean;
}

function offerPacket(pkt: DHCPPacket, offer: DHCPOfferResult): DHCPPacket {
  return DHCPPacket.createOffer(pkt.chaddr, pkt.xid, offer.ip, offer.serverIdentifier, {
    mask: offer.pool.mask ?? '255.255.255.0',
    router: offer.pool.defaultRouter ?? '0.0.0.0',
    dns: offer.pool.dnsServers,
    domainName: offer.pool.domainName ?? undefined,
    leaseDuration: offer.pool.leaseDuration ?? 86400,
    renewalTime: offer.renewalTime,
    rebindingTime: offer.rebindingTime,
    nextServer: offer.pool.nextServer,
    bootfile: offer.pool.bootfile,
    netbiosServers: offer.pool.netbiosServers,
    netbiosNodeType: offer.pool.netbiosNodeType,
    rawOptions: offer.pool.options,
  });
}

/**
 * Returns the packet to send back, or null when the request needs no
 * reply (RELEASE, DECLINE, or no address available).
 */
export function buildDhcpServerReply(pkt: DHCPPacket, ctx: DhcpServeContext): DHCPPacket | null {
  const { server } = ctx;
  const giaddr = pkt.giaddr !== '0.0.0.0' ? pkt.giaddr : undefined;
  const type = pkt.getMessageType();

  if (type === 'DHCPDISCOVER') {
    const params: DHCPDiscoverParams = {
      clientMAC: pkt.chaddr, xid: pkt.xid,
      clientIdentifier: pkt.chaddr, parameterRequestList: [],
      giaddr, localGatewayIP: giaddr ? undefined : ctx.localGatewayIP,
    };
    let offer = server.processDiscover(params);
    if (offer && server.getPingPacketCount() > 0 && ctx.isAddressInUse) {
      let attemptsLeft = 4;
      while (offer && attemptsLeft > 0 && ctx.isAddressInUse(offer.ip)) {
        server.addConflict(offer.ip, 'ping');
        server.cancelPendingOffer(offer.ip);
        const next = server.processDiscover(params);
        offer = (next && next.ip !== offer.ip) ? next : null;
        attemptsLeft--;
      }
    }
    return offer ? offerPacket(pkt, offer) : null;
  }

  if (type === 'DHCPREQUEST') {
    const result = server.processRequestWithNak({
      clientMAC: pkt.chaddr, xid: pkt.xid,
      requestedIP: String(pkt.getOption(50) ?? pkt.ciaddr),
      clientIdentifier: pkt.chaddr,
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
        leaseDuration: pool?.leaseDuration ?? 86400,
        renewalTime: pool?.renewalTime,
        rebindingTime: pool?.rebindingTime,
        nextServer: pool?.nextServer,
        bootfile: pool?.bootfile,
        netbiosServers: pool?.netbiosServers,
        netbiosNodeType: pool?.netbiosNodeType,
        rawOptions: pool?.options,
      });
  }

  if (type === 'DHCPDECLINE') {
    server.processDecline({
      clientMAC: pkt.chaddr,
      declinedIP: String(pkt.getOption(50) ?? ''),
      serverIdentifier: String(pkt.getOption(54) ?? ''),
      clientIdentifier: pkt.chaddr,
    });
    return null;
  }

  if (type === 'DHCPRELEASE') {
    server.processRelease({
      clientMAC: pkt.chaddr,
      clientIP: pkt.ciaddr,
      serverIdentifier: String(pkt.getOption(54) ?? ''),
      clientIdentifier: pkt.chaddr,
    });
    return null;
  }

  return null;
}
