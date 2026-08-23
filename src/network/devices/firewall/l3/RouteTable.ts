import { tryIpToUint32 } from '../../../core/ip';
import type { ConnectedRoute } from './InterfaceTable';

export type RouteKind = 'connected' | 'static' | 'default' | 'dynamic';

export interface FirewallRoute {
  readonly network: string;
  readonly mask: string;
  readonly nextHop?: string;
  readonly iface: string;
  readonly kind: RouteKind;
  readonly distance: number;
  readonly priority: number;
  readonly metric?: number;
  readonly protocol?: string;
  readonly routeType?: string;
}

export interface ResolvedNextHop {
  readonly route: FirewallRoute;
  readonly nextHop: string;
  readonly iface: string;
}

export interface DeclaredStaticRoute {
  readonly id: string;
  readonly destination: string;
  readonly mask: string;
  readonly gateway: string;
  readonly iface: string;
  readonly distance: number;
  readonly priority: number;
  readonly blackhole: boolean;
  readonly enabled: boolean;
}

export interface StaticRouteOptions {
  distance?: number;
  priority?: number;
  metric?: number;
  iface?: string;
  id?: string;
  routeType?: string;
}

export interface RouteTableDeps {
  connectedRoutes: () => readonly ConnectedRoute[];
  interfaceForDestination?: (address: string) => string | undefined;
  isInterfaceUp?: (iface: string) => boolean;
}

interface StaticRecord {
  network: string;
  mask: string;
  nextHop?: string;
  iface?: string;
  distance: number;
  priority: number;
  metric?: number;
  isDefault: boolean;
  id?: string;
  routeType?: string;
}

const DEFAULT_STATIC_DISTANCE = 1;

export function sameRoute(a: FirewallRoute, b: FirewallRoute): boolean {
  return a.network === b.network && a.mask === b.mask
    && a.nextHop === b.nextHop && a.iface === b.iface
    && a.distance === b.distance && a.priority === b.priority;
}

function outranks(candidate: FirewallRoute, held: FirewallRoute): boolean {
  if (candidate.distance !== held.distance) return candidate.distance < held.distance;
  return candidate.priority < held.priority;
}

export class RouteTable {
  private readonly statics: StaticRecord[] = [];
  private readonly deps: RouteTableDeps;

  constructor(deps: RouteTableDeps) {
    this.deps = deps;
  }

  addStatic(
    network: string, mask: string, nextHop?: string, options: StaticRouteOptions = {},
  ): void {
    this.statics.push({
      network,
      mask,
      nextHop,
      iface: options.iface,
      distance: options.distance ?? DEFAULT_STATIC_DISTANCE,
      priority: options.priority ?? 0,
      metric: options.metric,
      isDefault: mask === '0.0.0.0' && network === '0.0.0.0',
      id: options.id,
      routeType: options.routeType,
    });
  }

  addDefault(nextHop?: string, options: StaticRouteOptions = {}): void {
    this.addStatic('0.0.0.0', '0.0.0.0', nextHop, options);
  }

  removeStatic(network: string, mask: string, nextHop?: string): boolean {
    const index = this.statics.findIndex(route =>
      route.network === network && route.mask === mask
      && (nextHop === undefined || route.nextHop === nextHop));
    if (index < 0) return false;

    this.statics.splice(index, 1);
    return true;
  }

  removeStaticsBySource(source: string): number {
    const prefix = `${source}:`;
    const before = this.statics.length;
    for (let index = this.statics.length - 1; index >= 0; index--) {
      if (this.statics[index].id?.startsWith(prefix)) this.statics.splice(index, 1);
    }
    return before - this.statics.length;
  }

  removeStaticById(id: string): boolean {
    const index = this.statics.findIndex(route => route.id === id);
    if (index < 0) return false;

    this.statics.splice(index, 1);
    return true;
  }

  clearStatics(): void {
    this.statics.length = 0;
  }

  lookup(destination: string): FirewallRoute | undefined {
    const value = tryIpToUint32(destination);
    if (value === null) return undefined;

    let best: FirewallRoute | undefined;
    let bestPrefix = -1;

    for (const route of this.selected()) {
      const mask = tryIpToUint32(route.mask);
      const network = tryIpToUint32(route.network);
      if (mask === null || network === null) continue;
      if (((value & mask) >>> 0) !== ((network & mask) >>> 0)) continue;

      const prefix = prefixBits(mask);
      if (prefix > bestPrefix
        || (prefix === bestPrefix && best !== undefined && route.distance < best.distance)) {
        best = route;
        bestPrefix = prefix;
      }
    }
    return best;
  }

  resolveNextHop(destination: string): ResolvedNextHop | undefined {
    const route = this.lookup(destination);
    if (!route) return undefined;

    return Object.freeze({
      route,
      nextHop: route.nextHop ?? destination,
      iface: route.iface,
    });
  }

  all(): readonly FirewallRoute[] {
    const routes: FirewallRoute[] = [...this.deps.connectedRoutes()];

    for (const route of this.statics) {
      const iface = this.egressInterface(route);
      if (iface === undefined) continue;
      routes.push(Object.freeze({
        network: route.network,
        mask: route.mask,
        nextHop: route.nextHop,
        iface,
        kind: kindOf(route),
        distance: route.distance,
        priority: route.priority,
        metric: route.metric,
        protocol: protocolOf(route),
        routeType: route.routeType,
      }));
    }
    return Object.freeze(routes);
  }

  selected(): readonly FirewallRoute[] {
    const best = new Map<string, FirewallRoute>();
    for (const route of this.all()) {
      const prefix = `${route.network}/${route.mask}`;
      const held = best.get(prefix);
      if (held === undefined || outranks(route, held)) best.set(prefix, route);
    }
    return Object.freeze([...best.values()]);
  }

  isSelected(route: FirewallRoute): boolean {
    return this.selected().some(kept => sameRoute(kept, route));
  }

  statics_(): readonly StaticRecord[] {
    return Object.freeze([...this.statics]);
  }

  private egressInterface(route: StaticRecord): string | undefined {
    if (route.iface !== undefined) {
      const up = this.deps.isInterfaceUp?.(route.iface);
      return up === false ? undefined : route.iface;
    }
    if (route.nextHop === undefined) return undefined;
    return this.connectedInterfaceFor(route.nextHop);
  }

  private connectedInterfaceFor(address: string): string | undefined {
    if (this.deps.interfaceForDestination) return this.deps.interfaceForDestination(address);

    const value = tryIpToUint32(address);
    if (value === null) return undefined;

    for (const connected of this.deps.connectedRoutes()) {
      const mask = tryIpToUint32(connected.mask);
      const network = tryIpToUint32(connected.network);
      if (mask === null || network === null) continue;
      if (((value & mask) >>> 0) === ((network & mask) >>> 0)) return connected.iface;
    }
    return undefined;
  }
}

function kindOf(route: StaticRecord): RouteKind {
  return protocolOf(route) === undefined
    ? (route.isDefault ? 'default' : 'static')
    : 'dynamic';
}

function protocolOf(route: StaticRecord): string | undefined {
  if (route.id?.startsWith('rip:')) return 'rip';
  if (route.id?.startsWith('ospf:')) return 'ospf';
  if (route.id?.startsWith('bgp:')) return 'bgp';
  return undefined;
}

function prefixBits(mask: number): number {
  let bits = 0;
  for (let i = 31; i >= 0; i--) {
    if ((mask & (1 << i)) === 0) break;
    bits++;
  }
  return bits;
}
