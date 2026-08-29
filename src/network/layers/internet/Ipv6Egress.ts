import type { IPv6Address } from '../../core/types';

export interface Ipv6SourcePort {
  getLinkLocalIPv6(): IPv6Address | null;
  getGlobalIPv6(): IPv6Address | null;
}

export function selectIpv6SourceAddress(
  port: Ipv6SourcePort, destination: IPv6Address,
): IPv6Address | null {
  return destination.isLinkLocal()
    ? port.getLinkLocalIPv6()
    : (port.getGlobalIPv6() ?? port.getLinkLocalIPv6());
}
