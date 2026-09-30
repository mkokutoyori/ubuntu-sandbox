import { IPv6Address } from '../core/types';
import { DHCPv6Packet, DHCPV6_STATUS, DHCPV6_OPTION, DHCPV6_IRT_INFINITY, DHCPV6_IRT_MINIMUM } from './DHCPv6Packet';
import type { DHCPv6IANA, DHCPv6IAPD, DHCPv6IAAddress, DHCPv6IAPrefix } from './DHCPv6Packet';
import type { DHCPv6Server } from './DHCPv6Server';
import type { DHCPv6PoolConfig } from './types';

export interface Dhcpv6ExchangeContext {
  readonly poolName?: string;
  readonly anchor?: string;
  readonly clientAddress?: string;
  readonly clientInterface?: string;
  readonly destination?: string;
  readonly relayed: boolean;
  readonly unicast: boolean;
}

const STATUS_TEXT: Record<number, string> = {
  [DHCPV6_STATUS.Success]: 'Success.',
  [DHCPV6_STATUS.UnspecFail]: 'Failure, reason unspecified.',
  [DHCPV6_STATUS.NoAddrsAvail]: 'No addresses available for this IA.',
  [DHCPV6_STATUS.NoBinding]: 'No binding found for this IA.',
  [DHCPV6_STATUS.NotOnLink]: 'The prefix for the address is not appropriate for the link.',
  [DHCPV6_STATUS.UseMulticast]: 'Use multicast to reach the server.',
  [DHCPV6_STATUS.NoPrefixAvail]: 'No prefixes available for this IA_PD.',
};

function statusOnly(iaid: number, code: number): DHCPv6IANA {
  return { iaid, t1: 0, t2: 0, addresses: [], statusCode: code, statusMessage: STATUS_TEXT[code] };
}

function statusOnlyPd(iaid: number, code: number): DHCPv6IAPD {
  return { iaid, t1: 0, t2: 0, prefixes: [], statusCode: code, statusMessage: STATUS_TEXT[code] };
}

function leasedAddress(address: string, pool: DHCPv6PoolConfig): DHCPv6IAAddress {
  return { address, preferredLifetime: pool.preferredLifetime, validLifetime: pool.validLifetime };
}

function leasedPrefix(prefix: string, prefixLength: number, pool: DHCPv6PoolConfig): DHCPv6IAPrefix {
  return { prefix, prefixLength, preferredLifetime: pool.preferredLifetime, validLifetime: pool.validLifetime };
}

function expiredAddress(address: string): DHCPv6IAAddress {
  return { address, preferredLifetime: 0, validLifetime: 0 };
}

function expiredPrefix(prefix: string, prefixLength: number): DHCPv6IAPrefix {
  return { prefix, prefixLength, preferredLifetime: 0, validLifetime: 0 };
}

function stamp(request: DHCPv6Packet, server: DHCPv6Server, msgType: 'ADVERTISE' | 'REPLY'): DHCPv6Packet {
  const reply = new DHCPv6Packet();
  reply.msgType = msgType;
  reply.transactionId = request.transactionId;
  reply.clientDuid = request.clientDuid;
  reply.serverDuid = server.getServerDuid();
  return reply;
}

function wants(request: DHCPv6Packet, option: number): boolean {
  return request.optionRequest === null || request.optionRequest.includes(option);
}

function applyConfiguration(reply: DHCPv6Packet, request: DHCPv6Packet, pool: DHCPv6PoolConfig | undefined): void {
  if (!pool) return;
  if (pool.dnsServers.length > 0 && wants(request, DHCPV6_OPTION.DNS_SERVERS)) reply.dnsServers = [...pool.dnsServers];
  if (pool.domainName && wants(request, DHCPV6_OPTION.DOMAIN_LIST)) reply.domainList = [pool.domainName];
}

