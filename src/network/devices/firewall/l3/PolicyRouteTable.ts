import { tryIpToUint32 } from '../../../core/ip';

export type PolicyRouteAction = 'permit' | 'deny';

export interface PolicyRoutePrefix {
  readonly network: string;
  readonly mask: string;
}

export interface PolicyRoute {
  readonly id: string;
  seq: number;
  enabled: boolean;
  action: PolicyRouteAction;
  inputDevices: string[];
  sourcePrefixes: PolicyRoutePrefix[];
  destinationPrefixes: PolicyRoutePrefix[];
  protocol: number;
  startPort: number;
  endPort: number;
  startSourcePort: number;
  endSourcePort: number;
  outputDevice?: string;
  gateway?: string;
  comment?: string;
  hitCount: number;
  lastUsedAt: number | null;
}

export interface PolicyRouteDraft {
  id: string;
  enabled?: boolean;
  action?: PolicyRouteAction;
  inputDevices?: readonly string[];
  sourcePrefixes?: readonly PolicyRoutePrefix[];
  destinationPrefixes?: readonly PolicyRoutePrefix[];
  protocol?: number;
  startPort?: number;
  endPort?: number;
  startSourcePort?: number;
  endSourcePort?: number;
  outputDevice?: string;
  gateway?: string;
  comment?: string;
}

export interface PolicyRouteProbe {
  readonly ingressInterface: string;
  readonly sourceIP: string;
  readonly destinationIP: string;
  readonly protocol: number;
  readonly sourcePort: number;
  readonly destinationPort: number;
}

export interface PolicyRouteDecision {
  readonly route: PolicyRoute;
  readonly action: PolicyRouteAction;
  readonly outputDevice?: string;
  readonly gateway?: string;
}

const ANY_PORT_TO = 65535;

export interface PolicyRouteTableOptions {
  readonly now?: () => number;
}

export class PolicyRouteTable {
  private routes: PolicyRoute[] = [];
  private readonly now: () => number;

  constructor(options: PolicyRouteTableOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  upsert(draft: PolicyRouteDraft, position = -1): void {
    this.remove(draft.id);

    const route: PolicyRoute = {
      id: draft.id,
      seq: 0,
      enabled: draft.enabled ?? true,
      action: draft.action ?? 'permit',
      inputDevices: [...(draft.inputDevices ?? [])],
      sourcePrefixes: [...(draft.sourcePrefixes ?? [])],
      destinationPrefixes: [...(draft.destinationPrefixes ?? [])],
      protocol: draft.protocol ?? 0,
      startPort: draft.startPort ?? 0,
      endPort: draft.endPort ?? ANY_PORT_TO,
      startSourcePort: draft.startSourcePort ?? 0,
      endSourcePort: draft.endSourcePort ?? ANY_PORT_TO,
      outputDevice: draft.outputDevice,
      gateway: draft.gateway,
      comment: draft.comment,
      hitCount: 0,
      lastUsedAt: null,
    };

    if (position < 0 || position >= this.routes.length) this.routes.push(route);
    else this.routes.splice(position, 0, route);
    this.renumber();
  }

  remove(id: string): boolean {
    const index = this.routes.findIndex(route => route.id === id);
    if (index < 0) return false;

    this.routes.splice(index, 1);
    this.renumber();
    return true;
  }

  clear(): void {
    this.routes = [];
  }

  clearCounters(id?: string): void {
    for (const route of this.routes) {
      if (id !== undefined && route.id !== id) continue;
      route.hitCount = 0;
      route.lastUsedAt = null;
    }
  }

  byId(id: string): PolicyRoute | undefined {
    return this.routes.find(route => route.id === id);
  }

  ordered(): readonly PolicyRoute[] {
    return Object.freeze([...this.routes]);
  }

  size(): number {
    return this.routes.length;
  }

  evaluate(probe: PolicyRouteProbe): PolicyRouteDecision | undefined {
    for (const route of this.routes) {
      if (!route.enabled) continue;
      if (!this.matches(route, probe)) continue;

      route.hitCount++;
      route.lastUsedAt = this.now();
      return Object.freeze({
        route,
        action: route.action,
        outputDevice: route.outputDevice,
        gateway: route.gateway,
      });
    }
    return undefined;
  }

  private matches(route: PolicyRoute, probe: PolicyRouteProbe): boolean {
    if (route.inputDevices.length > 0
      && !route.inputDevices.includes(probe.ingressInterface)) return false;
    if (!prefixesMatch(route.sourcePrefixes, probe.sourceIP)) return false;
    if (!prefixesMatch(route.destinationPrefixes, probe.destinationIP)) return false;
    if (route.protocol !== 0 && route.protocol !== probe.protocol) return false;

    if (route.protocol !== 6 && route.protocol !== 17) return true;
    if (probe.destinationPort < route.startPort
      || probe.destinationPort > route.endPort) return false;
    return probe.sourcePort >= route.startSourcePort
      && probe.sourcePort <= route.endSourcePort;
  }

  private renumber(): void {
    this.routes.forEach((route, index) => { route.seq = index + 1; });
  }
}

function prefixesMatch(prefixes: readonly PolicyRoutePrefix[], address: string): boolean {
  if (prefixes.length === 0) return true;

  const value = tryIpToUint32(address);
  if (value === null) return false;

  return prefixes.some(prefix => {
    const network = tryIpToUint32(prefix.network);
    const mask = tryIpToUint32(prefix.mask);
    if (network === null || mask === null) return false;
    return ((value & mask) >>> 0) === ((network & mask) >>> 0);
  });
}
