import { IP_PROTO_ESP, type EthernetFrame, type IPv4Packet } from '../../../core/types';
import type { VdomContext } from '../vdom/VdomRegistry';
import type { CaptivePortalRedirect } from '../auth/CaptivePortalRedirect';
import { claimedByControlPlane, type L3Services } from './L3ServiceWiring';
import { flowKeyFromPacket } from '../session/FlowKey';

export type IngressDecision =
  | { kind: 'consumed' }
  | { kind: 'decapsulated'; tunnel: string; inner: IPv4Packet }
  | { kind: 'local' }
  | { kind: 'transit' };

export interface Ipv4IngressHost {
  readonly l3: L3Services;
  readonly captivePortal: CaptivePortalRedirect;
  ownsAddress(address: string): boolean;
  decapsulate(packet: IPv4Packet): { tunnel: string; inner: IPv4Packet } | null;
  hasSession(vdom: VdomContext, packet: IPv4Packet): boolean;
  destinedToSelf(vdom: VdomContext, packet: IPv4Packet): boolean;
  destinationIsTranslated(iface: string, packet: IPv4Packet): boolean;
}

export interface IngressWiring {
  readonly l3: L3Services;
  readonly captivePortal: CaptivePortalRedirect;
  readonly interfaces: { owningInterface(address: string): string | undefined };
  vdomOf(iface: string): VdomContext;
  decapsulate(packet: IPv4Packet): { tunnel: string; inner: IPv4Packet } | null;
}

export function ingressHostOf(wiring: IngressWiring): Ipv4IngressHost {
  return {
    l3: wiring.l3,
    captivePortal: wiring.captivePortal,
    ownsAddress: (a) => wiring.interfaces.owningInterface(a) !== undefined,
    decapsulate: (p) => wiring.decapsulate(p),
    hasSession: (vdom, p) => vdom.sessions.lookup(flowKeyFromPacket(p)) !== undefined,
    destinedToSelf: (vdom, p) => destinedToSelf(wiring, vdom, p),
    destinationIsTranslated: (iface, p) =>
      destinationIsTranslated(wiring.vdomOf(iface), iface, p),
  };
}

function destinedToSelf(
  wiring: IngressWiring, vdom: VdomContext, packet: IPv4Packet,
): boolean {
  const destination = packet.destinationIP.toString();
  if (vdom.settings.opmode === 'transparent') return vdom.settings.manageIP === destination;
  return wiring.interfaces.owningInterface(destination) !== undefined;
}

function destinationIsTranslated(
  vdom: VdomContext, portName: string, packet: IPv4Packet,
): boolean {
  return vdom.nat.hasInboundRule(packet, {
    ingressZone: vdom.zones.zoneOf(portName) ?? portName, egressZone: '',
    ingressInterface: portName, egressInterface: '',
  });
}

export function classifyIpv4(
  host: Ipv4IngressHost, iface: string, vdom: VdomContext,
  packet: IPv4Packet, frame?: EthernetFrame,
): IngressDecision {
  if (claimedByControlPlane(host.l3, iface, packet, frame?.srcMAC.toString() ?? '')) {
    return { kind: 'consumed' };
  }

  if (host.captivePortal.claims(iface, packet)) {
    host.captivePortal.capture(iface, packet);
    return { kind: 'consumed' };
  }

  if (packet.protocol === IP_PROTO_ESP
    && host.ownsAddress(packet.destinationIP.toString())) {
    const opened = host.decapsulate(packet);
    return opened === null
      ? { kind: 'consumed' }
      : { kind: 'decapsulated', tunnel: opened.tunnel, inner: opened.inner };
  }

  if (!host.hasSession(vdom, packet)
    && host.destinedToSelf(vdom, packet)
    && !host.destinationIsTranslated(iface, packet)) {
    return { kind: 'local' };
  }
  return { kind: 'transit' };
}
