import type { PSRegistryProvider, RegistryAddress, RegistryValueType } from '../../PSRegistryProvider';

export type DnsParameterValue = string | number;

export interface DnsParameterStore {
  read(name: string): DnsParameterValue | undefined;
  write(name: string, type: RegistryValueType, value: DnsParameterValue): void;
}

const PARAMETERS_KEY = ['SYSTEM', 'CurrentControlSet', 'Services', 'DNS', 'Parameters'] as const;
const MULTI_SZ_SEPARATOR = '\\0';

export const DEFAULT_FORWARDING_TIMEOUT_SECONDS = 3;

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

  setReorderingEnabled(enabled: boolean): void {
    this.store.write('EnableForwarderReordering', 'DWord', enabled ? 1 : 0);
  }
}
