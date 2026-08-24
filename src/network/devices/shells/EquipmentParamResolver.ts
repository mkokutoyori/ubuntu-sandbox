import type { DynamicCompletionContext, DynamicParamResolver } from './CommandTrie';

export interface SessionParamRanges {
  rangeFor(context: DynamicCompletionContext): readonly [number, number] | null;
}

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
  getKnownMacAddresses?(): string[];
}

/**
 * `show interfaces` est au PLURIEL, et c'est la commande la plus tapee
 * de toutes : la reconnaitre au seul singulier lui refusait toute
 * valeur vivante pendant que `show ip interface` — singulier — les
 * recevait, sur la meme machine et pour la meme question.
 */
const INTERFACE_PATH_TAILS: ReadonlyArray<readonly string[]> = [
  ['interface'],
  ['interfaces'],
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

const MAC_PATH_TAILS: ReadonlyArray<readonly string[]> = [
  ['mac-address'], ['static'], ['mac'],
];

/** Standard contiguous IPv4 masks (/8../30), the ones a `mask` prompt expects. */
const COMMON_SUBNET_MASKS: readonly string[] = [
  '255.0.0.0', '255.128.0.0', '255.192.0.0', '255.224.0.0', '255.240.0.0',
  '255.248.0.0', '255.252.0.0', '255.254.0.0', '255.255.0.0', '255.255.128.0',
  '255.255.192.0', '255.255.224.0', '255.255.240.0', '255.255.248.0',
  '255.255.252.0', '255.255.254.0', '255.255.255.0', '255.255.255.128',
  '255.255.255.192', '255.255.255.224', '255.255.255.240', '255.255.255.248',
  '255.255.255.252',
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
  private readonly sessionRanges: SessionParamRanges | null;

  constructor(device: CompletableDevice, sessionRanges: SessionParamRanges | null = null) {
    this.device = device;
    this.sessionRanges = sessionRanges;
  }

  rangeFor(context: DynamicCompletionContext): readonly [number, number] | null {
    return this.sessionRanges?.rangeFor(context) ?? null;
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
    if (this.isMacPosition(context)) {
      return this.device.getKnownMacAddresses?.() ?? [];
    }
    if (context.paramType === 'SUBNET_MASK') {
      return COMMON_SUBNET_MASKS;
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

  private isMacPosition(context: DynamicCompletionContext): boolean {
    if (context.paramType === 'MAC_ADDR') return true;
    return MAC_PATH_TAILS.some((tail) => pathEndsWith(context.path, tail));
  }
}
