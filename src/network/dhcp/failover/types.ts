export type FailoverMode = 'LoadBalance' | 'HotStandby';
export type FailoverRole = 'Active' | 'Standby';
export type FailoverState =
  'Startup' | 'Normal' | 'CommunicationInterrupted' | 'PartnerDown' | 'RecoverWait' | 'Recover';

export interface FailoverBinding {
  readonly ip: string;
  readonly clientId: string;
  readonly hostName?: string;
  readonly leaseStart: number;
  readonly leaseExpiration: number;
  readonly scope: string;
  readonly type: 'automatic' | 'manual';
}

export interface FailoverScopeData {
  readonly name: string;
  readonly startRange: string;
  readonly endRange: string;
  readonly subnetMask: string;
  readonly leaseDuration: number;
  readonly state: 'Active' | 'Inactive';
  readonly options: Readonly<Record<number, readonly string[]>>;
  readonly exclusions: readonly { start: string; end: string }[];
  readonly reservations: readonly { ip: string; clientId: string }[];
}

export interface FailoverConfig {
  readonly name: string;
  readonly mode: FailoverMode;
  readonly localIsPrimary: boolean;
  readonly primaryAddress: string;
  readonly primaryName: string;
  readonly secondaryAddress: string;
  readonly secondaryName: string;
  readonly loadBalancePercent: number;
  readonly primaryRole: FailoverRole;
  readonly reservePercent: number;
  readonly maxClientLeadTimeSeconds: number;
  readonly autoStateTransition: boolean;
  readonly stateSwitchIntervalSeconds: number;
  readonly sharedSecret: string | null;
  readonly scopes: readonly string[];
}

export interface FailoverInfo extends FailoverConfig {
  readonly state: FailoverState;
  readonly partnerAddress: string;
  readonly partnerName: string;
  readonly lastContactMs: number | null;
}

export type FailoverOpResult = { ok: boolean; message: string };

export const CONTACT_INTERVAL_MS = 10_000;
export const CONTACT_TIMEOUT_MS = 30_000;
export const DEFAULT_LOAD_BALANCE_PERCENT = 50;
export const DEFAULT_RESERVE_PERCENT = 5;
export const DEFAULT_MCLT_SECONDS = 3600;
export const DEFAULT_STATE_SWITCH_SECONDS = 3600;

export function partnerOf(config: FailoverConfig): { address: string; name: string } {
  return config.localIsPrimary
    ? { address: config.secondaryAddress, name: config.secondaryName }
    : { address: config.primaryAddress, name: config.primaryName };
}
