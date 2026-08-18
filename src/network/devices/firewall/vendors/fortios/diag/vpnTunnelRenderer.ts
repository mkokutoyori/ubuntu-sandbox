import type {
  IpsecTunnelTable, Phase1Tunnel, Phase2Tunnel,
} from '../../../vpn/IpsecTunnelTable';
import { renderProposal } from '../../../vpn/IpsecProposals';

export function renderVpnTunnelList(tunnels: IpsecTunnelTable, now: number): string {
  const all = tunnels.all();
  if (all.length === 0) return '';

  const blocks = all.map(tunnel => renderTunnel(tunnels, tunnel, now));
  return blocks.join('\n------------------------------------------------------\n');
}

export function renderVpnTunnelSummary(tunnels: IpsecTunnelTable): string {
  const lines = tunnels.all().map(tunnel => {
    const state = tunnels.stateOf(tunnel.name);
    return `${tunnel.name}\t${tunnel.remoteGateway}\t${state?.status ?? 'down'}`;
  });
  return lines.join('\n');
}

function renderTunnel(
  tunnels: IpsecTunnelTable, tunnel: Phase1Tunnel, now: number,
): string {
  const state = tunnels.stateOf(tunnel.name);
  const selectors = tunnels.selectorsOf(tunnel.name);
  const serial = state?.serial ?? 1;

  const lines: string[] = [
    `name=${tunnel.name} ver=${tunnel.ikeVersion} serial=${serial} `
    + `0.0.0.0:0->${tunnel.remoteGateway}:0`,
    `bound_if=${tunnel.boundInterface} lgwy=static/1 tun=intf mode=auto/1 encap=none/yes`,
    `proxyid_num=${selectors.length} child_num=${selectors.length} refcnt=1 ilast=`
    + `${sinceSeconds(state?.lastInboundAt, now)} olast=`
    + `${sinceSeconds(state?.lastOutboundAt, now)}`,
    `stat: rxp=${state?.counters.receivedPackets ?? 0} `
    + `txp=${state?.counters.sentPackets ?? 0} `
    + `rxb=${state?.counters.receivedBytes ?? 0} `
    + `txb=${state?.counters.sentBytes ?? 0}`,
    `dpd: mode=${tunnel.dpd} on=${tunnel.dpd === 'disable' ? 0 : 1} `
    + `idle=5000ms retry=3 count=0`,
    `natt: mode=${tunnel.natTraversal === 'disable' ? 'none' : 'silent'} `
    + 'draft=0 interval=0 remote_port=0',
  ];

  for (const selector of selectors) {
    lines.push(...renderSelector(selector, tunnel, state?.status ?? 'down'));
  }

  return lines.join('\n');
}

function renderSelector(
  selector: Phase2Tunnel, tunnel: Phase1Tunnel, status: string,
): string[] {
  const proposals = selector.proposals.map(renderProposal).join('/') || 'aes256-sha256';

  return [
    `proxyid=${selector.name} proto=0 sa=${status === 'up' ? 1 : 0} `
    + `ref=1 serial=1${selector.autoNegotiate ? ' auto-negotiate' : ''}`,
    `  src: 0:${selector.sourceSubnet}/${selector.sourceMask}:0`,
    `  dst: 0:${selector.destinationSubnet}/${selector.destinationMask}:0`,
    `  ${status === 'up' ? 'SA:' : 'SA: no security association'} `
    + `life=${selector.keyLifeSeconds} pfs=${selector.pfs ? 'enabled' : 'disabled'} `
    + `dh=${selector.dhGroups.join(',') || tunnel.dhGroups.join(',')} enc=${proposals}`,
  ];
}

function sinceSeconds(at: number | null | undefined, now: number): number {
  if (at === null || at === undefined) return 0;
  return Math.max(0, Math.floor((now - at) / 1000));
}
