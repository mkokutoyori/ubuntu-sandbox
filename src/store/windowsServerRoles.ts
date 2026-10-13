import { WindowsServer } from '@/network/devices/WindowsServer';
import { certToPem, pemToCert, pemToPrivateKey, privateKeyToPem } from '@/network/pki/pem';
import { reserveCertificateSerial } from '@/network/pki/serialReservation';
import type { AppPoolInfo, IisStateDelta, WebsiteInfo } from '@/network/devices/windows/server/iis/WindowsIisRole';
import type {
  DnsDynamicUpdateMode, DnsTransferPolicy, DnsZoneInfo, DnsZoneType,
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
  iis?: IisStateDelta;
  adcs?: AdcsPersistedState;
  dhcp?: {
    scopes: DhcpScopeState[];
    exclusions: Array<{ start: string; end: string }>;
    serverOptions: Array<{ optionId: number; values: string[] }>;
  };
}

interface PemIdentity {
  certificate: string;
  privateKey: string;
}

interface AdcsPersistedState {
  caCommonName: string;
  ca: PemIdentity;
  issued: PemIdentity[];
}

interface RolePersister {
  capture(server: WindowsServer, twin: WindowsServer): Partial<WindowsServerRolesState>;
  restore(server: WindowsServer, state: WindowsServerRolesState): void;
}

const zoneState = (z: DnsZoneInfo): DnsZoneState => ({
  name: z.name, type: z.type, zoneFile: z.zoneFile, dynamicUpdate: z.dynamicUpdate,
  secureSecondaries: z.secureSecondaries, secondaryServers: z.secondaryServers,
  notify: z.notify, notifyServers: z.notifyServers, masters: z.masterServers,
});

const dnsZones: RolePersister = {
  capture(server, twin) {
    const role = server.getDnsServerRole();
    if (!role) return {};
    const factory = new Set((twin.getDnsServerRole()?.listZones() ?? []).map((z) => JSON.stringify(zoneState(z))));
    const zones = role.listZones()
      .filter((z) => !z.isDsIntegrated)
      .filter((z) => !factory.has(JSON.stringify(zoneState(z))))
      .map(zoneState);
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

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const differing = <T extends { name: string }>(live: readonly T[], factory: readonly T[]): T[] => {
  const baseline = new Map(factory.map((item) => [item.name, item]));
  return live.filter((item) => !same(item, baseline.get(item.name)));
};

const missing = <T extends { name: string }>(live: readonly T[], factory: readonly T[]): string[] => {
  const present = new Set(live.map((item) => item.name));
  return factory.map((item) => item.name).filter((name) => !present.has(name));
};

const iisSites: RolePersister = {
  capture(server, twin) {
    const role = server.getIisRole();
    if (!role) return {};
    const factory = twin.getIisRole();
    const liveSites: WebsiteInfo[] = role.listWebsites();
    const factorySites: WebsiteInfo[] = factory?.listWebsites() ?? [];
    const livePools: AppPoolInfo[] = role.listAppPools();
    const factoryPools: AppPoolInfo[] = factory?.listAppPools() ?? [];
    const delta: IisStateDelta = {
      sites: differing(liveSites, factorySites), removedSites: missing(liveSites, factorySites),
      appPools: differing(livePools, factoryPools), removedAppPools: missing(livePools, factoryPools),
    };
    return Object.values(delta).some((list) => list.length > 0) ? { iis: delta } : {};
  },
  restore(server, state) {
    if (state.iis) server.getIisRole()?.restoreState(state.iis);
  },
};

const adcsAuthority: RolePersister = {
  capture(server) {
    const state = server.getAdcsRole()?.exportState();
    if (!state) return {};
    return {
      adcs: {
        caCommonName: state.caCommonName,
        ca: { certificate: certToPem(state.caCertificate), privateKey: privateKeyToPem(state.caPrivateKey) },
        issued: state.issued.map((i) => ({ certificate: certToPem(i.cert), privateKey: privateKeyToPem(i.privateKey) })),
      },
    };
  },
  restore(server, state) {
    const role = server.getAdcsRole();
    const saved = state.adcs;
    if (!role || !saved) return;
    const caCertificate = pemToCert(saved.ca.certificate);
    const caPrivateKey = pemToPrivateKey(saved.ca.privateKey);
    if (!caCertificate || !caPrivateKey) return;
    const issued = saved.issued.flatMap((i) => {
      const cert = pemToCert(i.certificate);
      const privateKey = pemToPrivateKey(i.privateKey);
      return cert && privateKey ? [{ cert, privateKey }] : [];
    });
    for (const certificate of [caCertificate, ...issued.map((i) => i.cert)]) reserveCertificateSerial(certificate.serialNumber);
    role.restoreState({
      caCommonName: saved.caCommonName, caCertificate, caPrivateKey, issued,
    });
  },
};

const PERSISTERS: readonly RolePersister[] = [dnsZones, dhcpScopes, iisSites, adcsAuthority];

export function captureWindowsServerRoles(server: WindowsServer, twin: WindowsServer): WindowsServerRolesState | undefined {
  const state = Object.assign({}, ...PERSISTERS.map((p) => p.capture(server, twin))) as WindowsServerRolesState;
  return Object.keys(state).length > 0 ? state : undefined;
}

export function restoreWindowsServerRoles(server: WindowsServer, state: WindowsServerRolesState): void {
  for (const persister of PERSISTERS) persister.restore(server, state);
}
