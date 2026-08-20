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

export interface MdnsConflictPayload extends MdnsDeviceRef {
  /** Le nom que l'hôte vient de perdre. */
  name: string;
  /** Le rang de la tentative : 1 pour le nom d'origine. */
  attempt: number;
}

export interface MdnsNameClaimedPayload extends MdnsDeviceRef {
  name: string;
  /** True quand le nom acquis n'est plus celui d'origine. */
  renamed: boolean;
}

export interface MdnsServicePayload extends MdnsDeviceRef {
  /** Le nom d'instance complet — `Mon serveur._http._tcp.local`. */
  name: string;
  port: number;
}

export type MdnsDomainEvent =
  | { topic: 'mdns.query.sent'; payload: MdnsQuerySentPayload }
  | { topic: 'mdns.responded'; payload: MdnsRespondedPayload }
  | { topic: 'mdns.announced'; payload: MdnsAnnouncedPayload }
  | { topic: 'mdns.conflict.detected'; payload: MdnsConflictPayload }
  | { topic: 'mdns.name.claimed'; payload: MdnsNameClaimedPayload }
  | { topic: 'mdns.service.announced'; payload: MdnsServicePayload }
  | { topic: 'mdns.service.goodbye'; payload: MdnsServicePayload }
  | { topic: 'mdns.service.expired'; payload: MdnsServicePayload };
