import type { LegacyRecordProtection } from './legacy/legacyCrypto';
import type { Tls13Traffic } from './suite13';

export type TrafficProtection = string | Tls13Traffic | LegacyRecordProtection;
