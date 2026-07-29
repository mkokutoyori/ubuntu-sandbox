export interface MdnsDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface MdnsQuerySentPayload extends MdnsDeviceRef {
  /** Le nom `.local` demandé au lien. */
  name: string;
}

export interface MdnsRespondedPayload extends MdnsDeviceRef {
  name: string;
  addresses: string[];
  /**
   * True pour une réponse à un demandeur ponctuel : unicast, TTL
   * plafonné (RFC 6762 §6.7). False pour une réponse sur le groupe.
   */
  legacy: boolean;
}

export interface MdnsAnnouncedPayload extends MdnsDeviceRef {
  name: string;
  addresses: string[];
}

export type MdnsDomainEvent =
  | { topic: 'mdns.query.sent'; payload: MdnsQuerySentPayload }
  | { topic: 'mdns.responded'; payload: MdnsRespondedPayload }
  | { topic: 'mdns.announced'; payload: MdnsAnnouncedPayload };
