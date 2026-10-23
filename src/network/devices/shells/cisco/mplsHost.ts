import type { Router } from '../../Router';
import type { MplsShellHost } from '@/cli/commands/mpls/mplsFamily';
import { resolveCiscoInterfaceName } from '../cli-utils';

export function mplsHostOf(router: Router, selectedInterfaces: () => string[] = () => []): MplsShellHost {
  return {
    present: () => router.hasMplsEngines(),
    mpls: () => router.getMplsEngine(),
    ldp: () => router.getLdpEngine(),
    pseudowires: () => router.getPseudowireEngine(),
    selectedInterfaces,
    interfaceNames: () => router.getPortNames(),
    interfaceIsUp: (name) => router.getPort(name)?.getIsUp() === true,
    setRouterIdSource: (iface, force) => router.setLdpRouterIdSource(iface, force),
    resolveInterface: (text) => resolveCiscoInterfaceName(router.getPortNames(), text),
    routerIdSourceText: () => {
      const source = router.getLdpEngine().routerIdSource;
      return source ? `${source.iface}${source.force ? ' force' : ''}` : null;
    },
    interfaceMtu: (name) => router.getPort(name)?.getMTU() ?? 1500,
    interfaceMac: (name) => router.getPort(name)?.getMAC().toString() ?? null,
    neighbourMac: (address) => router._getArpTableInternal().get(address)?.mac.toString() ?? null,
    vpnLocalLabels: () => {
      const lfib = router.getMplsEngine().lfib;
      return (router.getBGPEngine().vpnSpeaker()?.paths() ?? []).flatMap(path => {
        const entry = lfib.lookupIlm(path.label);
        return path.source === 'local' && entry?.kind === 'vrf'
          ? [{ label: path.label, network: path.network.toString(), length: path.prefixLength, vrf: entry.vrf }] : [];
      });
    },
  };
}
