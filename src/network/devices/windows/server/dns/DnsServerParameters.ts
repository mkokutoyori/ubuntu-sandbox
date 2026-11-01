import type { PSRegistryProvider, RegistryAddress, RegistryValueType } from '../../PSRegistryProvider';
import type { DnsCacheLimits } from '@/network/dns/resolver/DnsCache';

export type DnsParameterValue = string | number;

export interface DnsParameterStore {
  read(name: string): DnsParameterValue | undefined;
  write(name: string, type: RegistryValueType, value: DnsParameterValue): void;
}

const PARAMETERS_KEY = ['SYSTEM', 'CurrentControlSet', 'Services', 'DNS', 'Parameters'] as const;
const MULTI_SZ_SEPARATOR = '\\0';

export const DEFAULT_FORWARDING_TIMEOUT_SECONDS = 3;

export interface DnsCacheSettings {
  readonly maxTtlSeconds: number;
  readonly maxNegativeTtlSeconds: number;
  readonly maxKBSize: number;
  readonly pollutionProtection: boolean;
  readonly lockingPercent: number;
  readonly storeEmptyAuthenticationResponse: boolean;
  readonly ignorePolicies: boolean;
}

export const DEFAULT_CACHE_SETTINGS: DnsCacheSettings = {
  maxTtlSeconds: 86400,
  maxNegativeTtlSeconds: 900,
  maxKBSize: 0,
  pollutionProtection: true,
  lockingPercent: 100,
  storeEmptyAuthenticationResponse: true,
  ignorePolicies: false,
};

const KILOBYTE = 1024;
const MAX_LOCKING_PERCENT = 100;
const CACHE_SIZE_TARGET_PERCENT = 90;

export class RegistryDnsParameterStore implements DnsParameterStore {
  constructor(private readonly registry: PSRegistryProvider) {}

  read(name: string): DnsParameterValue | undefined {
    const values = this.registry.getItemPropertyValues(`HKLM\\${PARAMETERS_KEY.join('\\')}`) ?? {};
    return Object.entries(values).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  }

  write(name: string, type: RegistryValueType, value: DnsParameterValue): void {
    const address: RegistryAddress = { root: 'HKLM', segments: PARAMETERS_KEY, machine: null };
    this.registry.setValue(address, name, type, value);
  }
}

export class MemoryDnsParameterStore implements DnsParameterStore {
  private readonly values = new Map<string, DnsParameterValue>();

  read(name: string): DnsParameterValue | undefined {
    return this.values.get(name.toLowerCase());
  }

  write(name: string, _type: RegistryValueType, value: DnsParameterValue): void {
    this.values.set(name.toLowerCase(), value);
  }
}

export class DnsServerParameters {
  constructor(private readonly store: DnsParameterStore) {}

  private flag(name: string, fallback: boolean): boolean {
    const raw = this.store.read(name);
    return raw === undefined ? fallback : Number(raw) !== 0;
  }

  private count(name: string, fallback: number): number {
    const raw = this.store.read(name);
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  forwarders(): string[] {
    const raw = this.store.read('Forwarders');
    if (raw === undefined) return [];
    return String(raw).split(MULTI_SZ_SEPARATOR).map(address => address.trim()).filter(address => address !== '');
  }

  setForwarders(addresses: readonly string[]): void {
    this.store.write('Forwarders', 'MultiString', addresses.join(MULTI_SZ_SEPARATOR));
  }

  forwardingTimeoutSeconds(): number {
    return this.count('ForwardingTimeout', DEFAULT_FORWARDING_TIMEOUT_SECONDS);
  }

  setForwardingTimeoutSeconds(seconds: number): void {
    this.store.write('ForwardingTimeout', 'DWord', seconds);
  }

  usesRootHints(): boolean {
    return !this.flag('IsSlave', false);
  }

  setUsesRootHints(enabled: boolean): void {
    this.store.write('IsSlave', 'DWord', enabled ? 0 : 1);
  }

  recursionEnabled(): boolean {
    return !this.flag('NoRecursion', false);
  }

  setRecursionEnabled(enabled: boolean): void {
    this.store.write('NoRecursion', 'DWord', enabled ? 0 : 1);
  }

  reorderingEnabled(): boolean {
    return this.flag('EnableForwarderReordering', true);
  }

  cacheSettings(): DnsCacheSettings {
    const defaults = DEFAULT_CACHE_SETTINGS;
    return {
      maxTtlSeconds: this.count('MaxCacheTtl', defaults.maxTtlSeconds),
      maxNegativeTtlSeconds: this.count('MaxNegativeCacheTtl', defaults.maxNegativeTtlSeconds),
      maxKBSize: this.count('MaxCacheSize', defaults.maxKBSize),
      pollutionProtection: this.flag('SecureResponses', defaults.pollutionProtection),
      lockingPercent: Math.min(MAX_LOCKING_PERCENT, Math.max(0, this.count('CacheLockingPercent', defaults.lockingPercent))),
      storeEmptyAuthenticationResponse: this.flag('CacheEmptyAuthResponses', defaults.storeEmptyAuthenticationResponse),
      ignorePolicies: this.flag('IgnorePolicies', defaults.ignorePolicies),
    };
  }

  setCacheSettings(changes: Partial<DnsCacheSettings>): void {
    const dword = (name: string, value: number | boolean | undefined): void => {
      if (value !== undefined) this.store.write(name, 'DWord', typeof value === 'boolean' ? Number(value) : value);
    };
    dword('MaxCacheTtl', changes.maxTtlSeconds);
    dword('MaxNegativeCacheTtl', changes.maxNegativeTtlSeconds);
    dword('MaxCacheSize', changes.maxKBSize);
    dword('SecureResponses', changes.pollutionProtection);
    dword('CacheLockingPercent', changes.lockingPercent);
    dword('CacheEmptyAuthResponses', changes.storeEmptyAuthenticationResponse);
    dword('IgnorePolicies', changes.ignorePolicies);
  }

  cacheLimits(): DnsCacheLimits {
    const settings = this.cacheSettings();
    return {
      maxTtlSeconds: settings.maxTtlSeconds,
      maxNegativeTtlSeconds: settings.maxNegativeTtlSeconds,
      lockingPercent: settings.lockingPercent,
      storeEmptyAuthoritative: settings.storeEmptyAuthenticationResponse,
      maxBytes: settings.maxKBSize === 0 ? null : Math.floor(settings.maxKBSize * KILOBYTE * CACHE_SIZE_TARGET_PERCENT / MAX_LOCKING_PERCENT),
      admitsUnrelatedRecords: !settings.pollutionProtection,
    };
  }

  setReorderingEnabled(enabled: boolean): void {
    this.store.write('EnableForwarderReordering', 'DWord', enabled ? 1 : 0);
  }
}
