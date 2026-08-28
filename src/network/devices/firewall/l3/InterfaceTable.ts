import {
  inSameSubnet,
  networkAddress,
  prefixLengthToMaskUint32,
  tryIpToUint32,
  uint32ToIp,
} from '../../../core/ip';
import { IPAddress, SubnetMask } from '../../../core/types';

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
  readonly priority: 0;
}

export interface InterfacePort {
  getIPAddress(): IPAddress | null;
  getSubnetMask(): SubnetMask | null;
  configureIP(ip: IPAddress, mask: SubnetMask): void;
  clearIP(): void;
  getMTU(): number;
  setMTU(mtu: number): void;
  getIsUp(): boolean;
  setAdminShutdown(down: boolean): void;
  getDescriptionText(): string;
  setDescriptionText(text: string): void;
}

export type InterfacePortLookup = (name: string) => InterfacePort | undefined;

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
  private readonly portOf: InterfacePortLookup;

  constructor(portOf: InterfacePortLookup = () => undefined) {
    this.portOf = portOf;
  }

  configure(name: string, config: InterfaceConfig): void {
    const existing = this.read(name);
    const mask = config.mask ?? (config.prefixLength !== undefined
      ? uint32ToIp(prefixLengthToMaskUint32(config.prefixLength))
      : existing?.mask);

    const record: InterfaceRecord = {
      name,
      ip: config.ip ?? existing?.ip,
      mask,
      up: config.up ?? existing?.up ?? true,
      mtu: config.mtu ?? existing?.mtu ?? DEFAULT_MTU,
      description: config.description ?? existing?.description,
    };

    this.interfaces.set(name, record);
    this.project(name, record);
  }

  remove(name: string): boolean {
    this.portOf(name)?.clearIP();
    return this.interfaces.delete(name);
  }

  setUp(name: string, up: boolean): void {
    const record = this.interfaces.get(name);
    if (!record) return;
    record.up = up;
    this.portOf(name)?.setAdminShutdown(!up);
  }

  isUp(name: string): boolean {
    return this.read(name)?.up ?? false;
  }

  get(name: string): L3Interface | undefined {
    const record = this.read(name);
    return record ? Object.freeze({ ...record }) : undefined;
  }

  names(): readonly string[] {
    return Object.freeze([...this.interfaces.keys()]);
  }

  all(): readonly L3Interface[] {
    return Object.freeze([...this.interfaces.keys()]
      .map(name => Object.freeze({ ...(this.read(name) as InterfaceRecord) })));
  }

  owningInterface(address: string): string | undefined {
    const value = tryIpToUint32(address);
    if (value === null) return undefined;

    for (const iface of this.records()) {
      if (iface.ip !== undefined && tryIpToUint32(iface.ip) === value) return iface.name;
    }
    return undefined;
  }

  interfaceForDestination(address: string): string | undefined {
    if (tryIpToUint32(address) === null) return undefined;

    for (const iface of this.records()) {
      if (!iface.up || iface.ip === undefined || iface.mask === undefined) continue;
      if (inSameSubnet(address, iface.ip, iface.mask)) return iface.name;
    }
    return undefined;
  }

  connectedRoutes(): readonly ConnectedRoute[] {
    const routes: ConnectedRoute[] = [];
    for (const iface of this.records()) {
      if (!iface.up || iface.ip === undefined || iface.mask === undefined) continue;
      routes.push(Object.freeze({
        network: networkAddress(iface.ip, iface.mask),
        mask: iface.mask,
        iface: iface.name,
        kind: 'connected' as const,
        distance: 0 as const,
        priority: 0 as const,
      }));
    }
    return Object.freeze(routes);
  }

  private *records(): Generator<InterfaceRecord> {
    for (const name of this.interfaces.keys()) yield this.read(name) as InterfaceRecord;
  }

  private read(name: string): InterfaceRecord | undefined {
    const record = this.interfaces.get(name);
    if (!record) return undefined;

    const port = this.portOf(name);
    if (!port) return record;

    const description = port.getDescriptionText();
    return {
      name,
      ip: port.getIPAddress()?.toString(),
      mask: port.getSubnetMask()?.toString(),
      up: port.getIsUp(),
      mtu: port.getMTU(),
      description: description === '' ? undefined : description,
    };
  }

  private project(name: string, record: InterfaceRecord): void {
    const port = this.portOf(name);
    if (!port) return;

    this.projectAddress(port, record);

    if (record.mtu !== port.getMTU()) port.setMTU(record.mtu);
    if (record.up !== port.getIsUp()) port.setAdminShutdown(!record.up);

    const description = record.description ?? '';
    if (description !== port.getDescriptionText()) port.setDescriptionText(description);
  }

  private projectAddress(port: InterfacePort, record: InterfaceRecord): void {
    if (record.ip === undefined || record.mask === undefined) {
      port.clearIP();
      return;
    }
    if (tryIpToUint32(record.ip) === null || tryIpToUint32(record.mask) === null) return;
    if (port.getIPAddress()?.toString() === record.ip
      && port.getSubnetMask()?.toString() === record.mask) return;

    port.configureIP(new IPAddress(record.ip), new SubnetMask(record.mask));
  }
}