function uniformTimers(reply: DHCPv6Packet, pool: DHCPv6PoolConfig | undefined): void {
  const preferred: number[] = [];
  for (const ia of reply.ias) for (const a of ia.addresses) if (a.validLifetime > 0) preferred.push(a.preferredLifetime);
  for (const pd of reply.prefixDelegations) for (const p of pd.prefixes) if (p.validLifetime > 0) preferred.push(p.preferredLifetime);
  if (preferred.length === 0) return;
  const shortest = Math.min(...preferred);
  const t1 = pool?.t1 ?? Math.floor(shortest * 0.5);
  const t2 = pool?.t2 ?? Math.floor(shortest * 0.8);
  for (const ia of reply.ias) if (ia.addresses.some(a => a.validLifetime > 0)) { ia.t1 = t1; ia.t2 = t2; }
  for (const pd of reply.prefixDelegations) if (pd.prefixes.some(p => p.validLifetime > 0)) { pd.t1 = t1; pd.t2 = t2; }
}

function messageStatus(reply: DHCPv6Packet, code: number): void {
  reply.statusCode = code;
  reply.statusMessage = STATUS_TEXT[code];
}

function preferredPoolOf(server: DHCPv6Server, ctx: Dhcpv6ExchangeContext, reply: DHCPv6Packet): DHCPv6PoolConfig | undefined {
  const candidate = reply.ias[0]?.addresses[0]?.address ?? reply.prefixDelegations[0]?.prefixes[0]?.prefix;
  if (ctx.poolName) return server.getPool(ctx.poolName);
  for (const binding of server.getBindings()) if (binding.address === candidate) return server.getPool(binding.poolName);
  for (const binding of server.getPrefixBindings()) if (binding.prefix === candidate) return server.getPool(binding.poolName);
  return [...server.getAllPools().values()][0];
}

function assignAddresses(server: DHCPv6Server, request: DHCPv6Packet, ctx: Dhcpv6ExchangeContext, ia: DHCPv6IANA, commit: boolean): DHCPv6IANA {
  const clientDuid = request.clientDuid!;
  const common = { clientDuid, iaid: ia.iaid, transactionId: request.transactionId, linkAddress: ctx.anchor };
  if (!commit) {
    const offer = server.processSolicit(common, ctx.poolName);
    return offer
      ? { iaid: ia.iaid, t1: 0, t2: 0, addresses: [leasedAddress(offer.address, offer.pool)] }
      : statusOnly(ia.iaid, DHCPV6_STATUS.NoAddrsAvail);
  }
  for (const wanted of ia.addresses) {
    if (server.addressOnLink(wanted.address, ctx.anchor, ctx.poolName) === false) {
      return statusOnly(ia.iaid, DHCPV6_STATUS.NotOnLink);
    }
  }
  for (const wanted of ia.addresses) {
    const granted = server.processRequest(
      { ...common, requestedAddress: wanted.address, serverDuid: server.getServerDuid() }, ctx.poolName);
    if (granted) return { iaid: ia.iaid, t1: 0, t2: 0, addresses: [leasedAddress(granted.address, granted.pool)] };
  }
  const offer = server.processSolicit(common, ctx.poolName);
  const granted = offer && server.processRequest(
    { ...common, requestedAddress: offer.address, serverDuid: server.getServerDuid() }, ctx.poolName);
  return granted
    ? { iaid: ia.iaid, t1: 0, t2: 0, addresses: [leasedAddress(granted.address, granted.pool)] }
    : statusOnly(ia.iaid, DHCPV6_STATUS.NoAddrsAvail);
}

