export interface LlmnrDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface LlmnrQuerySentPayload extends LlmnrDeviceRef {
  /** Le nom mono-label demandé au lien. */
  name: string;
}

export interface LlmnrRespondedPayload extends LlmnrDeviceRef {
  name: string;
  addresses: string[];
  /** L'émetteur de la question — la réponse LLMNR est unicast. */
  to: string;
  toPort: number;
}

export interface LlmnrResolvedPayload extends LlmnrDeviceRef {
  name: string;
  addresses: string[];
  /** Nombre de répondeurs distincts : plus d'un signale un nom disputé. */
  responders: number;
}

export type LlmnrDomainEvent =
  | { topic: 'llmnr.query.sent'; payload: LlmnrQuerySentPayload }
  | { topic: 'llmnr.responded'; payload: LlmnrRespondedPayload }
  | { topic: 'llmnr.resolved'; payload: LlmnrResolvedPayload };
