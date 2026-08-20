import type { VrrpState } from './types';

export interface VrrpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface VrrpPacketSentPayload extends VrrpDeviceRef {
  iface: string;
  vrid: number;
  state: VrrpState;
  priority: number;
}

export interface VrrpPacketReceivedPayload extends VrrpDeviceRef {
  iface: string;
  vrid: number;
  fromIp: string;
  fromPriority: number;
}

export interface VrrpStateChangedPayload extends VrrpDeviceRef {
  iface: string;
  vrid: number;
  oldState: VrrpState;
  newState: VrrpState;
  reason: 'config' | 'peer' | 'timeout' | 'priority' | 'preempt';
}

export interface VrrpMasterChangedPayload extends VrrpDeviceRef {
  iface: string;
  vrid: number;
  masterIp: string | null;
  masterPriority: number;
}

/**
 * Une annonce ECARTEE pour authentification.
 *
 * Le motif distingue le TYPE de la CLE parce que les deux envoient
 * l'operateur a deux endroits : un type qui differe veut dire que les
 * deux routeurs n'ont pas la meme commande, une cle qui differe qu'ils
 * ne partagent pas le secret.
 */
export interface VrrpAuthRejectedPayload extends VrrpDeviceRef {
  iface: string;
  vrid: number;
  fromIp: string;
  reason: 'type' | 'key';
}

export type VrrpDomainEvent =
  | { topic: 'vrrp.packet.sent'; payload: VrrpPacketSentPayload }
  | { topic: 'vrrp.packet.received'; payload: VrrpPacketReceivedPayload }
  | { topic: 'vrrp.state.changed'; payload: VrrpStateChangedPayload }
  | { topic: 'vrrp.master.changed'; payload: VrrpMasterChangedPayload }
  | { topic: 'vrrp.auth.rejected'; payload: VrrpAuthRejectedPayload };