function assignPrefixes(server: DHCPv6Server, request: DHCPv6Packet, ctx: Dhcpv6ExchangeContext, pd: DHCPv6IAPD, commit: boolean): DHCPv6IAPD {
  const clientDuid = request.clientDuid!;
  const offer = server.offerPrefix(clientDuid, pd.iaid, ctx.poolName, ctx.anchor);
  if (!offer) return statusOnlyPd(pd.iaid, DHCPV6_STATUS.NoPrefixAvail);
  if (!commit) return { iaid: pd.iaid, t1: 0, t2: 0, prefixes: [leasedPrefix(offer.prefix, offer.prefixLength, offer.pool)] };
  const granted = server.commitPrefix(clientDuid, pd.iaid, offer.prefix, offer.prefixLength, ctx.poolName, ctx.anchor);
  return granted
    ? { iaid: pd.iaid, t1: 0, t2: 0, prefixes: [leasedPrefix(granted.prefix, granted.prefixLength, granted.pool)] }
    : statusOnlyPd(pd.iaid, DHCPV6_STATUS.NoPrefixAvail);
}

function allocate(
  server: DHCPv6Server, request: DHCPv6Packet, ctx: Dhcpv6ExchangeContext, msgType: 'ADVERTISE' | 'REPLY', commit: boolean,
): DHCPv6Packet {
  const reply = stamp(request, server, msgType);
  reply.ias = request.ias.map(ia => assignAddresses(server, request, ctx, ia, commit));
  reply.prefixDelegations = request.prefixDelegations.map(pd => assignPrefixes(server, request, ctx, pd, commit));
  const answering = preferredPoolOf(server, ctx, reply);
  uniformTimers(reply, answering);
  applyConfiguration(reply, request, answering);
  const preference = server.selectPool(ctx.anchor, ctx.poolName)?.preference ?? 0;
  if (msgType === 'ADVERTISE' && preference > 0) reply.preference = preference;
  return reply;
}

function extendOrExpire(
  server: DHCPv6Server, request: DHCPv6Packet, ctx: Dhcpv6ExchangeContext, rebind: boolean,
): DHCPv6Packet | null {
  const clientDuid = request.clientDuid!;
  const reply = stamp(request, server, 'REPLY');
  let answered = false;

  for (const ia of request.ias) {
    const kept: DHCPv6IAAddress[] = [];
    const dropped: DHCPv6IAAddress[] = [];
    for (const wanted of ia.addresses) {
      const known = server.findBinding(clientDuid, ia.iaid, wanted.address);
      if (known && server.addressOnLink(wanted.address, ctx.anchor, ctx.poolName) === false) {
        server.processRelease({ clientDuid, iaid: ia.iaid, address: wanted.address });
        dropped.push(expiredAddress(wanted.address));
        continue;
      }
      const extended = known ? server.extendAddress(clientDuid, ia.iaid, wanted.address) : null;
      if (extended) kept.push(leasedAddress(wanted.address, extended.pool));
      else if (server.addressOnLink(wanted.address, ctx.anchor, ctx.poolName) === false) dropped.push(expiredAddress(wanted.address));
    }
    if (kept.length > 0 || dropped.length > 0) {
      reply.ias.push({ iaid: ia.iaid, t1: 0, t2: 0, addresses: [...kept, ...dropped] });
      answered = true;
    } else if (!rebind) {
      reply.ias.push(statusOnly(ia.iaid, DHCPV6_STATUS.NoBinding));
      answered = true;
    }
  }

  for (const pd of request.prefixDelegations) {
    const kept: DHCPv6IAPrefix[] = [];
    for (const wanted of pd.prefixes) {
      const extended = server.extendPrefix(clientDuid, pd.iaid, wanted.prefix, wanted.prefixLength);
      if (extended) kept.push(leasedPrefix(wanted.prefix, wanted.prefixLength, extended.pool));
    }
    if (kept.length > 0) {
      reply.prefixDelegations.push({ iaid: pd.iaid, t1: 0, t2: 0, prefixes: kept });
      answered = true;
    } else if (!rebind) {
      reply.prefixDelegations.push(statusOnlyPd(pd.iaid, DHCPV6_STATUS.NoBinding));
      answered = true;
    }
  }

  if (!answered) return null;
  const answering = preferredPoolOf(server, ctx, reply);
  uniformTimers(reply, answering);
  applyConfiguration(reply, request, answering);
  return reply;
}

