import type { CommandSpec } from '../../CommandTable';

export interface TunnelHost {
  selectedInterfaceName(): string | null;
  pendingInterfaceConfig(iface: string): Record<string, unknown>;
  onTunnelModeSet(iface: string, mode: string): void;
}

function host(device: unknown): TunnelHost | null {
  const candidate = device as TunnelHost | null;
  return typeof candidate?.selectedInterfaceName === 'function' ? candidate : null;
}

function assign(device: unknown, key: string, value: string): string {
  const target = host(device);
  const iface = target?.selectedInterfaceName();
  if (!target || !iface) return '';

  target.pendingInterfaceConfig(iface)[key] = value;
  if (key === 'tunnelMode') target.onTunnelModeSet(iface, value);
  return '';
}

function setter(id: string, keyword: string, field: string, description: string): CommandSpec {
  return {
    id,
    path: ['tunnel', keyword, { name: 'value', type: 'REST' }],
    description,
    modes: ['config-if', 'config-subif'],
    minPrivilege: 15,
    run: (session, args) => assign(session.device, field, args.value),
  };
}

export interface PathMtuDiscovery {
  enabled: boolean;
  ageTimer?: number;
  minMtu?: number;
}

export function parsePathMtuDiscovery(line: string): PathMtuDiscovery {
  const words = line.trim().split(/\s+/).filter(Boolean);
  const config: PathMtuDiscovery = { enabled: true };

  for (let index = 0; index < words.length; index++) {
    const next = words[index + 1];
    if (words[index] === 'age-timer' && next) config.ageTimer = parseInt(next, 10);
    if (words[index] === 'min-mtu' && next) config.minMtu = parseInt(next, 10);
  }
  return config;
}

const PATH_MTU_DISCOVERY: CommandSpec = {
  id: 'tunnel-path-mtu-discovery',
  path: ['tunnel', 'path-mtu-discovery', { name: 'options', type: 'REST', optional: true }],
  description: 'Enable tunnel path MTU discovery',
  modes: ['config-if', 'config-subif'],
  minPrivilege: 15,
  run: (session, args) => {
    const target = host(session.device);
    const iface = target?.selectedInterfaceName();
    if (!target || !iface) return '';

    target.pendingInterfaceConfig(iface).tunnelPathMtuDiscovery =
      parsePathMtuDiscovery(args.options ?? '');
    return '';
  },
};

export const TUNNEL_FAMILY: readonly CommandSpec[] = Object.freeze([
  PATH_MTU_DISCOVERY,
  setter('tunnel-source', 'source', 'tunnelSource', 'Set tunnel source'),
  setter('tunnel-destination', 'destination', 'tunnelDest', 'Set tunnel destination'),
  setter('tunnel-mode', 'mode', 'tunnelMode', 'Set tunnel encapsulation mode'),
  setter('tunnel-key', 'key', 'tunnelKey', 'Set tunnel key'),
  setter('tunnel-vrf', 'vrf', 'tunnelVrf', 'Set tunnel VRF'),
]);


export interface TunnelProtectionHost {
  selectedInterfaceName(): string | null;
  setTunnelProtection(iface: string, profile: string, shared: boolean): void;
  removeTunnelProtection(iface: string): void;
}

function protectionHost(device: unknown): TunnelProtectionHost | null {
  const candidate = device as TunnelProtectionHost | null;
  return typeof candidate?.setTunnelProtection === 'function' ? candidate : null;
}

export const TUNNEL_PROTECTION: CommandSpec = {
  id: 'tunnel-protection-ipsec-profile',
  path: ['tunnel', 'protection', 'ipsec', 'profile', { name: 'options', type: 'REST' }],
  description: 'Apply IPSec profile to tunnel',
  modes: ['config-if', 'config-subif'],
  minPrivilege: 15,
  run: (session, args) => {
    const target = protectionHost(session.device);
    const iface = target?.selectedInterfaceName();
    if (!target || !iface) return '% No interface selected';

    const words = args.options.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '% Incomplete command.';

    target.setTunnelProtection(iface, words[0], words.includes('shared'));
    return '';
  },
  undo: (session) => {
    const target = protectionHost(session.device);
    const iface = target?.selectedInterfaceName();
    if (!target || !iface) return '% No interface selected';

    target.removeTunnelProtection(iface);
    return '';
  },
};

export const ALL_TUNNEL: readonly CommandSpec[] = Object.freeze(
  [...TUNNEL_FAMILY, TUNNEL_PROTECTION],
);

export const TUNNEL_PATHS: readonly string[] = Object.freeze(
  ALL_TUNNEL.map(spec =>
    spec.path.filter((s): s is string => typeof s === 'string').join(' ')),
);
