import type { IpsecTunnelTable } from '../../../vpn/IpsecTunnelTable';

export function renderIpsecTunnelStats(tunnels: IpsecTunnelTable): string {
  const all = tunnels.all();
  const states = all.map(tunnel => tunnels.stateOf(tunnel.name));

  const selectors = all.flatMap(tunnel =>
    tunnels.selectorsOf(tunnel.name)
      .map(() => tunnels.stateOf(tunnel.name)?.status === 'up'));

  return [
    'tunnels',
    `total: ${all.length}`,
    `static/ddns: ${all.filter(t => t.type !== 'dynamic').length}`,
    `dynamic: ${all.filter(t => t.type === 'dynamic').length}`,
    'manual: 0',
    `errors: ${states.filter(state => state?.failure != null).length}`,
    'selectors',
    `total: ${selectors.length}`,
    `up: ${selectors.filter(Boolean).length}`,
  ].join('\n');
}
