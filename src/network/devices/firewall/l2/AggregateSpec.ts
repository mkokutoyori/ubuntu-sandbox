import type { LoadBalanceMethod } from '@/network/lacp/loadBalance';

export interface AggregateSpec {
  members: string[];
  lacpMode: 'static' | 'active' | 'passive';
  lacpSpeed: 'slow' | 'fast';
  algorithm: 'L2' | 'L3' | 'L4';
  lacpHaSecondary: boolean;
  minLinks: number;
  minLinksDown: 'operational' | 'administrative';
}

export function defaultAggregate(): AggregateSpec {
  return {
    members: [], lacpMode: 'active', lacpSpeed: 'slow', algorithm: 'L4', minLinks: 1, minLinksDown: 'operational', lacpHaSecondary: true,
  };
}

export function aggregateAlgorithmToLoadBalance(
  algorithm: AggregateSpec['algorithm'],
): LoadBalanceMethod {
  switch (algorithm) {
    case 'L2': return 'src-dst-mac';
    case 'L3': return 'src-dst-ip';
    default: return 'src-dst-port';
  }
}
