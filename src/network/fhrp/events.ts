/**
 * FHRP — shared event taxonomy for the FhrpAgentBase template (HSRP/VRRP/GLBP).
 *
 * Topics emitted directly by the base class (as opposed to the
 * protocol-specific `hsrp.*` / `vrrp.*` / `glbp.*` topics each subclass
 * owns in its own `events.ts`) live here.
 */
export interface FhrpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface FhrpGratuitousArpSentPayload extends FhrpDeviceRef {
  iface: string;
  group: number;
  vip: string;
  virtualMac: string;
}

export type FhrpDomainEvent =
  | { topic: 'fhrp.gratuitous-arp.sent'; payload: FhrpGratuitousArpSentPayload };
