import { WindowsServer } from '@/network/devices/WindowsServer';
import type {
  DnsDynamicUpdateMode, DnsTransferPolicy, DnsZoneType,
} from '@/network/devices/windows/server/dns/WindowsDnsServerRole';

interface DnsZoneState {
  name: string;
  type: DnsZoneType;
  zoneFile: string;
  dynamicUpdate: DnsDynamicUpdateMode;
  secureSecondaries: DnsTransferPolicy;
  secondaryServers: string[];
  notify: string;
  notifyServers: string[];
  masters: string[];
}

interface DhcpScopeState {
  name: string;
  startRange: string;
  endRange: string;
  subnetMask: string;
  leaseDuration: number;
  state: 'Active' | 'Inactive';
  reservations: Array<{ ipAddress: string; clientId: string }>;
  options: Array<{ optionId: number; values: string[] }>;
}

export interface WindowsServerRolesState {
  dnsZones?: DnsZoneState[];
  dhcp?: {
    scopes: DhcpScopeState[];
    exclusions: Array<{ start: string; end: string }>;
    serverOptions: Array<{ optionId: number; values: string[] }>;
  };
}

interface RolePersister {
  capture(server: WindowsServer): Partial<WindowsServerRolesState>;
  restore(server: WindowsServer, state: WindowsServerRolesState): void;
}

const dnsZones: RolePersister = {
  capture(server) {
    const role = server.getDnsServerRole();
    if (!role) return {};
    const zones = role.listZones()
      .filter((z) => !z.isDsIntegrated)
      .map((z): DnsZoneState => ({
        name: z.name, type: z.type, zoneFile: z.zoneFile, dynamicUpdate: z.dynamicUpdate,
        secureSecondaries: z.secureSecondaries, secondaryServers: z.secondaryServers,
        notify: z.notify, notifyServers: z.notifyServers, masters: z.masterServers,
      }));
    return zones.length > 0 ? { dnsZones: zones } : {};
  },
  restore(server, state) {
    const role = server.getDnsServerRole();
    if (!role) return;
    for (const zone of state.dnsZones ?? []) {
      if (zone.type === 'Primary') {
        role.addPrimaryZone(zone.name, { loadExisting: true, zoneFile: zone.zoneFile, dynamicUpdate: zone.dynamicUpdate });
        role.setPrimaryZone(zone.name, {
          secureSecondaries: zone.secureSecondaries, secondaryServers: zone.secondaryServers,
          notify: zone.notify as never, notifyServers: zone.notifyServers,
        });
      } else if (zone.type === 'Secondary') {
        role.addSecondaryZone(zone.name, zone.masters, zone.zoneFile, true);
      } else {
        role.addConditionalForwarderZone(zone.name, zone.masters, undefined, undefined, zone.zoneFile);
      }
    }
  },
};

const dhcpScopes: RolePersister = {
  capture(server) {
    const role = server.getDhcpServerRole();
    if (!role) return {};
    const scopes = role.listScopes().map((s): DhcpScopeState => ({
      name: s.name, startRange: s.startRange, endRange: s.endRange, subnetMask: s.subnetMask,
      leaseDuration: s.leaseDuration, state: s.state,
      reservations: role.listReservations(s.name).map((r) => ({ ipAddress: r.ipAddress, clientId: r.clientId })),
      options: role.listOptionValues(s.name).map((o) => ({ optionId: o.optionId, values: o.values })),
    }));
    const exclusions = role.listCustomExclusionRanges();
    const serverOptions = role.listOptionValues().map((o) => ({ optionId: o.optionId, values: o.values }));
    if (scopes.length + exclusions.length + serverOptions.length === 0) return {};
    return { dhcp: { scopes, exclusions, serverOptions } };
  },
  restore(server, state) {
    const role = server.getDhcpServerRole();
    if (!role || !state.dhcp) return;
    for (const o of state.dhcp.serverOptions) role.setOptionValue(undefined, o.optionId, o.values);
    for (const s of state.dhcp.scopes) {
      role.addScope(s.name, s.startRange, s.endRange, s.subnetMask, s.leaseDuration);
      for (const r of s.reservations) role.addReservation(s.name, r.ipAddress, r.clientId);
      for (const o of s.options) role.setOptionValue(s.name, o.optionId, o.values);
      if (s.state === 'Inactive') role.setScope(s.name, { state: 'Inactive' });
    }
    for (const r of state.dhcp.exclusions) role.addExclusionRange(r.start, r.end);
  },
};

const PERSISTERS: readonly RolePersister[] = [dnsZones, dhcpScopes];

export function captureWindowsServerRoles(server: WindowsServer): WindowsServerRolesState | undefined {
  const state = Object.assign({}, ...PERSISTERS.map((p) => p.capture(server))) as WindowsServerRolesState;
  return Object.keys(state).length > 0 ? state : undefined;
}

export function restoreWindowsServerRoles(server: WindowsServer, state: WindowsServerRolesState): void {
  for (const persister of PERSISTERS) persister.restore(server, state);
}
