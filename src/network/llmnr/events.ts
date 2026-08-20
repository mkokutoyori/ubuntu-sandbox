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
  /** Le bit C de la réponse : le nom est connu comme disputé. */
  conflict: boolean;
}

export interface LlmnrConflictPayload extends LlmnrDeviceRef {
  name: string;
  /** Les adresses des autres hôtes qui revendiquent le même nom. */
  claimedBy: string[];
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
  | { topic: 'llmnr.resolved'; payload: LlmnrResolvedPayload }
  | { topic: 'llmnr.conflict.detected'; payload: LlmnrConflictPayload };