function confirm(server: DHCPv6Server, request: DHCPv6Packet, ctx: Dhcpv6ExchangeContext): DHCPv6Packet | null {
  const addresses = request.ias.flatMap(ia => ia.addresses.map(a => a.address));
  if (addresses.length === 0) return null;
  let verdict: number = DHCPV6_STATUS.Success;
  for (const address of addresses) {
    const onLink = server.addressOnLink(address, ctx.anchor, ctx.poolName);
    if (onLink === null) return null;
    if (!onLink) verdict = DHCPV6_STATUS.NotOnLink;
  }
  const reply = stamp(request, server, 'REPLY');
  messageStatus(reply, verdict);
  return reply;
}

function relinquish(
  server: DHCPv6Server, request: DHCPv6Packet, decline: boolean,
): DHCPv6Packet {
  const clientDuid = request.clientDuid!;
  const reply = stamp(request, server, 'REPLY');
  for (const ia of request.ias) {
    let matched = false;
    for (const wanted of ia.addresses) {
      const done = decline
        ? server.declineAddress(clientDuid, ia.iaid, wanted.address)
        : server.processRelease({ clientDuid, iaid: ia.iaid, address: wanted.address });
      matched = matched || done;
    }
    if (!matched) reply.ias.push(statusOnly(ia.iaid, DHCPV6_STATUS.NoBinding));
  }
  for (const pd of request.prefixDelegations) {
    let matched = false;
    for (const wanted of pd.prefixes) {
      matched = server.releasePrefix(clientDuid, pd.iaid, wanted.prefix, wanted.prefixLength) || matched;
    }
    if (!matched) reply.prefixDelegations.push(statusOnlyPd(pd.iaid, DHCPV6_STATUS.NoBinding));
  }
  messageStatus(reply, DHCPV6_STATUS.Success);
  return reply;
}

function unicastPermitted(server: DHCPv6Server, ctx: Dhcpv6ExchangeContext): boolean {
  const configured = server.selectPool(ctx.anchor, ctx.poolName)?.serverUnicast;
  if (!configured || !ctx.destination) return false;
  try { return new IPv6Address(ctx.destination).toString() === configured; } catch { return false; }
}

function decorate(server: DHCPv6Server, request: DHCPv6Packet, ctx: Dhcpv6ExchangeContext, reply: DHCPv6Packet): void {
  const pool = server.selectPool(ctx.anchor, ctx.poolName);
  const duid = request.clientDuid;
  if (!pool || !duid || reply.statusCode === DHCPV6_STATUS.UseMulticast) return;
  if (pool.serverUnicast) reply.serverUnicast = pool.serverUnicast;
  if (request.msgType === 'SOLICIT' || request.msgType === 'REQUEST' || request.msgType === 'INFORMATION-REQUEST') {
    server.noteReconfigureWilling(duid, request.reconfigureAccept && pool.reconfigure);
  }
  if (request.reconfigureAccept && pool.reconfigure) {
    reply.reconfigureAccept = true;
    if (reply.msgType === 'REPLY') {
      reply.authentication = { protocol: 3, algorithm: 1, rdm: 0, type: 1, value: server.reconfigureKeyFor(duid) };
    }
  }
  if (request.msgType === 'INFORMATION-REQUEST' && request.optionRequest?.includes(DHCPV6_OPTION.INFORMATION_REFRESH_TIME)) {
    reply.informationRefreshTime = pool.informationRefreshTime === DHCPV6_IRT_INFINITY
      ? DHCPV6_IRT_INFINITY : Math.max(DHCPV6_IRT_MINIMUM, pool.informationRefreshTime);
  }
}

function useMulticast(request: DHCPv6Packet, server: DHCPv6Server): DHCPv6Packet {
  const reply = stamp(request, server, 'REPLY');
  messageStatus(reply, DHCPV6_STATUS.UseMulticast);
  return reply;
}

