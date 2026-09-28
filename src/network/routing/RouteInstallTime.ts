import type { IPAddress, SubnetMask } from '../core/types';

export interface InstalledRoute {
  readonly network: IPAddress;
  readonly mask: SubnetMask;
  readonly nextHop?: IPAddress | null;
  readonly iface?: string | null;
  readonly type: string;
  readonly ad?: number;
  readonly metric?: number;
  readonly routeType?: string;
  readonly installedAt?: number;
}

export function carriedInstallTime(
  previous: readonly InstalledRoute[], route: InstalledRoute,
): number | undefined {
  return previous.find((held) => held.type === route.type
    && held.network.equals(route.network)
    && held.mask.toCIDR() === route.mask.toCIDR()
    && String(held.nextHop ?? '') === String(route.nextHop ?? '')
    && (held.iface ?? '') === (route.iface ?? '')
    && held.ad === route.ad
    && held.metric === route.metric
    && (held.routeType ?? '') === (route.routeType ?? ''))?.installedAt;
}
