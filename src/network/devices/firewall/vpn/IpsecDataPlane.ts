import type { IPSecEngine } from '../../../ipsec/IPSecEngine';
import { IP_PROTO_ESP, type IPv4Packet } from '../../../core/types';
import { inSameSubnet } from '../../../core/ip';
import type { RouteTable } from '../l3/RouteTable';
import type { IpsecTunnelTable, Phase2Tunnel } from './IpsecTunnelTable';
import { cryptoEntryFor } from './IpsecProgramming';

export interface TunnelEncryption {
  readonly egressInterface: string;
  readonly packets: readonly IPv4Packet[];
}

export interface TunnelDecryption {
  readonly tunnel: string;
  readonly inner: IPv4Packet;
}

export interface SealedLeg {
  readonly iface: string;
  readonly packet: IPv4Packet;
  readonly gateway?: string;
}

export function sealedLegs(
  engine: IPSecEngine, tunnels: IpsecTunnelTable, routes: RouteTable,
  tunnelName: string, packet: IPv4Packet,
): readonly SealedLeg[] {
  const sealed = encryptForTunnel(engine, tunnels, tunnelName, packet);
  if (!sealed) return [];

  return sealed.packets.map(outer => ({
    iface: sealed.egressInterface,
    packet: outer,
    gateway: routes.resolveNextHop(outer.destinationIP.toString())?.nextHop,
  }));
}

export function encryptForTunnel(
  engine: IPSecEngine, tunnels: IpsecTunnelTable,
  tunnelName: string, packet: IPv4Packet,
): TunnelEncryption | null {
  const tunnel = tunnels.getPhase1(tunnelName);
  if (!tunnel || tunnel.policyBased || tunnel.boundInterface.length === 0) return null;

  const selectors = tunnels.selectorsOf(tunnelName);
  if (selectors.length > 0 && !selectors.some(selector => selectorAdmits(selector, packet))) {
    return null;
  }

  const entry = cryptoEntryFor(engine, tunnelName);
  if (!entry) return null;

  const encapsulated = engine.processOutbound(packet, tunnel.boundInterface, entry);
  if (!encapsulated || encapsulated.length === 0) {
    tunnels.markDown(tunnelName, 'negotiation failed');
    return null;
  }

  tunnels.markUp(tunnelName);
  tunnels.recordTraffic(tunnelName, 'out', packet.totalLength);
  return { egressInterface: tunnel.boundInterface, packets: encapsulated };
}

export function decryptFromTunnel(
  engine: IPSecEngine, tunnels: IpsecTunnelTable, packet: IPv4Packet,
): TunnelDecryption | null {
  if (packet.protocol !== IP_PROTO_ESP) return null;

  const inner = engine.processInboundESP(packet);
  if (!inner) return null;

  const peer = packet.sourceIP.toString();
  const tunnel = tunnels.all().find(
    entry => !entry.policyBased && entry.remoteGateway === peer);
  if (!tunnel) return null;

  tunnels.markUp(tunnel.name);
  tunnels.recordTraffic(tunnel.name, 'in', inner.totalLength);
  return { tunnel: tunnel.name, inner };
}

function selectorAdmits(selector: Phase2Tunnel, packet: IPv4Packet): boolean {
  return subnetAdmits(selector.sourceSubnet, selector.sourceMask, packet.sourceIP.toString())
    && subnetAdmits(
      selector.destinationSubnet, selector.destinationMask, packet.destinationIP.toString());
}

function subnetAdmits(network: string, mask: string, address: string): boolean {
  if (network === '0.0.0.0' && (mask === '0.0.0.0' || mask === '')) return true;
  return inSameSubnet(network, address, mask);
}
