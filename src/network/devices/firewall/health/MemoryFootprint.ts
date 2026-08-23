import type { MemoryWorkload } from './SystemLoad';

export const SESSION_BYTES = 1440;
export const POLICY_BYTES = 2048;
export const ADDRESS_OBJECT_BYTES = 512;
export const SERVICE_OBJECT_BYTES = 384;
export const ROUTE_BYTES = 256;
export const ARP_ENTRY_BYTES = 128;

export interface VdomFootprintFacts {
  readonly sessions: number;
  readonly policies: number;
  readonly addresses: number;
  readonly services: number;
  readonly routes: number;
  readonly logReserveBytes: number;
  readonly logRecordBytes: number;
}

export function vdomFootprint(facts: VdomFootprintFacts): MemoryWorkload {
  return {
    usedBytes: facts.sessions * SESSION_BYTES
      + facts.policies * POLICY_BYTES
      + facts.addresses * ADDRESS_OBJECT_BYTES
      + facts.services * SERVICE_OBJECT_BYTES
      + facts.routes * ROUTE_BYTES
      + Math.max(facts.logReserveBytes, facts.logRecordBytes),
    freeableBytes: 0,
  };
}

export function cacheFootprint(arpEntries: number): MemoryWorkload {
  return { usedBytes: 0, freeableBytes: arpEntries * ARP_ENTRY_BYTES };
}
