import type { AddressObject } from '../model/AddressObject';
import type { ServiceObject } from '../model/ServiceObject';
import { ZoneTable } from '../model/ZoneTable';
import { ObjectStore } from '../model/ObjectStore';
import { PolicyStore } from '../model/PolicyStore';
import { NatPolicyStore } from '../nat/NatPolicyStore';
import { IpPoolAllocator } from '../nat/IpPool';
import type { RealServerPool } from '../nat/RealServerPool';
import { FirewallNatEngine } from '../nat/FirewallNatEngine';
import { RouteTable } from '../l3/RouteTable';
import { PolicyRouteTable } from '../l3/PolicyRouteTable';
import { SessionTable, type FirewallSession, type SessionCloseReason } from '../session/SessionTable';
import { PolicyEvaluator } from '../policy/PolicyEvaluator';
import { DosPolicyStore } from '../dos/DosPolicyStore';
import { DosSensor } from '../dos/DosSensor';
import { ScheduleStore } from '../model/ScheduleObject';
import { FirewallLogStore } from '../logging/FirewallLogStore';
import { UtmProfileStore } from '../inspection/UtmProfiles';
import { IdentityTable } from '../identity/IdentityTable';
import { UserDirectory } from '../identity/UserDirectory';
import { IpsecTunnelTable } from '../vpn/IpsecTunnelTable';
import { CertificateStore } from '../vpn/CertificateStore';
import { seedFactoryCertificates } from '../vpn/FactoryCertificates';
import { NetworkOsCredentialStore } from '../../router/aaa/NetworkOsCredentialStore';
import type { ConnectedRoute } from '../l3/InterfaceTable';
import type { IEventBus } from '../../../../events/EventBus';

export type DeploymentMode = 'nat' | 'transparent';

export interface VdomSettings {
  opmode: DeploymentMode;
  centralNat: boolean;
  manageIP?: string;
  manageMask?: string;
  gateway?: string;
}

export interface VdomContext {
  readonly name: string;
  readonly zones: ZoneTable;
  readonly objects: ObjectStore;
  readonly policy: PolicyStore;
  readonly localIn: PolicyStore;
  readonly localIn6: PolicyStore;
  readonly dos: DosPolicyStore;
  readonly dos6: DosPolicyStore;
  readonly dosSensor: DosSensor;
  readonly dosSensor6: DosSensor;
  readonly natPolicy: NatPolicyStore;
  readonly pools: IpPoolAllocator;
  readonly nat: FirewallNatEngine;
  readonly routes: RouteTable;
  readonly policyRoutes: PolicyRouteTable;
  readonly sessions: SessionTable;
  readonly evaluator: PolicyEvaluator;
  readonly schedules: ScheduleStore;
  readonly logs: FirewallLogStore;
  readonly utm: UtmProfileStore;
  readonly identities: IdentityTable;
  readonly users: UserDirectory;
  readonly tunnels: IpsecTunnelTable;
  readonly certificates: CertificateStore;
  readonly settings: VdomSettings;
}

export const ROOT_VDOM = 'root';

export interface VdomRegistryDeps {
  readonly now: () => number;
  readonly deviceId: string;
  readonly bus: () => IEventBus;
  readonly onTunnelInterface?: (vdom: string, tunnel: string, boundTo: string) => void;
  readonly onTunnelRemoved?: (vdom: string, tunnel: string) => void;
  readonly policyKeyedBy: 'zone' | 'interface';
  readonly implicitPolicy: 'deny-all' | 'security-level';
  readonly applicationShift: boolean;
  readonly maxGroupNesting: number;
  readonly resolveFqdn?: (fqdn: string) => readonly string[];
  readonly predefinedAddresses?: readonly AddressObject[];
  readonly predefinedServices?: readonly ServiceObject[];
  readonly connectedRoutes: (vdom: string) => readonly ConnectedRoute[];
  readonly interfaceForDestination: (vdom: string, address: string) => string | undefined;
  readonly isInterfaceUp: (iface: string) => boolean;
  readonly interfaceAddress: (iface: string) => string | undefined;
  readonly interfaceHasBoundPolicy: (iface: string) => boolean;
  readonly securityLevelOf: (vdom: string, zone: string) => number | undefined;
  readonly sameSecurityInterAllowed: () => boolean;
  readonly onSessionClosed: (
    vdom: string, session: FirewallSession, reason: SessionCloseReason) => void;
  readonly onSessionCountChanged?: (count: number, created: boolean) => void;
  readonly realServerPool?: (name: string) => RealServerPool | undefined;
}

export class VdomAssignedInterfacesError extends Error {
  constructor(readonly vdom: string, readonly interfaces: readonly string[]) {
    super(`vdom '${vdom}' still owns ${interfaces.join(', ')}`);
    this.name = 'VdomAssignedInterfacesError';
  }
}

export class VdomRegistry {
  private readonly contexts = new Map<string, VdomContext>();
  private readonly interfaceOwner = new Map<string, string>();

  constructor(private readonly deps: VdomRegistryDeps) {
    this.create(ROOT_VDOM);
  }

  create(name: string): VdomContext {
    const existing = this.contexts.get(name);
    if (existing) return existing;

    const created = this.build(name);
    this.contexts.set(name, created);
    return created;
  }

