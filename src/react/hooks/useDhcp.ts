/**
 * DHCP hooks — client side reads `EndHost.getDHCPClient().observables`;
 * server side reads `Router._getDHCPServerInternal().observables`.
 */

import { useEngineSignal } from './useEngineSignal';
import type { Equipment } from '@/network/equipment/Equipment';
import type { DHCPClient } from '@/network/dhcp/DHCPClient';
import type { DHCPServer } from '@/network/dhcp/DHCPServer';
import type {
  DhcpClientIfaceVM, DhcpClientStatsVM,
  DhcpServerLeaseVM, DhcpServerStatsVM,
} from '@/network/dhcp/observables';

const EMPTY_ARRAY: ReadonlyArray<never> = [];
const EMPTY_CLIENT_STATS: DhcpClientStatsVM = {
  running: false, ifaceCount: 0, boundCount: 0,
  discoversSent: 0, offersReceived: 0,
  requestsSent: 0, acksReceived: 0, naksReceived: 0,
  leasesGranted: 0, leasesExpired: 0, leasesReleased: 0, conflicts: 0,
};
const EMPTY_SERVER_STATS: DhcpServerStatsVM = {
  running: false, poolCount: 0, activeLeases: 0, reservationsCount: 0,
};

function resolveDhcpClient(eq: Equipment): DHCPClient | null {
  const host = eq as unknown as { getDHCPClient?: () => DHCPClient };
  return host.getDHCPClient?.() ?? null;
}

function resolveDhcpServer(eq: Equipment): DHCPServer | null {
  const router = eq as unknown as { _getDHCPServerInternal?: () => DHCPServer };
  return router._getDHCPServerInternal?.() ?? null;
}

// ── Client hooks ───────────────────────────────────────────────────────

export function useDhcpClientIfaces(deviceId: string): ReadonlyArray<DhcpClientIfaceVM> {
  return useEngineSignal(deviceId, resolveDhcpClient, (e) => e.observables.ifaces, EMPTY_ARRAY);
}
export function useDhcpClientStats(deviceId: string): DhcpClientStatsVM {
  return useEngineSignal(deviceId, resolveDhcpClient, (e) => e.observables.stats, EMPTY_CLIENT_STATS);
}

// ── Server hooks ───────────────────────────────────────────────────────

export function useDhcpServerLeases(deviceId: string): ReadonlyArray<DhcpServerLeaseVM> {
  return useEngineSignal(deviceId, resolveDhcpServer, (e) => e.observables.leases, EMPTY_ARRAY);
}
export function useDhcpServerStats(deviceId: string): DhcpServerStatsVM {
  return useEngineSignal(deviceId, resolveDhcpServer, (e) => e.observables.stats, EMPTY_SERVER_STATS);
}
