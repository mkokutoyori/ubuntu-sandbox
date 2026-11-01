import { IPAddress, SubnetMask } from '@/network/core/types';

export const PROJECT_NAME = 'DNS - Agence bancaire (Banque Horizon)';

export const PUBLIC_LABEL = 'banquehorizon';
export const PUBLIC_DOMAIN = `${PUBLIC_LABEL}.com`;
export const INTERNAL_DOMAIN = 'horizon.local';

export interface HostPlan {
  readonly name: string;
  readonly address: IPAddress;
  readonly mask: SubnetMask;
  readonly gateway: IPAddress | null;
}

const host = (name: string, address: string, prefix: number, gateway: string | null): HostPlan => ({
  name,
  address: new IPAddress(address),
  mask: SubnetMask.fromCIDR(prefix),
  gateway: gateway === null ? null : new IPAddress(gateway),
});

export const PLAN = {
  rootNs: host('ROOT-NS', '198.51.100.1', 24, '198.51.100.254'),
  tldNs: host('TLD-NS', '198.51.100.2', 24, '198.51.100.254'),
  ns1Bank: host('NS1-BANK', '203.0.113.10', 24, '203.0.113.254'),
  ns2Bank: host('NS2-BANK', '203.0.113.11', 24, '203.0.113.254'),
  webBank: host('WEB-BANK', '203.0.113.20', 24, '203.0.113.254'),
  dc1: host('DC1', '10.20.20.10', 24, '10.20.20.1'),
  dnsRes: host('DNS-RES', '10.20.20.53', 24, '10.20.20.1'),
  ispInfra: new IPAddress('198.51.100.254'),
  ispHosting: new IPAddress('203.0.113.254'),
  ispAgencyLink: new IPAddress('192.0.2.1'),
  agencyWan: new IPAddress('192.0.2.2'),
  agencyPostes: new IPAddress('10.20.10.1'),
  agencyServeurs: new IPAddress('10.20.20.1'),
} as const;

export const SERIAL = 2026103101;