function information(server: DHCPv6Server, request: DHCPv6Packet, ctx: Dhcpv6ExchangeContext): DHCPv6Packet | null {
  if (request.ias.length > 0 || request.prefixDelegations.length > 0) return null;
  if (request.serverDuid !== null && request.serverDuid !== server.getServerDuid()) return null;
  const found = server.processInformationRequest({ transactionId: request.transactionId }, ctx.poolName, ctx.anchor);
  if (!found) return null;
  const reply = stamp(request, server, 'REPLY');
  applyConfiguration(reply, request, found.pool);
  return reply;
}

function serve(
  server: DHCPv6Server, request: DHCPv6Packet, ctx: Dhcpv6ExchangeContext,
): DHCPv6Packet | null {
  const direct = !ctx.relayed;
  if (ctx.clientAddress && request.clientDuid) server.noteClientAddress(request.clientDuid, ctx.clientAddress, ctx.clientInterface ?? null);
  if (request.clientDuid) server.satisfyReconfigure(request.clientDuid, request.msgType);
  const ownId = server.getServerDuid();
  switch (request.msgType) {
    case 'SOLICIT': {
      if (!request.clientDuid || request.serverDuid !== null) return null;
      if (direct && ctx.unicast) return null;
      if (request.rapidCommit && server.selectPool(ctx.anchor, ctx.poolName)?.rapidCommit) {
        const reply = allocate(server, request, ctx, 'REPLY', true);
        reply.rapidCommit = true;
        return reply;
      }
      return allocate(server, request, ctx, 'ADVERTISE', false);
    }
    case 'REQUEST':
    case 'RENEW':
    case 'RELEASE':
    case 'DECLINE': {
      if (!request.clientDuid || request.serverDuid !== ownId) return null;
      if (direct && ctx.unicast && !unicastPermitted(server, ctx)) return useMulticast(request, server);
      if (request.msgType === 'REQUEST') return allocate(server, request, ctx, 'REPLY', true);
      if (request.msgType === 'RENEW') return extendOrExpire(server, request, ctx, false);
      return relinquish(server, request, request.msgType === 'DECLINE');
    }
    case 'CONFIRM':
    case 'REBIND': {
      if (!request.clientDuid || request.serverDuid !== null) return null;
      if (direct && ctx.unicast) return null;
      return request.msgType === 'CONFIRM' ? confirm(server, request, ctx) : extendOrExpire(server, request, ctx, true);
    }
    case 'INFORMATION-REQUEST': {
      if (direct && ctx.unicast) return null;
      return information(server, request, ctx);
    }
    default:
      return null;
  }
}

export function buildDhcpv6ServerReply(
  server: DHCPv6Server, request: DHCPv6Packet, ctx: Dhcpv6ExchangeContext,
): DHCPv6Packet | null {
  const original = request.clientDuid;
  const canonical = original === null || original === original.toLowerCase()
    ? request : Object.assign(new DHCPv6Packet(), request, { clientDuid: original.toLowerCase() });
  const reply = serve(server, canonical, ctx);
  if (!reply) return null;
  decorate(server, canonical, ctx, reply);
  if (canonical !== request) reply.clientDuid = original;
  return reply;
}

export function answerRelayForward(
  server: DHCPv6Server, forward: DHCPv6Packet, depth = 0,
): DHCPv6Packet | null {
  const inner = forward.relayedMessage;
  if (!inner || depth > 32) return null;
  const answer = inner.msgType === 'RELAY-FORW'
    ? answerRelayForward(server, inner, depth + 1)
    : buildDhcpv6ServerReply(server, inner, {
      anchor: forward.linkAddress, clientAddress: forward.peerAddress, relayed: true, unicast: false,
    });
  if (!answer) return null;
  return DHCPv6Packet.createRelayRepl(forward.linkAddress, forward.peerAddress, forward.interfaceId, answer);
}
