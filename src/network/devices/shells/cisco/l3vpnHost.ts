import type { Router } from '../../Router';
import type { L3vpnShellHost, VrfShowHost } from '@/cli/commands/l3vpn/l3vpnFamily';
import type { VpnRow, VrfView } from '@/cli/commands/l3vpn/l3vpnShow';
import { bgpSummaryText } from './CiscoRoutingProtoCommands';
import { vrfStoreOf, type VrfHost } from './ciscoVrfStore';

const LOCAL_WEIGHT = 32768;

interface PortLookup {
  getPort(name: string): { getIPAddress(): { toString(): string } | null | undefined; getIsUp(): boolean } | undefined;
}

export function vrfShowHostOf(device: unknown): VrfShowHost {
  const host = device as VrfHost & PortLookup;
  return {
    vrfs: () => [...vrfStoreOf(host).values()].map((vrf, index) => ({
      name: vrf.name, rd: vrf.rd ?? null, tableId: index + 1, importRts: [...vrf.rts.import], exportRts: [...vrf.rts.export],
      interfaces: [...vrf.interfaces].map(name => ({
        name, address: host.getPort(name)?.getIPAddress()?.toString() ?? null, up: host.getPort(name)?.getIsUp() === true,
      })),
    })),
  };
}

export function l3vpnHostOf(router: Router): L3vpnShellHost {
  const vrfs = vrfShowHostOf(router).vrfs;
  return {
    vrfs,
    routerId: () => router.getBGPEngine().getRouterId(),
    tableVersion: () => router.getBGPEngine().vpnSpeaker()?.tableVersion() ?? 0,
    converge: () => router.convergeDynamicRouting(),
    vpnv4Summary: () => (router.getBGPEngine().isEnabled()
      ? bgpSummaryText(router.getBGPEngine(), neighbor => neighbor.vpnv4 === true,
        ip => router.getBGPEngine().vpnSpeaker()?.receivedCount(ip) ?? null) : '% BGP not active'),
    vpnRows: () => {
      const speaker = router.getBGPEngine().vpnSpeaker();
      if (speaker === null) return [];
      const best = new Set([...speaker.bestPaths().values()]);
      const names = new Map(vrfs().filter(vrf => vrf.rd !== null).map(vrf => [vrf.rd as string, vrf.name]));
      return speaker.paths().map((path): VpnRow => ({
        rd: path.rd, vrfName: names.get(path.rd) ?? null, network: path.network.toString(), prefixLength: path.prefixLength,
        nextHop: path.source === 'local' ? '0.0.0.0' : path.nextHop, metric: path.med, localPref: path.localPref,
        weight: path.source === 'local' ? LOCAL_WEIGHT : 0, asPath: path.asPath, origin: path.origin,
        internal: path.source === 'ibgp', best: best.has(path),
        inLabel: path.source === 'local' ? path.label.value : null, outLabel: path.source === 'local' ? null : path.label.value,
        routeTargets: path.routeTargets,
      })).sort((a, b) => (a.rd < b.rd ? -1 : a.rd > b.rd ? 1 : ipOrder(a.network) - ipOrder(b.network) || a.prefixLength - b.prefixLength));
    },
  };
}

function ipOrder(text: string): number {
  return text.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}
