import {
  inSameSubnet,
  networkAddress,
  prefixLengthToMaskUint32,
  tryIpToUint32,
  uint32ToIp,
} from '../../../core/ip';

export interface L3Interface {
  readonly name: string;
  readonly ip?: string;
  readonly mask?: string;
  readonly up: boolean;
  readonly mtu: number;
  readonly description?: string;
}

export interface InterfaceConfig {
  ip?: string;
  mask?: string;
  prefixLength?: number;
  mtu?: number;
  description?: string;
  up?: boolean;
}

export interface ConnectedRoute {
  readonly network: string;
  readonly mask: string;
  readonly iface: string;
  readonly kind: 'connected';
  readonly distance: 0;
}

const DEFAULT_MTU = 1500;

interface InterfaceRecord {
  name: string;
  ip?: string;
  mask?: string;
  up: boolean;
  mtu: number;
  description?: string;
}

export class InterfaceTable {
  private readonly interfaces = new Map<string, InterfaceRecord>();

  configure(name: string, config: InterfaceConfig): void {
    const existing = this.interfaces.get(name);
    const mask = config.mask ?? (config.prefixLength !== undefined
      ? uint32ToIp(prefixLengthToMaskUint32(config.prefixLength))
      : existing?.mask);

    this.interfaces.set(name, {
      name,
      ip: config.ip ?? existing?.ip,
      mask,
      up: config.up ?? existing?.up ?? true,
      mtu: config.mtu ?? existing?.mtu ?? DEFAULT_MTU,
      description: config.description ?? existing?.description,
    });
  }

  remove(name: string): boolean {
    return this.interfaces.delete(name);
  }

  setUp(name: string, up: boolean): void {
    const iface = this.interfaces.get(name);
    if (iface) iface.up = up;
  }

  isUp(name: string): boolean {
    return this.interfaces.get(name)?.up ?? false;
  }

  get(name: string): L3Interface | undefined {
    const iface = this.interfaces.get(name);
    return iface ? Object.freeze({ ...iface }) : undefined;
  }

  names(): readonly string[] {
    return Object.freeze([...this.interfaces.keys()]);
  }

  all(): readonly L3Interface[] {
    return Object.freeze([...this.interfaces.values()].map(i => Object.freeze({ ...i })));
  }

  owningInterface(address: string): string | undefined {
    const value = tryIpToUint32(address);
    if (value === null) return undefined;

    for (const iface of this.interfaces.values()) {
      if (iface.ip !== undefined && tryIpToUint32(iface.ip) === value) return iface.name;
    }
    return undefined;
  }

  interfaceForDestination(address: string): string | undefined {
    if (tryIpToUint32(address) === null) return undefined;

    for (const iface of this.interfaces.values()) {
      if (!iface.up || iface.ip === undefined || iface.mask === undefined) continue;
      if (inSameSubnet(address, iface.ip, iface.mask)) return iface.name;
    }
    return undefined;
  }

  connectedRoutes(): readonly ConnectedRoute[] {
    const routes: ConnectedRoute[] = [];
    for (const iface of this.interfaces.values()) {
      if (!iface.up || iface.ip === undefined || iface.mask === undefined) continue;
      routes.push(Object.freeze({
        network: networkAddress(iface.ip, iface.mask),
        mask: iface.mask,
        iface: iface.name,
        kind: 'connected' as const,
        distance: 0 as const,
      }));
    }
    return Object.freeze(routes);
  }
}