  get(name: string): VdomContext | undefined {
    return this.contexts.get(name);
  }

  require(name: string): VdomContext {
    return this.contexts.get(name) ?? this.create(name);
  }

  has(name: string): boolean {
    return this.contexts.has(name);
  }

  names(): readonly string[] {
    return Object.freeze([...this.contexts.keys()]);
  }

  all(): readonly VdomContext[] {
    return Object.freeze([...this.contexts.values()]);
  }

  remove(name: string): boolean {
    if (name === ROOT_VDOM || !this.contexts.has(name)) return false;

    const owned = this.interfacesOf(name);
    if (owned.length > 0) throw new VdomAssignedInterfacesError(name, owned);

    return this.contexts.delete(name);
  }

  assignInterface(iface: string, vdom: string): void {
    this.require(vdom);
    this.interfaceOwner.set(iface, vdom);
  }

  releaseInterface(iface: string): void {
    this.interfaceOwner.delete(iface);
  }

  vdomOfInterface(iface: string): string {
    return this.interfaceOwner.get(iface) ?? ROOT_VDOM;
  }

  interfacesOf(vdom: string): readonly string[] {
    const owned: string[] = [];
    for (const [iface, owner] of this.interfaceOwner) {
      if (owner === vdom) owned.push(iface);
    }
    return Object.freeze(owned);
  }

  contextOfInterface(iface: string): VdomContext {
    return this.require(this.vdomOfInterface(iface));
  }

  private build(name: string): VdomContext {
    const deps = this.deps;
    const settings: VdomSettings = { opmode: 'nat', centralNat: false };
    const zones = new ZoneTable();
    const objects = new ObjectStore({
      maxGroupNesting: deps.maxGroupNesting,
      resolveFqdn: (fqdn) => deps.resolveFqdn?.(fqdn) ?? [],
    });
    for (const object of deps.predefinedAddresses ?? []) objects.addAddress(object);
    for (const object of deps.predefinedServices ?? []) objects.addService(object);

    const policy = new PolicyStore();
    const localIn = new PolicyStore();
    const localIn6 = new PolicyStore();
    const dos = new DosPolicyStore();
    const dos6 = new DosPolicyStore();
    const natPolicy = new NatPolicyStore();
    const pools = new IpPoolAllocator(deps.now);
    const schedules = new ScheduleStore();

    const routes = new RouteTable({
      connectedRoutes: () => deps.connectedRoutes(name),
      interfaceForDestination: (address) => deps.interfaceForDestination(name, address),
      isInterfaceUp: (iface) => deps.isInterfaceUp(iface),
    });

    const sessions = new SessionTable({
      now: deps.now,
      onCreated: () => deps.onSessionCountChanged?.(sessions.count(), true),
      onClosed: (session, reason) => {
        deps.onSessionClosed(name, session, reason);
        deps.onSessionCountChanged?.(sessions.count(), false);
      },
    });

    const identities = new IdentityTable({ now: this.deps.now });

    const evaluator = new PolicyEvaluator({
      objects,
      userOf: (address) => identities.lookup(address)?.user,
      userGroupsOf: (user) => {
        for (const identity of identities.list()) {
          if (identity.user === user) return identity.groups;
        }
        return [];
      },
      policyKeyedBy: deps.policyKeyedBy,
      implicitPolicy: deps.implicitPolicy,
      applicationShift: deps.applicationShift,
      securityLevelOf: (zone) => deps.securityLevelOf(name, zone),
      interfaceHasBoundPolicy: deps.interfaceHasBoundPolicy,
      scheduleActive: (schedule, at) => schedules.activeAt(schedule, at),
      sameSecurityInterAllowed: deps.sameSecurityInterAllowed,
      now: deps.now,
    });

    const nat = new FirewallNatEngine({
      objects,
      policy: natPolicy,
      pools,
      interfaceAddress: deps.interfaceAddress,
    });
    if (deps.realServerPool) nat.setPoolResolver(deps.realServerPool);

    return Object.freeze({
      name,
      zones,
      objects,
      policy,
      localIn,
      localIn6,
      dos,
      dos6,
      dosSensor: new DosSensor({ now: deps.now, sessions: () => sessions.view() }),
      dosSensor6: new DosSensor({ now: deps.now, sessions: () => sessions.view() }),
      natPolicy,
      pools,
      nat,
      routes,
      policyRoutes: new PolicyRouteTable(),
      sessions,
      evaluator,
      schedules,
      logs: new FirewallLogStore(),
      utm: new UtmProfileStore(),
      identities,
      tunnels: new IpsecTunnelTable({
        now: this.deps.now,
        onInterfaceCreated: (tunnel, boundTo) =>
          this.deps.onTunnelInterface?.(name, tunnel, boundTo),
        onInterfaceRemoved: (tunnel) => this.deps.onTunnelRemoved?.(name, tunnel),
      }),
      certificates: buildCertificateStore(this.deps.now()),
      users: new UserDirectory({
        credentials: new NetworkOsCredentialStore({
          deviceId: `${this.deps.deviceId}:${name}`,
          bus: this.deps.bus(),
        }),
        now: this.deps.now,
      }),
      settings,
    });
  }
}

function buildCertificateStore(now: number): CertificateStore {
  const store = new CertificateStore();
  seedFactoryCertificates(store, now);
  return store;
}
