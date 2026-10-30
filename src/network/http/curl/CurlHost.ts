import type { TcpStack } from '@/network/tcp/TcpStack';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { bytesToBinaryString, fileTextToBytes } from '@/crypto/encoding';

export interface CurlHost {
  resolveHostname(name: string): Promise<string | null>;
  tcpStack(): TcpStack;
  interfaceAddress(name: string): string | null;
  ownsAddress(address: string): boolean;
  trustAnchors(): readonly X509Certificate[];
  readFile(path: string): string | null;
  writeFile(target: string, content: string): boolean;
  readonly signal?: AbortSignal;
}

export function withBinaryUploads(host: CurlHost): CurlHost {
  return Object.create(host, {
    readFile: {
      value: (path: string): string | null => {
        const text = host.readFile(path);
        return text === null ? null : bytesToBinaryString(fileTextToBytes(text));
      },
    },
  }) as CurlHost;
}
