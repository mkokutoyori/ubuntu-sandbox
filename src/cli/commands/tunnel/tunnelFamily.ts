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

export const TUNNEL_FAMILY: readonly CommandSpec[] = Object.freeze([
  setter('tunnel-source', 'source', 'tunnelSource', 'Set tunnel source'),
  setter('tunnel-destination', 'destination', 'tunnelDest', 'Set tunnel destination'),
  setter('tunnel-mode', 'mode', 'tunnelMode', 'Set tunnel encapsulation mode'),
  setter('tunnel-key', 'key', 'tunnelKey', 'Set tunnel key'),
  setter('tunnel-vrf', 'vrf', 'tunnelVrf', 'Set tunnel VRF'),
]);

export const TUNNEL_PATHS: readonly string[] = Object.freeze(
  TUNNEL_FAMILY.map(spec =>
    spec.path.filter((s): s is string => typeof s === 'string').join(' ')),
);
