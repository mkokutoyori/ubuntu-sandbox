import type { CommandSpec } from '../../CommandTable';
import type { ArgumentSpec } from '../../ArgumentTypes';
import { TUNNEL_MODES, isTunnelMode, isTunnelModeHead } from './tunnelModes';
import { CliInvalidInput, CliIncomplete } from '../../../network/devices/shells/cli/CliDiagnostic';

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

function setter(
  id: string, keyword: string, field: string, description: string,
  argument: ArgumentSpec = { name: 'value', type: 'REST' },
): CommandSpec {
  return {
    id,
    path: ['tunnel', keyword, argument],
    description,
    modes: ['config-if', 'config-subif'],
    minPrivilege: 15,
    run: (session, args) => assign(session.device, field, args[argument.name]),
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

const MODE: CommandSpec = {
  id: 'tunnel-mode',
  path: ['tunnel', 'mode', {
    name: 'value', type: 'REST',
    description: 'Tunnel encapsulation mode',
    alternatives: TUNNEL_MODES.map(
      (m) => ({ keyword: m.keyword, description: m.description }),
    ),
  }],
  description: 'Set tunnel encapsulation mode',
  modes: ['config-if', 'config-subif'],
  minPrivilege: 15,
  run: (session, args) => {
    const mode = (args.value ?? '').trim();
    if (!isTunnelMode(mode)) {
      const tete = mode.split(/\s+/)[0];
      if (isTunnelModeHead(tete)) throw new CliIncomplete();
      throw new CliInvalidInput({ token: tete });
    }
    return assign(session.device, 'tunnelMode', mode);
  },
};

export const TUNNEL_FAMILY: readonly CommandSpec[] = Object.freeze([
  PATH_MTU_DISCOVERY,
  // `tunnel source` prend une adresse OU un nom d'interface : le socle
  // ne sait pas encore declarer une union, et annoncer une seule des deux
  // decrirait faux la moitie des usages. `WORD` dit ce qu'on sait.
  setter('tunnel-source', 'source', 'tunnelSource', 'Set tunnel source',
    { name: 'value', type: 'WORD' }),
  setter('tunnel-destination', 'destination', 'tunnelDest', 'Set tunnel destination',
    { name: 'value', type: 'IP_ADDR' }),
  MODE,
  setter('tunnel-key', 'key', 'tunnelKey', 'Set tunnel key',
    { name: 'value', type: 'INT', range: [0, 4294967295] }),
  setter('tunnel-vrf', 'vrf', 'tunnelVrf', 'Set tunnel VRF',
    { name: 'value', type: 'WORD' }),
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
