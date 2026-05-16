/**
 * Host (L3/L4) — reactive event taxonomy.
 *
 * Covers events emitted by `EndHost` (LinuxPC, WindowsPC, LinuxServer)
 * and `Router`. Topics are deviceId-scoped so multi-host topologies
 * stay clean on a shared bus.
 *
 * Current strategy (Phase 5): events are emitted *alongside* the
 * legacy `pendingXxx` callbacks, not replacing them yet. Once the
 * shadow emissions are validated test-side, the pending maps are
 * progressively swapped for `waitForEvent` (Phases 5.4–5.6).
 */

// Note: payload fields use plain strings for IPs/MACs to keep the
// event taxonomy serialisable without coupling consumers to the
// MACAddress/IPAddress/IPv6Address classes.

// ── Identity ────────────────────────────────────────────────────────────

export interface HostDeviceRef {
  deviceId: string;
  hostname?: string;
}

// ── ARP / NDP ───────────────────────────────────────────────────────────

export interface HostArpEntryLearnedPayload extends HostDeviceRef {
  ip: string;
  mac: string;
  iface: string;
  source: 'reply' | 'gratuitous' | 'request' | 'static';
}

export interface HostArpEntryExpiredPayload extends HostDeviceRef {
  ip: string;
  mac: string;
}

export interface HostArpRequestSentPayload extends HostDeviceRef {
  iface: string;
  targetIp: string;
}

export interface HostNdpEntryLearnedPayload extends HostDeviceRef {
  ip: string;
  mac: string;
  iface: string;
}

export interface HostNdpEntryExpiredPayload extends HostDeviceRef {
  ip: string;
}

// ── Routing ────────────────────────────────────────────────────────────

export interface HostRouteAddedPayload extends HostDeviceRef {
  destination: string;
  mask: string;
  gateway: string | null;
  iface: string;
  metric: number;
  type: string;
}

export interface HostRouteRemovedPayload extends HostDeviceRef {
  destination: string;
  mask: string;
  iface: string;
}

// ── ICMPv4 / ICMPv6 ────────────────────────────────────────────────────

export interface HostIcmpEchoSentPayload extends HostDeviceRef {
  fromIp: string;
  toIp: string;
  id: number;
  seq: number;
  ttl: number;
  size: number;
}

export interface HostIcmpEchoReplyPayload extends HostDeviceRef {
  fromIp: string;
  toIp: string;
  id: number;
  seq: number;
  ttl: number;
  rttMs: number;
}

export interface HostIcmpEchoTimeoutPayload extends HostDeviceRef {
  toIp: string;
  id: number;
  seq: number;
}

export interface HostIcmpUnreachablePayload extends HostDeviceRef {
  fromIp: string;
  toIp: string;
  code: 'host-unreachable' | 'net-unreachable' | 'port-unreachable' | 'ttl-exceeded';
}

/**
 * Emitted when an in-flight ICMP echo request is invalidated by a returning
 * ICMP error packet (TTL exceeded / destination unreachable). Used by
 * `sendPing` to settle the awaiting promise via `waitForEvent` instead of a
 * pendingPings callback (Phase 5.6).
 */
export interface HostIcmpEchoFailedPayload extends HostDeviceRef {
  fromIp: string;   // sender of the ICMP error
  toIp: string;     // original echo-request destination
  id: number;
  seq: number;
  reason: string;
}

// ── TCP ────────────────────────────────────────────────────────────────

export interface HostTcpListenerStartedPayload extends HostDeviceRef {
  ip: string;
  port: number;
}

export interface HostTcpListenerStoppedPayload extends HostDeviceRef {
  ip: string;
  port: number;
}

export interface HostTcpConnectionEstablishedPayload extends HostDeviceRef {
  localIp: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  side: 'client' | 'server';
}

export interface HostTcpConnectionClosedPayload extends HostDeviceRef {
  localIp: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  reason: 'fin' | 'rst' | 'timeout' | 'manual';
}

// ── L3 packet egress request ───────────────────────────────────────────

/**
 * Emitted by the host when its routing logic decides to send a packet
 * out of an interface but ARP / NDP resolution may still be pending.
 * Consumers (telemetry, tests) can observe the egress decision before
 * the actual frame leaves.
 */
export interface HostL3PacketTxRequestedPayload extends HostDeviceRef {
  iface: string;
  protocol: number;
  srcIp: string;
  dstIp: string;
  size: number;
  needsArp: boolean;
}

// ── Discriminated union ────────────────────────────────────────────────

export type HostDomainEvent =
  | { topic: 'host.arp.entry-learned'; payload: HostArpEntryLearnedPayload }
  | { topic: 'host.arp.entry-expired'; payload: HostArpEntryExpiredPayload }
  | { topic: 'host.arp.request-sent'; payload: HostArpRequestSentPayload }
  | { topic: 'host.ndp.entry-learned'; payload: HostNdpEntryLearnedPayload }
  | { topic: 'host.ndp.entry-expired'; payload: HostNdpEntryExpiredPayload }
  | { topic: 'host.routing.route-added'; payload: HostRouteAddedPayload }
  | { topic: 'host.routing.route-removed'; payload: HostRouteRemovedPayload }
  | { topic: 'host.icmp.echo-sent'; payload: HostIcmpEchoSentPayload }
  | { topic: 'host.icmp.echo-reply'; payload: HostIcmpEchoReplyPayload }
  | { topic: 'host.icmp.echo-timeout'; payload: HostIcmpEchoTimeoutPayload }
  | { topic: 'host.icmp.echo-failed'; payload: HostIcmpEchoFailedPayload }
  | { topic: 'host.icmp.unreachable'; payload: HostIcmpUnreachablePayload }
  | { topic: 'host.tcp.listener-started'; payload: HostTcpListenerStartedPayload }
  | { topic: 'host.tcp.listener-stopped'; payload: HostTcpListenerStoppedPayload }
  | { topic: 'host.tcp.connection-established'; payload: HostTcpConnectionEstablishedPayload }
  | { topic: 'host.tcp.connection-closed'; payload: HostTcpConnectionClosedPayload }
  | { topic: 'host.l3.packet-tx-requested'; payload: HostL3PacketTxRequestedPayload };
