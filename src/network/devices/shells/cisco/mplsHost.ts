import type { Router } from '../../Router';
import type { MplsShellHost } from '@/cli/commands/mpls/mplsFamily';
import { resolveCiscoInterfaceName } from '../cli-utils';

export interface MplsShellSelection {
  readonly selectedInterfaces: () => string[];
  readonly pseudowireClass: { get(): string | null; set(name: string | null): void };
  readonly vfi: { get(): string | null; set(name: string | null): void };
}

const NO_SELECTION: MplsShellSelection = {
  selectedInterfaces: () => [],
  pseudowireClass: { get: () => null, set: () => undefined },
  vfi: { get: () => null, set: () => undefined },
};

export function mplsHostOf(router: Router, selection: MplsShellSelection = NO_SELECTION): MplsShellHost {
  const { selectedInterfaces } = selection;
  return {
    vpls: () => router.getVplsEngine(),
    selectedPseudowireClass: () => selection.pseudowireClass.get(),
    selectPseudowireClass: name => selection.pseudowireClass.set(name),
    selectedVfi: () => selection.vfi.get(),
    selectVfi: name => selection.vfi.set(name),
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
    oam: () => router.getMplsOam(),
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
