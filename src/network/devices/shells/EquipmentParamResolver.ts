import type { DynamicCompletionContext, DynamicParamResolver } from './CommandTrie';

interface PortLike {
  getName(): string;
}

export interface CompletableDevice {
  getPorts?(): PortLike[];
  _getPortsInternal?(): Map<string, PortLike>;
  getVLANs?(): Map<number, unknown>;
  getAclIdentifiers?(): string[];
  getConfiguredIPv4Addresses?(): string[];
  getKnownHostnames?(): string[];
}

const INTERFACE_PATH_TAILS: ReadonlyArray<readonly string[]> = [
  ['interface'],
];

const VLAN_PATH_TAILS: ReadonlyArray<readonly string[]> = [
  ['vlan'],
];

const HOST_PATH_TAILS: ReadonlyArray<readonly string[]> = [
  ['ping'], ['traceroute'], ['tracert'], ['telnet'], ['ssh'],
];

const ACL_PATH_TAILS: ReadonlyArray<readonly string[]> = [
  ['access-group'], ['access-class'], ['access-lists'], ['acl'],
];

function pathEndsWith(path: readonly string[], tail: readonly string[]): boolean {
  if (path.length < tail.length) return false;
  for (let i = 0; i < tail.length; i++) {
    const fromPath = path[path.length - tail.length + i] ?? '';
    if (fromPath.toLowerCase() !== (tail[i] ?? '')) return false;
  }
  return true;
}

export class EquipmentParamResolver implements DynamicParamResolver {
  private readonly device: CompletableDevice;

  constructor(device: CompletableDevice) {
    this.device = device;
  }

  candidatesFor(context: DynamicCompletionContext): readonly string[] {
    if (this.isInterfacePosition(context)) {
      return this.portNames();
    }
    if (this.isVlanPosition(context)) {
      const vlans = this.device.getVLANs?.();
      if (!vlans) return [];
      return [...vlans.keys()].sort((a, b) => a - b).map(String);
    }
    if (this.isHostPosition(context)) {
      return [
        ...(this.device.getKnownHostnames?.() ?? []),
        ...(this.device.getConfiguredIPv4Addresses?.() ?? []),
      ];
    }
    if (this.isAclPosition(context)) {
      return this.device.getAclIdentifiers?.() ?? [];
    }
    return [];
  }

  private portNames(): readonly string[] {
    if (this.device.getPorts) {
      return this.device.getPorts().map((p) => p.getName());
    }
    if (this.device._getPortsInternal) {
      return [...this.device._getPortsInternal().values()].map((p) => p.getName());
    }
    return [];
  }

  private isInterfacePosition(context: DynamicCompletionContext): boolean {
    if (context.paramType === 'INTERFACE') return true;
    return INTERFACE_PATH_TAILS.some((tail) => pathEndsWith(context.path, tail));
  }

  private isVlanPosition(context: DynamicCompletionContext): boolean {
    if (context.paramType === 'VLAN_LIST') return true;
    return VLAN_PATH_TAILS.some((tail) => pathEndsWith(context.path, tail));
  }

  private isHostPosition(context: DynamicCompletionContext): boolean {
    if (context.paramType === 'IP_ADDR') return true;
    return HOST_PATH_TAILS.some((tail) => pathEndsWith(context.path, tail));
  }

  private isAclPosition(context: DynamicCompletionContext): boolean {
    return ACL_PATH_TAILS.some((tail) => pathEndsWith(context.path, tail));
  }
}
