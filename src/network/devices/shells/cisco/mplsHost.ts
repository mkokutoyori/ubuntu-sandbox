import type { Router } from '../../Router';
import type { MplsShellHost } from '@/cli/commands/mpls/mplsFamily';
import { resolveCiscoInterfaceName } from '../cli-utils';

export function mplsHostOf(router: Router, selectedInterfaces: () => string[] = () => []): MplsShellHost {
  return {
    present: () => router.hasMplsEngines(),
    mpls: () => router.getMplsEngine(),
    ldp: () => router.getLdpEngine(),
    selectedInterfaces,
    interfaceNames: () => router.getPortNames(),
    interfaceIsUp: (name) => router.getPort(name)?.getIsUp() === true,
    setRouterIdSource: (iface, force) => router.setLdpRouterIdSource(iface, force),
    resolveInterface: (text) => resolveCiscoInterfaceName(router.getPortNames(), text),
    routerIdSourceText: () => {
      const source = router.getLdpEngine().routerIdSource;
      return source ? `${source.iface}${source.force ? ' force' : ''}` : null;
    },
  };
}
