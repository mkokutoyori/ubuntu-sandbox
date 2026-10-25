import { IPAddress } from '@/network/core/types';
import type { CurlHost } from '@/network/http/curl/CurlHost';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { LinuxNetKernel } from '../../LinuxNetKernel';

export interface LinuxCurlHostParts {
  readonly net: LinuxNetKernel;
  readonly trustAnchors: () => readonly X509Certificate[];
  readFile(path: string): string | null;
  writeFile(target: string, content: string): boolean;
  readonly signal?: AbortSignal;
}

export function linuxCurlHost(parts: LinuxCurlHostParts): CurlHost {
  const { net } = parts;
  return {
    ...(parts.signal === undefined ? {} : { signal: parts.signal }),
    async resolveHostname(name: string): Promise<string | null> {
      if (!name.includes(':')) {
        const ip = await net.resolveHostname(name);
        if (ip) return ip.toString();
      }
      const ip6 = await net.resolveHostname6(name);
      return ip6 ? ip6.toString() : null;
    },
    tcpStack: () => net.getTcpStack(),
    interfaceAddress: (name: string): string | null => net.getPorts().get(name)?.getIPAddress()?.toString() ?? null,
    ownsAddress: (address: string): boolean => {
      const ip = IPAddress.tryParse(address);
      return ip !== null && net.isLocalAddress(ip);
    },
    trustAnchors: parts.trustAnchors,
    readFile: (path) => parts.readFile(path),
    writeFile: (target, content) => parts.writeFile(target, content),
  };
}
